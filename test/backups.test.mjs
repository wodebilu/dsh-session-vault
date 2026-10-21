// Backups: what a delete copies, and how backups are pruned.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  deleteSession,
  dropAllBackups,
  listBackups,
  restoreBackup,
} from '../lib/relocate-core.mjs'
import { makeLibrary } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `backup-${counter}-`))
}

test('a delete leaves live attachments alone and does not copy them into the backup', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const attachment = join(library.root, 'attachments', 'v1', 'ab', 'shared.bin')
    mkdirSync(join(library.root, 'attachments', 'v1', 'ab'), { recursive: true })
    writeFileSync(attachment, 'x'.repeat(2048))

    const removed = deleteSession({ root: library.root, sessionId: 'session-a', backup: true })

    assert.equal(existsSync(attachment), true, 'the live attachment survives the delete')
    assert.equal(
      existsSync(join(removed.backupDir, 'attachments')),
      false,
      'the backup no longer duplicates the whole attachment store',
    )
    assert.equal(existsSync(join(removed.backupDir, 'backup.json')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a shared attachment is still readable after another session is deleted and its backup dropped', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), {
      sessions: [{ id: 'session-a' }, { id: 'session-b' }],
    })
    const attachment = join(library.root, 'attachments', 'v1', 'cd', 'shared.bin')
    mkdirSync(join(library.root, 'attachments', 'v1', 'cd'), { recursive: true })
    writeFileSync(attachment, 'shared bytes')

    const removed = deleteSession({ root: library.root, sessionId: 'session-a', backup: true })
    dropAllBackups({ root: library.root, keep: 0 })

    assert.equal(existsSync(attachment), true, 'the file both sessions referenced is untouched')
    assert.equal(existsSync(join(library.root, '_deleted', basename(removed.backupDir))), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dropAllBackups keeps the N most recent backups and removes the rest', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), {
      sessions: [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }],
    })
    const first = deleteSession({ root: library.root, sessionId: 'session-a', backup: true })
    // Distinct directory names need distinct millisecond stamps.
    const wait = (ms) => {
      const until = Date.now() + ms
      while (Date.now() < until) {
        // spin
      }
    }
    wait(15)
    deleteSession({ root: library.root, sessionId: 'session-b', backup: true })
    wait(15)
    deleteSession({ root: library.root, sessionId: 'session-c', backup: true })
    assert.equal(listBackups(library.root).length, 3)

    const result = dropAllBackups({ root: library.root, keep: 1 })
    assert.equal(result.remaining, 1)
    assert.equal(result.removed.length, 2)
    assert.equal(listBackups(library.root).length, 1)
    const [kept] = listBackups(library.root)
    assert.equal(
      kept.sessions.some((session) => session.id === 'session-c'),
      true,
      'the newest backup is the one that stays',
    )
    assert.equal(existsSync(first.backupDir), false, 'the oldest backup is gone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dropAllBackups with dryRun reports without deleting', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    deleteSession({ root: library.root, sessionId: 'session-a', backup: true })

    const result = dropAllBackups({ root: library.root, keep: 0, dryRun: true })
    assert.equal(result.removed.length, 1)
    assert.equal(listBackups(library.root).length, 1, 'a dry run deletes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dropAllBackups only ever removes directories inside _deleted', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    deleteSession({ root: library.root, sessionId: 'session-a', backup: true })
    // A stray entry that is not a real backup directory must not be walked out of.
    writeFileSync(join(library.root, '_deleted', 'notes.txt'), 'not a backup')
    const before = readdirSync(join(library.root, '_deleted')).length

    const result = dropAllBackups({ root: library.root, keep: 0 })
    assert.equal(result.removed.every((item) => item.dir.includes('_deleted')), true)
    assert.equal(existsSync(join(library.root, '_deleted', 'notes.txt')), true, 'a plain file is not a backup')
    assert.equal(readdirSync(join(library.root, '_deleted')).length, before - 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a restored session still resolves the attachments that were never copied', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const attachment = join(library.root, 'attachments', 'v1', 'ef', 'file.bin')
    mkdirSync(join(library.root, 'attachments', 'v1', 'ef'), { recursive: true })
    writeFileSync(attachment, 'payload')

    const removed = deleteSession({ root: library.root, sessionId: 'session-a', backup: true })
    const restored = restoreBackup({ root: library.root, backupDir: removed.backupDir })
    assert.deepEqual(restored.restored, ['session-a'])
    assert.equal(existsSync(attachment), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
