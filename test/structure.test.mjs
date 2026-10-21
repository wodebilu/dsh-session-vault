// Structure-level behaviour: the child tree, default-Workspace identity and
// canonical paths. These are the parts a big library actually stresses.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { copyStorage, deleteSession, findChildren, relocate } from '../lib/relocate-core.mjs'
import { createSession, makeLibrary, nowIso, writeIndex } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `structure-${counter}-`))
}

const readIndex = (root) => JSON.parse(readFileSync(join(root, 'storages', 'workspace.json'), 'utf8'))
const rowsFor = (id, cwd, parentSession) => [
  { type: 'session', version: 4, id, createdAt: Date.now(), cwd, ...(parentSession ? { parentSession } : {}) },
  { type: 'user/message', seq: 1, time: Date.now(), data: { content: [{ type: 'text', text: id }] } },
]

test('findChildren returns the whole subtree in one pass, each session once', () => {
  const dir = scratch()
  try {
    const root = join(dir, 'lib')
    mkdirSync(root, { recursive: true })
    const cwd = join(dir, 'project')
    createSession(root, { id: 'session-a', cwd, rows: rowsFor('session-a', cwd) })
    createSession(root, { id: 'session-b', cwd, rows: rowsFor('session-b', cwd, 'session-a') })
    createSession(root, { id: 'session-c', cwd, rows: rowsFor('session-c', cwd, 'session-b') })
    createSession(root, { id: 'session-z', cwd, rows: rowsFor('session-z', cwd) })
    writeIndex(root, { workspaces: {} })

    const children = findChildren(root, 'session-a')
    assert.deepEqual(
      children.map((child) => child.header.id),
      ['session-b', 'session-c'],
    )
    assert.equal(children[1].rows.length, 2, 'grandchild rows are read, not re-resolved')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a migration into the current default reuses the library _default instead of duplicating it', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const index = readIndex(library.root)
    const paths = Object.keys(index.tables.workspaces)
    assert.equal(paths.length, 1)

    // Give the library an existing `_default` and make the other Workspace the default.
    const fallback = randomUUID()
    const fallbackDir = join(library.root, '_default')
    mkdirSync(fallbackDir, { recursive: true })
    index.tables.workspaces[fallback] = {
      path: realpathSync.native(fallbackDir),
      title: 'Default',
      sessionIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    index.global.workspaceIds.push(fallback)
    index.global.defaultWorkspaceId = paths[0]
    writeFileSync(join(library.root, 'storages', 'workspace.json'), JSON.stringify(index))

    const workspacePath = index.tables.workspaces[paths[0]].path
    relocate({
      sourceRoot: library.root,
      sessionId: 'session-a',
      targetRoot: library.root,
      workspace: workspacePath,
      dryRun: false,
    })

    const after = readIndex(library.root)
    const withFallbackPath = Object.values(after.tables.workspaces).filter(
      (workspace) => workspace.path.toLowerCase() === realpathSync.native(fallbackDir).toLowerCase(),
    )
    assert.equal(withFallbackPath.length, 1, 'exactly one Workspace points at _default')
    assert.equal(after.global.defaultWorkspaceId, fallback, 'the existing _default became the default')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workspace paths are stored in the canonical form DSH itself stamps', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const targetRoot = join(dir, 'target')
    mkdirSync(targetRoot, { recursive: true })
    // A path with a `..` segment must not survive into the index.
    const awkward = join(dir, 'inner', '..', 'target')

    copyStorage({
      sourceRoot: library.root,
      targetRoot: awkward,
      sessionId: 'session-a',
      dryRun: false,
    })

    const index = readIndex(resolve(targetRoot))
    const paths = Object.values(index.tables.workspaces).map((workspace) => workspace.path)
    assert.equal(paths.every((path) => !path.includes('..')), true, 'no relative segments survive')
    const expected = realpathSync.native(resolve(library.root, 'project'))
    assert.equal(paths.includes(expected), true, 'the stored path is the realpath')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a delete removes the emptied session directory but leaves one holding other files', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), {
      sessions: [{ id: 'session-a' }, { id: 'session-b' }],
    })

    const sessionA = join(library.root, 'sessions', '-fixture-', 'session-a')
    const sessionB = join(library.root, 'sessions', '-fixture-', 'session-b')
    writeFileSync(join(sessionB, 'extra.txt'), 'kept')

    deleteSession({ root: library.root, sessionId: 'session-a', backup: true })
    deleteSession({ root: library.root, sessionId: 'session-b', backup: true })

    assert.equal(existsSync(sessionA), false, 'an empty session directory is cleaned up')
    assert.equal(existsSync(sessionB), true, 'a directory with other artifacts stays')
    assert.equal(existsSync(join(sessionB, 'extra.txt')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
