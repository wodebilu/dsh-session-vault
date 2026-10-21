// The client half cannot be mounted in a headless test, but its two most
// likely runtime failures can: a key that exists in one language only, and a
// `T.something` reference that does not exist at all. Both render as blank
// labels instead of throwing, which is exactly the kind of bug that survives a
// manual smoke test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8')

/** Keys of the `ZH = { ... }` and `EN = { ... }` object literals. */
function localeKeys(name) {
  const start = source.indexOf(`const ${name} = {`)
  assert.notEqual(start, -1, `${name} table not found`)
  const end = source.indexOf('\n    }', start)
  assert.notEqual(end, -1, `${name} table is not closed the expected way`)
  const body = source.slice(start, end)
  const keys = new Set()
  for (const line of body.split('\n')) {
    // Keys sit at one indentation level inside the literal.
    const match = /^\s{6}([A-Za-z][A-Za-z0-9]*):/.exec(line)
    if (match !== null) keys.add(match[1])
  }
  return keys
}

const ZH = localeKeys('ZH')
const EN = localeKeys('EN')

test('both languages define the same set of labels', () => {
  assert.equal(ZH.size > 50, true, 'sanity: the tables were parsed')
  const onlyZh = [...ZH].filter((key) => !EN.has(key))
  const onlyEn = [...EN].filter((key) => !ZH.has(key))
  assert.deepEqual(onlyZh, [], 'labels missing from EN')
  assert.deepEqual(onlyEn, [], 'labels missing from ZH')
})

test('every T.<key> the panel uses exists in both languages', () => {
  const used = new Set()
  for (const match of source.matchAll(/\bT\.([A-Za-z][A-Za-z0-9]*)/g)) used.add(match[1])
  assert.equal(used.size > 40, true, 'sanity: usages were found')

  const unknown = [...used].filter((key) => !ZH.has(key) || !EN.has(key))
  assert.deepEqual(unknown, [], 'T.* keys with no label')
})

test('the labels the panel gained for the library work are present in both languages', () => {
  for (const key of [
    'cleanupLogs',
    'cleanupConfirm',
    'cleanupDoneTitle',
    'backupPrune',
    'backupKeepLabel',
    'backupPrunedTitle',
    'lockHeld',
    'lockHeldHelp',
  ]) {
    assert.equal(ZH.has(key), true, `${key} missing from ZH`)
    assert.equal(EN.has(key), true, `${key} missing from EN`)
  }
})

test('the plugin carries no transcript-export labels', () => {
  for (const key of ZH) {
    assert.equal(/^export/i.test(key), false, `unexpected export label: ${key}`)
  }
})
