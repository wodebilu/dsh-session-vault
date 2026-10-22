// The three `!!js` guard expressions are generated from one decision, so the
// roots cannot drift apart. These tests prove the checked-in file is that
// generated output, and that the three roots really share the predicate.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { buildGuardExpressions, renderPatch } from '../tools/write-guards.mjs'

const PATCH_FILE = join(import.meta.dirname, '..', 'cordis.patch.yml')

test('the committed patch is exactly what the generator produces', () => {
  const current = readFileSync(PATCH_FILE, 'utf8')
  const expected = renderPatch(current, buildGuardExpressions())
  assert.equal(
    current,
    expected,
    'cordis.patch.yml is stale: run `node tools/write-guards.mjs` and commit the result',
  )
})

test('all three roots consult the same usability predicate', () => {
  const guards = buildGuardExpressions()
  // The predicate is the only thing that decides "vault or local default", and
  // the roots it resolves are computed once inside it. A root that invented its
  // own copy is precisely the bug this generator removes.
  for (const [name, source] of Object.entries(guards)) {
    assert.ok(source.includes('const usable = (r) =>'), `${name}: shares the usable() predicate`)
    assert.ok(source.includes("sessions: lib ? p.join(lib, 'sessions')"), `${name}: shares the sessions root`)
    assert.ok(source.includes("storages: lib ? p.join(lib, 'storages')"), `${name}: shares the storages root`)
    assert.ok(source.includes('attachments: lib ? lib : home'), `${name}: shares the attachments root`)
  }
  // The two read-only roots must be byte-identical through their decision block:
  // they differ only in the `return d.<root>` line.
  const decisionOf = (source) => {
    const start = source.indexOf(' const d = ')
    const end = source.lastIndexOf(' return d.')
    assert.ok(start >= 0 && end > start, 'expression carries an explicit decision block')
    return source.slice(start, end)
  }
  assert.equal(decisionOf(guards.storages), decisionOf(guards.attachments), 'the read-only roots share one decision')
  // The sessions root adds a seeding branch (it runs first and may prepare the
  // library), so it is not byte-identical — but it must still consult the very
  // same `usable` predicate, so it cannot declare the vault usable on its own.
  const usableOf = (source) => {
    const start = source.indexOf(' const usable = (r) => {')
    const end = source.indexOf(' };', start)
    assert.ok(start >= 0 && end > start, 'expression declares the usable predicate')
    return source.slice(start, end)
  }
  assert.equal(usableOf(guards.sessions), usableOf(guards.storages), 'sessions and storages agree on usability')
})

test('only the sessions root creates and seeds a library', () => {
  const guards = buildGuardExpressions()
  assert.ok(guards.sessions.includes('const prepare ='), 'sessions may seed')
  assert.ok(!guards.storages.includes('const prepare ='), 'storages must not seed')
  assert.ok(!guards.attachments.includes('const prepare ='), 'attachments must not seed')
})

test('the three roots agree end to end on a seeded library', () => {
  const guards = buildGuardExpressions()
  const evaluate = (source) => new Function('process', `return (${source})`)(process)
  const TEMP = join(import.meta.dirname, '.tmp')
  mkdirSync(TEMP, { recursive: true })
  const dir = mkdtempSync(join(TEMP, 'genshare-'))
  const home = join(dir, 'home')
  const library = join(dir, 'vault')
  mkdirSync(home, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    writeFileSync(join(home, 'session-vault.json'), JSON.stringify({ mode: 'custom', path: library }))
    // Sessions runs first in the Loader and seeds an empty folder.
    const sessions = evaluate(guards.sessions)
    const storages = evaluate(guards.storages)
    const attachments = evaluate(guards.attachments)
    assert.equal(sessions, join(library, 'sessions'))
    assert.equal(storages, join(library, 'storages'), 'storages must follow the same library')
    assert.equal(attachments, library, 'attachments must follow the same library')
    // And the seeded index is one DSH can actually open.
    const index = JSON.parse(readFileSync(join(library, 'storages', 'workspace.json'), 'utf8'))
    assert.equal(index.unit.version, 2)
    assert.ok(Array.isArray(index.global.workspaceIds) && index.global.workspaceIds.length >= 1)
    assert.ok(index.tables.workspaces[index.global.workspaceIds[0]] !== undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a half-initialized library makes every root fall back together', () => {
  const guards = buildGuardExpressions()
  const evaluate = (source) => new Function('process', `return (${source})`)(process)
  const TEMP = join(import.meta.dirname, '.tmp')
  mkdirSync(TEMP, { recursive: true })
  const dir = mkdtempSync(join(TEMP, 'genshare-'))
  const home = join(dir, 'home')
  const library = join(dir, 'vault')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(library, 'sessions'), { recursive: true })
  mkdirSync(join(library, 'storages'), { recursive: true })
  // An index whose Workspaces table exists but lists nothing usable.
  writeFileSync(
    join(library, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { workspaceIds: [], defaultWorkspaceId: null },
      tables: { workspaces: {} },
    }),
  )
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    writeFileSync(join(home, 'session-vault.json'), JSON.stringify({ mode: 'custom', path: library }))
    const sessions = evaluate(guards.sessions)
    const storages = evaluate(guards.storages)
    const attachments = evaluate(guards.attachments)
    // An empty index is seedable, so sessions prepares it and all three agree.
    assert.equal(sessions, join(library, 'sessions'))
    assert.equal(storages, join(library, 'storages'))
    assert.equal(attachments, library)

    // Now a library that cannot be seeded at all: every root must go local,
    // so sessions never lives in the vault while storages lives in the home.
    rmSync(join(library, 'storages'), { recursive: true, force: true })
    writeFileSync(join(library, 'storages'), 'not a directory')
    const sessionsLocal = evaluate(guards.sessions)
    const storagesLocal = evaluate(guards.storages)
    const attachmentsLocal = evaluate(guards.attachments)
    assert.equal(sessionsLocal, join(home, 'sessions'))
    assert.equal(storagesLocal, join(home, 'storages'))
    assert.equal(attachmentsLocal, home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale patch is detected', () => {
  const current = readFileSync(PATCH_FILE, 'utf8')
  const tampered = current.replace(/!!js "(.*)"\s*$/m, '!!js "(() => 1)()"')
  assert.notEqual(tampered, current, 'the fixture really changed the file')
  assert.notEqual(
    renderPatch(tampered, buildGuardExpressions()),
    tampered,
    'the generator must restore a hand-edited expression',
  )
})
