// Library-level behaviours: diagnosis, index repair, orphan adoption, and the
// format gate that stops an upgraded DSH from being written by an old plugin.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  adoptOrphans,
  capability,
  inspectLibrary,
  repairLibrary,
} from '../index.js'
import { createSession, makeLibrary, nowIso, writeIndex } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `library-${counter}-`))
}
const readIndex = (root) => JSON.parse(readFileSync(join(root, 'storages', 'workspace.json'), 'utf8'))

test('a healthy library diagnoses as ok and needs no repair', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const inspected = inspectLibrary(library.root)
    assert.equal(inspected.ok, true)
    assert.equal(inspected.needsRepair, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an index with no usable workspace is reported and then repaired', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const file = join(library.root, 'storages', 'workspace.json')
    const index = JSON.parse(readFileSync(file, 'utf8'))
    index.global.workspaceIds = []
    writeFileSync(file, JSON.stringify(index))

    const broken = inspectLibrary(library.root)
    assert.equal(broken.ok, false)
    assert.equal(broken.reason, 'index-unlisted')

    const repaired = repairLibrary(library.root)
    assert.equal(repaired.addedToList >= 1, true)
    const healthy = inspectLibrary(library.root)
    assert.equal(healthy.ok, true)
    assert.equal(healthy.needsRepair, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two workspaces on one folder are merged, sessions preserved', () => {
  const dir = scratch()
  try {
    const root = join(dir, 'lib')
    mkdirSync(root, { recursive: true })
    const session = createSession(root, { id: 'session-a' })
    const first = randomUUID()
    const second = randomUUID()
    const record = (sessionIds) => ({
      path: session.cwd,
      title: 'Dup',
      sessionIds,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    writeIndex(root, {
      workspaces: { [first]: record(['session-a']), [second]: record([]) },
      defaultWorkspaceId: second,
    })

    assert.equal(inspectLibrary(root).needsRepair, true)
    const repaired = repairLibrary(root)
    assert.equal(repaired.merged, 1)
    const index = readIndex(root)
    const ids = Object.keys(index.tables.workspaces)
    assert.equal(ids.length, 1)
    assert.deepEqual(index.tables.workspaces[ids[0]].sessionIds, ['session-a'])
    assert.equal(index.global.defaultWorkspaceId, ids[0], 'the default is remapped, not dangling')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session log no workspace owns is adopted by the workspace matching its cwd', () => {
  const dir = scratch()
  try {
    const root = join(dir, 'lib')
    mkdirSync(root, { recursive: true })
    const session = createSession(root, { id: 'session-orphan' })
    writeIndex(root, { workspaces: {} })

    const adopted = adoptOrphans(root)
    assert.equal(adopted.adopted, 1)
    const index = readIndex(root)
    const workspaces = Object.values(index.tables.workspaces)
    assert.equal(workspaces.length, 1)
    assert.deepEqual(workspaces[0].sessionIds, ['session-orphan'])
    assert.equal(existsSync(session.log), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the format gate passes a library this build understands', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const report = capability(library.root)
    assert.equal(report.ok, true)
    assert.deepEqual(report.blocking, [])
    assert.deepEqual(report.logGenerations, [4])
    assert.equal(report.unitVersion, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the format gate blocks a newer workspace index', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), {
      sessions: [{ id: 'session-a' }],
      unitVersion: 3,
    })
    const report = capability(library.root)
    assert.equal(report.ok, false)
    assert.equal(report.blocking.length, 1)
    assert.match(report.blocking[0], /工作区索引版本 3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the format gate blocks a newer session log generation', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), {
      sessions: [{ id: 'session-a', logVersion: 5 }],
    })
    const report = capability(library.root)
    assert.equal(report.ok, false)
    assert.match(report.blocking[0], /会话日志 v5/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
