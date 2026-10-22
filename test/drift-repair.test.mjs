import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { applyRepairPlan, autoRepairVault, buildRepairPlan, readSessionHeader } from '../lib/drift-repair.mjs'
import { decodeZstdRows, splitZstdFrames } from '../lib/zstd-frames.mjs'

/**
 * Build a throwaway vault whose records still name the drive `F:` while the
 * vault itself sits on whatever drive the temp directory is on.
 */
function makeVault() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-drift-'))
  const vault = join(base, 'vault')
  const group = '--F-proj--'
  const session = 'session-test-0001'
  const dir = join(vault, 'sessions', group, session)
  mkdirSync(join(vault, 'storages'), { recursive: true })
  mkdirSync(dir, { recursive: true })

  const header = { type: 'header', version: 4, id: session, cwd: 'F:\\proj', createdAt: '2026-10-21T00:00:00.000Z' }
  const event = { type: 'event', seq: 1, name: 'turn/start' }
  const frame = (value) => zstdCompressSync(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))
  const log = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(log, Buffer.concat([frame(header), frame(event)]))

  writeFileSync(
    join(vault, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { workspaceIds: ['w1'] },
        tables: { workspaces: { w1: { path: 'F:\\proj', title: 'proj', sessionIds: [session] } } },
      },
      null,
      2,
    ),
  )
  return { base, vault, log, group, session }
}

/** Pretend the folder exists on the drive the vault is on. */
function fakeExists(vault) {
  const letter = process.env.SystemDrive?.[0]?.toUpperCase() ?? 'C'
  return (path) => {
    if (path === join(vault, 'storages', 'workspace.json')) return true
    return path.toUpperCase() === `${letter}:\\PROJ`
  }
}

describe('buildRepairPlan', () => {
  it('plans the index, the group rename and the header together', () => {
    const fixture = makeVault()
    try {
      const letter = process.env.SystemDrive?.[0]?.toUpperCase() ?? 'C'
      const drives = [`${letter}:`]
      const plan = buildRepairPlan({ vaultRoot: fixture.vault, drives, pathExists: fakeExists(fixture.vault) })
      assert.equal(plan.ok, false)
      assert.equal(plan.remaps.length, 1)
      assert.equal(plan.remaps[0].to, `${letter}:\\proj`)
      assert.equal(plan.groupRenames.length, 1)
      assert.equal(plan.groupRenames[0].to, `--${letter}-proj--`)
      assert.equal(plan.headerRewrites.length, 1)
      assert.equal(plan.headerRewrites[0].to, `${letter}:\\proj`)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  it('remaps to the vault drive and warns when the folder is absent', () => {
    const fixture = makeVault()
    try {
      const letter = process.env.SystemDrive?.[0]?.toUpperCase() ?? 'C'
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: ['Z:'],
        pathExists: () => false,
      })
      assert.equal(plan.remaps.length, 1)
      assert.equal(plan.remaps[0].to, `${letter}:\\proj`)
      assert.equal(plan.headerRewrites.length, 1)
      assert.ok(plan.warnings.length >= 1)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })
})

describe('autoRepairVault', () => {
  it('repairs without being asked and reports what it did', () => {
    const fixture = makeVault()
    try {
      const letter = process.env.SystemDrive?.[0]?.toUpperCase() ?? 'C'
      const result = autoRepairVault({ vaultRoot: fixture.vault, drives: [`${letter}:`] })
      assert.equal(result.ok, true)
      assert.ok(result.changes > 0)
      const again = autoRepairVault({ vaultRoot: fixture.vault, drives: [`${letter}:`] })
      assert.equal(again.changes, 0)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  it('never throws when the library is not there', () => {
    const result = autoRepairVault({ vaultRoot: 'C:\\does\\not\\exist\\vault', drives: ['C:'] })
    assert.equal(result.ok, false)
    assert.equal(result.changes, 0)
  })
})

describe('applyRepairPlan', () => {
  it('writes all three places, keeps the event frame, and backs up', () => {
    const fixture = makeVault()
    try {
      const letter = process.env.SystemDrive?.[0]?.toUpperCase() ?? 'C'
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [`${letter}:`],
        pathExists: fakeExists(fixture.vault),
      })
      const result = applyRepairPlan(plan, { stamp: 'test-stamp' })
      assert.equal(result.ok, true)
      assert.ok(result.changes > 0)

      // 1. index path
      const index = JSON.parse(readFileSync(join(fixture.vault, 'storages', 'workspace.json'), 'utf8'))
      assert.equal(index.tables.workspaces.w1.path, `${letter}:\\proj`)

      // 2. group directory renamed
      const groups = readdirSync(join(fixture.vault, 'sessions'))
      assert.deepEqual(groups, [`--${letter}-proj--`])

      // 3. header cwd rewritten, event frame intact
      const log = join(fixture.vault, 'sessions', `--${letter}-proj--`, fixture.session, 'session.v4.jsonl.zstd')
      const header = readSessionHeader(log)
      assert.equal(header.header.cwd, `${letter}:\\proj`)
      // The whole point: rewriting the header must not drop the history behind it.
      assert.equal(splitZstdFrames(header.buffer).length, 2)
      assert.equal(decodeZstdRows(header.buffer).length, 2)

      // 4. backup exists with the original index and log
      const backup = join(fixture.vault, '_drift-backup', 'test-stamp')
      assert.equal(readdirSync(backup).includes('workspace.json'), true)
      const original = readFileSync(join(backup, 'workspace.json'), 'utf8')
      assert.match(original, /F:\\\\proj/)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  it('leaves everything untouched when there is nothing to fix', () => {
    const fixture = makeVault()
    try {
      const letter = process.env.SystemDrive?.[0]?.toUpperCase() ?? 'C'
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [`${letter}:`],
        pathExists: fakeExists(fixture.vault),
      })
      applyRepairPlan(plan, { stamp: 's1' })
      const second = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [`${letter}:`],
        pathExists: fakeExists(fixture.vault),
      })
      assert.equal(second.ok, true)
      const result = applyRepairPlan(second, { stamp: 's2' })
      assert.equal(result.changes, 0)
      assert.equal(result.backup, undefined)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })
})
