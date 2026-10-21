// The Loader guard: the three `!!js` expressions in `cordis.patch.yml` decide
// where DSH's roots point before any Workspace or Session exists. This is the
// last line of defence against the 1.0 deadlock, so it is tested against the
// real, shipped expressions rather than a re-implementation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const PATCH = readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')

/** The three expressions, in file order: sessions root, storage root, attachments home. */
const EXPRESSIONS = [...PATCH.matchAll(/!!js "(.*)"\s*$/gm)].map((match) => match[1])

test('the patch still carries three executable expressions', () => {
  assert.equal(EXPRESSIONS.length, 3)
  for (const source of EXPRESSIONS) {
    assert.equal(source.includes('process.getBuiltinModule'), true)
  }
})

const evaluate = (expression) => new Function('process', `return (${expression})`)(process)
const sessionsRoot = () => evaluate(EXPRESSIONS[0])
const storageRoot = () => evaluate(EXPRESSIONS[1])
const attachmentsHome = () => evaluate(EXPRESSIONS[2])

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0

/**
 * A throwaway harness home plus an optional library, with DSH_HOME pointed at
 * it for the duration of `run`.
 */
function withEnvironment(run) {
  counter += 1
  const dir = mkdtempSync(join(TEMP, `guard-${counter}-`))
  const home = join(dir, 'home')
  const previous = process.env.DSH_HOME
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const record = (value) => writeFileSync(join(home, 'session-vault.json'), JSON.stringify(value))
  try {
    return run({ dir, home, record })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A library DSH would consider usable: three roots and one listed Workspace. */
function makeUsableLibrary(root) {
  const id = randomUUID()
  const workspacePath = join(root, 'workspace')
  mkdirSync(join(root, 'sessions'), { recursive: true })
  mkdirSync(join(root, 'storages'), { recursive: true })
  mkdirSync(join(root, 'attachments', 'v1'), { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  writeFileSync(
    join(root, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: [id],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        defaultWorkspaceId: id,
      },
      tables: {
        workspaces: {
          [id]: {
            path: workspacePath,
            title: 'Guard',
            sessionIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      },
    }),
  )
  return root
}

const same = (actual, expected, message) =>
  assert.equal(resolve(actual), resolve(expected), message)

test('with no mode record every root stays local', () => {
  withEnvironment(({ home }) => {
    same(sessionsRoot(), join(home, 'sessions'), 'sessions root')
    same(storageRoot(), join(home, 'storages'), 'storage root')
    same(attachmentsHome(), home, 'attachments home')
  })
})

test('a custom record with a usable library moves all three roots', () => {
  withEnvironment(({ dir, home, record }) => {
    const library = makeUsableLibrary(join(dir, 'vault'))
    record({ mode: 'custom', path: library })

    same(sessionsRoot(), join(library, 'sessions'))
    same(storageRoot(), join(library, 'storages'))
    same(attachmentsHome(), library)
    assert.equal(existsSync(join(home, 'session-vault-boot.log')), true, 'the decision is traced')
  })
})

test('a custom path that does not exist yet is created and seeded', () => {
  withEnvironment(({ dir, record }) => {
    const library = join(dir, 'new folder')
    record({ mode: 'custom', path: library })

    same(sessionsRoot(), join(library, 'sessions'), 'the folder is prepared, not refused')
    assert.equal(existsSync(join(library, 'storages', 'workspace.json')), true)
    same(storageRoot(), join(library, 'storages'))
    same(attachmentsHome(), library)
  })
})

test('a custom path that cannot be a directory falls back to local', () => {
  withEnvironment(({ dir, home, record }) => {
    // A plain file where a folder is expected: it exists, but cannot be used.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a folder')
    record({ mode: 'custom', path: blocker })

    same(sessionsRoot(), join(home, 'sessions'))
    same(storageRoot(), join(home, 'storages'))
    same(attachmentsHome(), home)
  })
})

test('the panic marker overrides a perfectly usable custom library', () => {
  withEnvironment(({ dir, home, record }) => {
    const library = makeUsableLibrary(join(dir, 'vault'))
    record({ mode: 'custom', path: library })
    writeFileSync(join(home, 'session-vault.panic'), '')

    same(sessionsRoot(), join(home, 'sessions'))
    same(storageRoot(), join(home, 'storages'))
    same(attachmentsHome(), home)
  })
})

test('an empty library is seeded on first boot instead of falling back', () => {
  withEnvironment(({ dir, record }) => {
    const library = join(dir, 'vault')
    mkdirSync(join(library, 'sessions'), { recursive: true })
    mkdirSync(join(library, 'storages'), { recursive: true })
    record({ mode: 'custom', path: library })

    // The sessions expression is the one that may seed; it runs first.
    same(sessionsRoot(), join(library, 'sessions'), 'a seedable folder is used, not refused')
    const index = JSON.parse(readFileSync(join(library, 'storages', 'workspace.json'), 'utf8'))
    assert.equal(index.global.workspaceIds.length >= 1, true, 'a Workspace was written')
    assert.equal(index.unit.version, 2)

    // The other two expressions re-read the index it just wrote.
    same(storageRoot(), join(library, 'storages'))
    same(attachmentsHome(), library)
  })
})

test('a custom record without a path is ignored', () => {
  withEnvironment(({ home, record }) => {
    record({ mode: 'custom' })
    same(sessionsRoot(), join(home, 'sessions'))
  })
})
