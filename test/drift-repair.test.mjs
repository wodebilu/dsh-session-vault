import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { applyRepairPlan, autoRepairVault, buildRepairPlan, readSessionHeader } from '../lib/drift-repair.mjs'
import { decodeZstdRows, splitZstdFrames } from '../lib/zstd-frames.mjs'

/**
 * Build a throwaway vault whose records name a drive that is no longer there.
 *
 * `carried: true` (default) is the only case a repair may rewrite: the records
 * name an old letter (`recorded`), and that same folder now exists on the
 * vault's own volume under the vault's letter. That mirrored folder existing is
 * the proof the plugin requires — `fakeExists()` supplies it.
 *
 * `carried: false` is the cross-volume case: a workspace that lived on a
 * genuinely different, absent drive, with no mirrored folder anywhere. It must
 * never be rewritten.
 */
function makeVault({ carried = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-drift-'))
  const vault = join(base, 'vault')
  const letter = process.env.SystemDrive?.[0]?.toUpperCase() ?? 'C'
  // The old spelling recorded in the vault: always a different letter from the
  // vault's own, so a repair has a letter to substitute.
  const recorded = letter === 'G' ? 'H' : 'G'
  const oldPath = `${recorded}:\\proj`
  const group = `--${recorded}-proj--`
  const session = 'session-test-0001'
  const dir = join(vault, 'sessions', group, session)
  mkdirSync(join(vault, 'storages'), { recursive: true })
  mkdirSync(dir, { recursive: true })

  const header = { type: 'header', version: 4, id: session, cwd: oldPath, createdAt: '2026-10-21T00:00:00.000Z' }
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
        tables: { workspaces: { w1: { path: oldPath, title: 'proj', sessionIds: [session] } } },
      },
      null,
      2,
    ),
  )
  return { base, vault, log, group, session, letter, recorded, carried }
}

/** Pretend the mirrored folder exists at the vault letter's `\proj`. */
function fakeExists() {
  const letter = process.env.SystemDrive?.[0]?.toUpperCase() ?? 'C'
  return (path) => path.toUpperCase() === `${letter}:\\PROJ`
}

describe('buildRepairPlan', () => {
  it('plans the index, the group rename and the header together', () => {
    const fixture = makeVault()
    try {
      // The recorded letter is absent (the carried-vault case); the vault's own
      // letter is where the folder now is. A rewrite is exactly right.
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [],
        pathExists: fakeExists(),
      })
      assert.equal(plan.ok, false)
      assert.equal(plan.repairable, false)
      assert.equal(plan.remaps.length, 1)
      assert.equal(plan.remaps[0].from, `${fixture.recorded}:\\proj`)
      assert.equal(plan.remaps[0].to, `${fixture.letter}:\\proj`)
      // The group moves with the sessions it holds: a directory left on the old
      // letter while the header cwd moves is the one state DSH cannot reconcile.
      assert.equal(plan.groupRenames.length, 1)
      assert.equal(plan.groupRenames[0].from, fixture.group)
      assert.equal(plan.groupRenames[0].to, `--${fixture.letter}-proj--`)
      assert.equal(plan.headerRewrites.length, 1)
      assert.equal(plan.headerRewrites[0].to, `${fixture.letter}:\\proj`)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  it('re-points a workspace from an absent drive at the vault drive', () => {
    // The core portability case: the records name a drive that is gone, and the
    // folder does not exist yet on the vault's volume. The letter is substituted
    // anyway, because that is exactly what carrying a USB stick between machines
    // produces; DSH creates the project folder on first use. The plan warns that
    // the folder is new so the user is not surprised.
    const fixture = makeVault({ carried: false })
    try {
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [`${fixture.letter}:`],
        pathExists: () => false,
      })
      assert.equal(plan.repairable, false, 'the letter is rewritten')
      assert.equal(plan.remaps.length, 1)
      assert.equal(plan.remaps[0].to, `${fixture.letter}:\\proj`)
      assert.equal(plan.headerRewrites.length, 1)
      assert.equal(plan.headerRewrites[0].to, `${fixture.letter}:\\proj`)
      assert.equal(plan.groupRenames.length, 1)
      assert.equal(plan.groupRenames[0].to, `--${fixture.letter}-proj--`)
      // The folder does not exist yet, so the user is warned to confirm it.
      assert.ok(plan.warnings.some((line) => line.includes(`${fixture.letter}:\\proj`)))
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  it('never promises that DSH will create the project folder', () => {
    // The rewrite is allowed, but no warning may suggest the folder appearing is
    // a convenience — the user is told to confirm the project is really there.
    const fixture = makeVault({ carried: false })
    try {
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [`${fixture.letter}:`],
        pathExists: () => false,
      })
      assert.equal(plan.remaps.length, 1)
      assert.ok(plan.warnings.some((line) => /不存在/.test(line)))
      assert.ok(
        !plan.warnings.some((line) => /按需创建|会按需/.test(line)),
        'creating an empty project folder is the bug, not a convenience',
      )
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  it('reports a missing folder on a mounted drive without rewriting it', () => {
    // The recorded letter is mounted and correct, yet the folder is gone: the
    // project did not travel with the vault, so no substitution applies. The
    // vault has no drift to repair, and the workspace is reported for /cd.
    const fixture = makeVault()
    try {
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [`${fixture.recorded}:`, `${fixture.letter}:`],
        pathExists: () => false,
      })
      assert.equal(plan.repairable, true, 'nothing to rewrite')
      assert.ok(plan.blocked.some((entry) => entry.kind === 'folder-missing'))
      assert.ok(plan.warnings.some((line) => /\/cd|换单位/.test(line)))
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })
})

describe('autoRepairVault', () => {
  it('repairs without being asked and reports what it did', () => {
    const fixture = makeVault()
    try {
      // The recorded letter names the vault's own drive, and that drive is not
      // mounted on this simulated machine: the carried-vault spelling. The
      // repair is silent (no dialog) and reports what it changed.
      const result = autoRepairVault({
        vaultRoot: fixture.vault,
        drives: [],
        pathExists: fakeExists(),
      })
      assert.ok(result.changes > 0, `expected a rewrite, got ${JSON.stringify(result)}`)
      // Once repaired, the index names the folder as it exists now, so a second
      // pass finds nothing left to rewrite.
      const again = autoRepairVault({
        vaultRoot: fixture.vault,
        drives: [],
        pathExists: () => true,
      })
      assert.equal(again.changes, 0)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  it('repairs a workspace that names an absent drive', () => {
    // autoRepairVault is the explicit "do the write" entry point. A record on a
    // drive that is gone is the carried-vault case, so it rewrites.
    const fixture = makeVault({ carried: false })
    try {
      const result = autoRepairVault({ vaultRoot: fixture.vault, drives: [`${fixture.letter}:`] })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.ok(result.changes > 0)
      const index = JSON.parse(readFileSync(join(fixture.vault, 'storages', 'workspace.json'), 'utf8'))
      assert.equal(index.tables.workspaces.w1.path, `${fixture.letter}:\\proj`)
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
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [],
        pathExists: fakeExists(),
      })
      const result = applyRepairPlan(plan, { stamp: 'test-stamp' })
      assert.equal(result.ok, true)
      assert.ok(result.changes > 0)

      // 1. index path
      const index = JSON.parse(readFileSync(join(fixture.vault, 'storages', 'workspace.json'), 'utf8'))
      assert.equal(index.tables.workspaces.w1.path, `${fixture.letter}:\\proj`)

      // 2. the group directory is renamed together with the cwd it holds
      const groups = readdirSync(join(fixture.vault, 'sessions'))
      assert.deepEqual(groups, [`--${fixture.letter}-proj--`])

      // 3. header cwd rewritten, event frame intact
      const log = join(fixture.vault, 'sessions', `--${fixture.letter}-proj--`, fixture.session, 'session.v4.jsonl.zstd')
      const header = readSessionHeader(log)
      assert.equal(header.header.cwd, `${fixture.letter}:\\proj`)
      // The whole point: rewriting the header must not drop the history behind it.
      assert.equal(splitZstdFrames(header.buffer).length, 2)
      assert.equal(decodeZstdRows(header.buffer).length, 2)

      // 4. backup exists with the original index and log
      const backup = join(fixture.vault, '_drift-backup', 'test-stamp')
      assert.equal(readdirSync(backup).includes('workspace.json'), true)
      const original = readFileSync(join(backup, 'workspace.json'), 'utf8')
      assert.ok(original.includes(`${fixture.recorded}:\\\\proj`))
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  it('leaves everything untouched when there is nothing to fix', () => {
    const fixture = makeVault()
    try {
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [],
        pathExists: fakeExists(),
      })
      applyRepairPlan(plan, { stamp: 's1' })
      // After the repair the index names the vault volume, the drive is
      // mounted and the folder is there: nothing left to rewrite, and no
      // second backup may be written.
      const second = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [`${fixture.letter}:`],
        pathExists: () => true,
      })
      assert.equal(second.ok, true)
      assert.equal(second.repairable, true)
      const result = applyRepairPlan(second, { stamp: 's2' })
      assert.equal(result.changes, 0)
      assert.equal(result.backup, undefined)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  it('rewrites all three places when the workspace named an absent drive', () => {
    const fixture = makeVault({ carried: false })
    try {
      const plan = buildRepairPlan({
        vaultRoot: fixture.vault,
        drives: [`${fixture.letter}:`],
        pathExists: () => false,
      })
      const result = applyRepairPlan(plan, { stamp: 's3' })
      assert.ok(result.changes > 0)
      // The index, the group directory and the header now agree on one letter.
      const index = JSON.parse(readFileSync(join(fixture.vault, 'storages', 'workspace.json'), 'utf8'))
      assert.equal(index.tables.workspaces.w1.path, `${fixture.letter}:\\proj`)
      const groups = readdirSync(join(fixture.vault, 'sessions'))
      assert.deepEqual(groups, [`--${fixture.letter}-proj--`])
      const log = join(fixture.vault, 'sessions', `--${fixture.letter}-proj--`, fixture.session, 'session.v4.jsonl.zstd')
      assert.equal(readSessionHeader(log).header.cwd, `${fixture.letter}:\\proj`)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })
})
