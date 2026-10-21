// deleteSession / backup / restore are the recovery story; they get tests too.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { deleteSession, findSession, listBackups, restoreBackup } from '../lib/relocate-core.mjs'
import { makeLibrary } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `delete-${counter}-`))
}

test('delete backs the session up, and restore brings it back under its own id', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const before = findSession(library.root, 'session-a')

    const removed = deleteSession({ root: library.root, sessionId: 'session-a', backup: true })
    assert.equal(removed.backupDir !== null, true)
    assert.equal(existsSync(before.log), false)
    assert.throws(() => findSession(library.root, 'session-a'), /session not found/)

    const backups = listBackups(library.root)
    assert.equal(backups.length, 1)
    assert.deepEqual(
      backups[0].sessions.map((session) => session.id),
      ['session-a'],
    )

    const restored = restoreBackup({ root: library.root, backupDir: removed.backupDir })
    assert.deepEqual(restored.restored, ['session-a'])
    const after = findSession(library.root, 'session-a')
    assert.ok(existsSync(after.log), 'the log is back')
    assert.ok(existsSync(after.cacheFile), 'the projection cache is back')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restoring a second time never overwrites the live session', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const removed = deleteSession({ root: library.root, sessionId: 'session-a', backup: true })
    restoreBackup({ root: library.root, backupDir: removed.backupDir })

    const second = restoreBackup({ root: library.root, backupDir: removed.backupDir })
    assert.equal(second.restored.length, 1)
    assert.notEqual(second.restored[0], 'session-a', 'a conflict gets a fresh id')
    assert.ok(findSession(library.root, 'session-a'), 'the live session is untouched')
    assert.ok(findSession(library.root, second.restored[0]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete without backup removes the session outright', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const before = findSession(library.root, 'session-a')

    const removed = deleteSession({ root: library.root, sessionId: 'session-a', backup: false })
    assert.equal(removed.backupDir, null)
    assert.equal(existsSync(before.log), false)
    assert.equal(existsSync(join(library.root, '_deleted')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore refuses a backup directory outside this library', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    assert.throws(
      () => restoreBackup({ root: library.root, backupDir: join(dir, 'elsewhere') }),
      /not inside this library/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
