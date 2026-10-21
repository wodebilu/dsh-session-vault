// Regression tests for the destructive core: relocate() and copyStorage().
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { copyStorage, findSession, relocate, sha256 } from '../lib/relocate-core.mjs'
import { decodeZstdRows } from '../lib/zstd-frames.mjs'
import { makeLibrary, workspaceDir } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0

/** A unique scratch directory for one test. */
function scratch() {
  counter += 1
  return mkdtempSync(join(TEMP, `relocate-${counter}-`))
}

/** The digests the Host half captures before a command runs. */
const digests = (session) => ({
  sourceSha: sha256(session.log),
  sourceCacheSha: sha256(session.cacheFile),
})

test('a preview never deletes the source, even with move ticked', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'source'), { sessions: [{ id: 'session-a' }] })
    const source = findSession(library.root, 'session-a')
    const targetRoot = join(dir, 'target')

    const result = relocate({
      sourceRoot: library.root,
      sessionId: 'session-a',
      targetRoot,
      workspace: workspaceDir(dir, 'workspace'),
      move: true,
      backup: true,
      dryRun: true,
      ...digests(source),
    })

    assert.equal(result.dryRun, true)
    assert.equal(result.moved, false, 'a preview must report that nothing moved')
    assert.equal(result.sourceBackup, null)
    assert.ok(existsSync(source.log), 'the source log must survive a preview')
    assert.equal(existsSync(result.targetLog), false, 'a preview must not write the target log')
    assert.equal(existsSync(result.targetCacheFile), false)
    assert.equal(existsSync(join(targetRoot, 'storages', 'workspace.json')), false)
    assert.equal(existsSync(join(library.root, '_deleted')), false, 'no backup may be created')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a real move clones the session, then backs up and removes the source', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'source'), { sessions: [{ id: 'session-a' }] })
    const source = findSession(library.root, 'session-a')

    const result = relocate({
      sourceRoot: library.root,
      sessionId: 'session-a',
      targetRoot: join(dir, 'target'),
      workspace: workspaceDir(dir, 'workspace'),
      move: true,
      backup: true,
      dryRun: false,
      ...digests(source),
    })

    assert.equal(result.moved, true)
    assert.ok(result.sourceBackup, 'the source must be backed up before it is removed')
    assert.equal(existsSync(source.log), false, 'the source log is gone after a real move')
    assert.equal(existsSync(source.cacheFile), false)

    const copied = decodeZstdRows(readFileSync(result.targetLog))
    assert.equal(copied.length, source.rows.length, 'every record was cloned')
    assert.equal(copied[0].id, result.newSessionId, 'the clone carries the new id')
    assert.equal(copied[0].cwd, result.targetWorkspacePath, 'the clone points at the new workspace')

    assert.ok(
      readdirSync(join(result.sourceBackup, 'sessions')).length > 0,
      'the backup holds the removed log',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a source that grew since the digests were taken is never deleted', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'source'), { sessions: [{ id: 'session-a' }] })
    const source = findSession(library.root, 'session-a')
    const captured = digests(source)
    // A live session appends while the command runs.
    appendFileSync(
      source.log,
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session-log/late' })}\n`, 'utf8')),
    )

    assert.throws(
      () =>
        relocate({
          sourceRoot: library.root,
          sessionId: 'session-a',
          targetRoot: join(dir, 'target'),
          workspace: workspaceDir(dir, 'workspace'),
          move: true,
          backup: true,
          dryRun: false,
          ...captured,
        }),
      /source was not deleted/,
    )
    assert.ok(existsSync(source.log), 'the source survives a refused move')
    assert.equal(existsSync(join(library.root, '_deleted')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a projection cache without a record fails with a sentence, not a TypeError', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'source'), {
      sessions: [{ id: 'session-a', cache: {} }],
    })
    const source = findSession(library.root, 'session-a')

    assert.throws(
      () =>
        relocate({
          sourceRoot: library.root,
          sessionId: 'session-a',
          targetRoot: join(dir, 'target'),
          workspace: workspaceDir(dir, 'workspace'),
          dryRun: false,
          ...digests(source),
        }),
      /projection cache for .* has no record/,
    )
    assert.equal(
      existsSync(join(dir, 'target', 'sessions')),
      false,
      'refusal happens before anything is written',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('copy without move leaves the source untouched', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'source'), { sessions: [{ id: 'session-a' }] })
    const source = findSession(library.root, 'session-a')
    const targetRoot = join(dir, 'target')
    mkdirSync(targetRoot, { recursive: true })

    const result = copyStorage({
      sourceRoot: library.root,
      targetRoot,
      sessionId: 'session-a',
      move: false,
      dryRun: false,
      ...digests(source),
    })

    assert.equal(result.moved, false)
    assert.ok(existsSync(source.log), 'the source stays put')
    assert.ok(existsSync(result.targetLog), 'the target receives the log')
    assert.ok(existsSync(result.targetCacheFile), 'the target receives the projection cache')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a long session is cloned record for record', () => {
  const dir = scratch()
  try {
    const rows = [{ type: 'session', version: 4, id: 'session-long', createdAt: Date.now(), cwd: 'F:\\long' }]
    for (let index = 0; index < 3000; index += 1) {
      rows.push({
        type: 'assistant/message',
        seq: index + 1,
        time: Date.now(),
        data: { turn: 1, message: { content: [{ type: 'text', text: `第 ${index} 行` }] } },
      })
    }
    const library = makeLibrary(join(dir, 'source'), {
      sessions: [{ id: 'session-long', rows, cwd: join(dir, 'project') }],
    })
    const source = findSession(library.root, 'session-long')
    assert.equal(source.rows.length, rows.length)

    const result = relocate({
      sourceRoot: library.root,
      sessionId: 'session-long',
      targetRoot: join(dir, 'target'),
      workspace: workspaceDir(dir, 'workspace'),
      dryRun: false,
      ...digests(source),
    })

    const copied = decodeZstdRows(readFileSync(result.targetLog))
    assert.equal(copied.length, rows.length, 'every record survived, no frame was dropped')
    assert.equal(copied[copied.length - 1].data.message.content[0].text, '第 2999 行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('copy refuses to move a source that changed underneath it', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'source'), { sessions: [{ id: 'session-a' }] })
    const source = findSession(library.root, 'session-a')
    const captured = digests(source)
    appendFileSync(
      source.log,
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session-log/late' })}\n`, 'utf8')),
    )

    assert.throws(
      () =>
        copyStorage({
          sourceRoot: library.root,
          targetRoot: join(dir, 'target'),
          sessionId: 'session-a',
          move: true,
          dryRun: false,
          ...captured,
        }),
      /source was not deleted/,
    )
    assert.ok(existsSync(source.log))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
