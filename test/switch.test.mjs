// The switch itself: "use this folder" / "back to local". This is the plugin's
// primary flow, and it writes the mode record, the manifest and the Workspace
// index before DSH is allowed to boot into the folder.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { handleCommand, status, useCustom, useDefault } from '../index.js'
import { createSession } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `switch-${counter}-`))
}

/** Run `fn` with DSH_HOME pointed at a throwaway harness home. */
function withHome(dir, fn) {
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const b64 = (text) => `b64:${Buffer.from(text, 'utf8').toString('base64url')}`

test('switching to an empty folder prepares it before the mode record is written', () => {
  const dir = scratch()
  try {
    withHome(dir, (home) => {
      const target = join(dir, 'vault folder')
      mkdirSync(target, { recursive: true })

      const state = useCustom(target)

      assert.equal(state.mode, 'custom')
      assert.equal(state.usable, true)
      for (const sub of ['sessions', 'storages', 'attachments', join('attachments', 'v1')]) {
        assert.equal(existsSync(join(target, sub)), true, `prepared ${sub}`)
      }
      assert.equal(existsSync(join(target, 'vault.json')), true, 'manifest written')

      const index = readJson(join(target, 'storages', 'workspace.json'))
      assert.equal(index.unit.version, 2)
      assert.equal(index.global.initialized, true)
      assert.equal(index.global.workspaceIds.length >= 1, true, 'at least one Workspace is listed')
      assert.notEqual(index.tables.workspaces[index.global.defaultWorkspaceId], undefined)

      const record = readJson(join(home, 'session-vault.json'))
      assert.equal(record.mode, 'custom')
      assert.equal(record.path, target)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('switching to a folder that already holds session logs adopts them', () => {
  const dir = scratch()
  try {
    withHome(dir, () => {
      const target = join(dir, 'vault')
      mkdirSync(target, { recursive: true })
      // A session log with no Workspace entry, as a hand-copied one would be.
      createSession(target, { id: 'session-orphan' })
      assert.equal(existsSync(join(target, 'storages', 'workspace.json')), false)

      const state = useCustom(target)
      assert.equal(state.usable, true)

      const index = readJson(join(target, 'storages', 'workspace.json'))
      const owned = Object.values(index.tables.workspaces).flatMap((workspace) => workspace.sessionIds)
      assert.equal(owned.includes('session-orphan'), true, 'the orphan is visible after the switch')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('switching to a missing folder is refused and leaves the mode alone', () => {
  const dir = scratch()
  try {
    withHome(dir, (home) => {
      const target = join(dir, 'vault')
      mkdirSync(target, { recursive: true })
      useCustom(target)

      const missing = join(dir, 'nope')
      assert.throws(() => useCustom(missing), /不是已存在的文件夹/)
      assert.equal(status().mode, 'custom', 'the previous mode survives a failed switch')
      assert.equal(readJson(join(home, 'session-vault.json')).path, target)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('back to local default clears the panic marker and keeps the chosen path on record', () => {
  const dir = scratch()
  try {
    withHome(dir, (home) => {
      const target = join(dir, 'vault')
      mkdirSync(target, { recursive: true })
      useCustom(target)
      writeFileSync(join(home, 'session-vault.panic'), '')

      const state = useDefault()
      assert.equal(state.mode, 'default')
      assert.equal(state.panic, false, 'the marker is gone')
      const record = readJson(join(home, 'session-vault.json'))
      assert.equal(record.mode, 'default')
      assert.equal(record.path, target, 'the folder stays remembered for copying')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Chinese folder path survives the command channel', () => {
  const dir = scratch()
  try {
    withHome(dir, () => {
      const target = join(dir, '会话 库')
      mkdirSync(target, { recursive: true })

      const out = handleCommand(`custom ${b64(target)}`)
      assert.equal(out.kind, 'success', out.text)
      const state = JSON.parse(out.text)
      assert.equal(state.mode, 'custom')
      assert.equal(state.requested, target)
      assert.equal(state.usable, true)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
