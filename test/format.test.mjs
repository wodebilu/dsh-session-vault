// Log generations: a copy must keep the generation it found, and a re-home is
// only legal for the generation this module actually authors (v4).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { copyStorage, findSession, relocate } from '../lib/relocate-core.mjs'
import { makeLibrary } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `format-${counter}-`))
}

const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const digests = (session) => ({
  sourceSha: digest(session.log),
  sourceCacheSha: digest(session.cacheFile),
})

test('a v4 session is what re-homing expects', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'source'), { sessions: [{ id: 'session-a', logVersion: 4 }] })
    assert.match(findSession(library.root, 'session-a').log, /session\.v4\.jsonl\.zstd$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('re-homing an older generation is refused instead of writing v4 rows under a v4 name', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'source'), { sessions: [{ id: 'session-a', logVersion: 3 }] })
    const source = findSession(library.root, 'session-a')
    assert.match(source.log, /session\.v3\.jsonl\.zstd$/)

    assert.throws(
      () =>
        relocate({
          sourceRoot: library.root,
          sessionId: 'session-a',
          targetRoot: join(dir, 'target'),
          workspace: join(dir, 'workspace'),
          dryRun: false,
          ...digests(source),
        }),
      /v3 log; this build only re-homes v4 sessions/,
    )
    assert.equal(existsSync(join(dir, 'target', 'sessions')), false, 'nothing was written')
    assert.equal(existsSync(source.log), true, 'the source is untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a copy keeps the generation of the log it copies', () => {
  const dir = scratch()
  try {
    const library = makeLibrary(join(dir, 'source'), { sessions: [{ id: 'session-a', logVersion: 3 }] })
    const source = findSession(library.root, 'session-a')
    const targetRoot = join(dir, 'target')
    mkdirSync(targetRoot, { recursive: true })

    copyStorage({
      sourceRoot: library.root,
      targetRoot,
      sessionId: 'session-a',
      dryRun: false,
      ...digests(source),
    })

    const projects = readdirSync(join(targetRoot, 'sessions'))
    const files = readdirSync(join(targetRoot, 'sessions', projects[0], 'session-a'))
    assert.deepEqual(files, ['session.v3.jsonl.zstd'], 'the copy still claims v3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
