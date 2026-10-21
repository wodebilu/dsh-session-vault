// Command wiring: the panel talks to the host through `/vault <action> <b64>`,
// so the argument decoding, the gates and the new actions are tested end to end.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleCommand, lockFile } from '../index.js'
import { deleteSession } from '../lib/relocate-core.mjs'
import { makeLibrary } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `commands-${counter}-`))
}

const payload = (value) => `b64:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`
const ROWS = [
  { type: 'session', version: 4, id: 'session-a', createdAt: 1792566000000, cwd: 'F:\\demo' },
  { type: 'user/message', seq: 10, time: 1792566093000, data: { content: [{ type: 'text', text: '问题' }] } },
  {
    type: 'assistant/message',
    seq: 21,
    time: 1792566095000,
    data: { turn: 1, message: { content: [{ type: 'text', text: '回答' }] } },
  },
]

/** Point the host half at a throwaway home + library for the duration of a test. */
function withLibrary(run) {
  const dir = scratch()
  const previous = process.env.DSH_HOME
  try {
    const library = makeLibrary(join(dir, 'lib'), {
      sessions: [{ id: 'session-a', rows: ROWS, title: '命令测试' }],
    })
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'session-vault.json'), JSON.stringify({ mode: 'custom', path: library.root }))
    process.env.DSH_HOME = home
    return run({ dir, library, home })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

test('export writes the transcript where it was told to', () => {
  withLibrary(({ dir, library }) => {
    const out = handleCommand(
      `export ${payload({ sessionId: 'session-a', format: 'md', target: join(dir, 'out') })}`,
    )
    assert.equal(out.kind, 'success', out.text)
    const result = JSON.parse(out.text)
    assert.equal(result.messages, 2)
    assert.equal(existsSync(result.path), true)
    assert.equal(result.path.startsWith(library.root), false, 'never inside the library')
  })
})

test('export rejects an unknown format instead of guessing', () => {
  withLibrary(({ dir }) => {
    const out = handleCommand(
      `export ${payload({ sessionId: 'session-a', format: 'pdf', target: join(dir, 'out') })}`,
    )
    assert.equal(out.kind, 'error')
    assert.match(out.text, /md 或 json/)
  })
})

test('drop-backups prunes through the command channel', () => {
  withLibrary(({ library }) => {
    deleteSession({ root: library.root, sessionId: 'session-a', backup: true })
    const out = handleCommand(`drop-backups ${payload({ keep: 0 })}`)
    assert.equal(out.kind, 'success', out.text)
    const result = JSON.parse(out.text)
    assert.equal(result.removed.length, 1)
    assert.equal(result.remaining, 0)
  })
})

test('drop-backups refuses a negative keep', () => {
  withLibrary(() => {
    const out = handleCommand(`drop-backups ${payload({ keep: -1 })}`)
    assert.equal(out.kind, 'error')
    assert.match(out.text, /非负整数/)
  })
})

test('cleanup removes the local logs and keeps the mode record', () => {
  withLibrary(({ home }) => {
    for (const name of ['session-vault-host.log', 'session-vault-boot.log', 'session-vault-fallback.log']) {
      writeFileSync(join(home, name), 'x\n')
    }
    const out = handleCommand('cleanup')
    assert.equal(out.kind, 'success', out.text)
    const result = JSON.parse(out.text)
    assert.equal(result.removed.length, 3)
    assert.equal(existsSync(join(home, 'session-vault-host.log')), false)
    assert.equal(existsSync(join(home, 'session-vault.json')), true)
  })
})

test('a destructive command is refused while another live DSH holds the library', () => {
  withLibrary(({ library }) => {
    writeFileSync(
      lockFile(library.root),
      JSON.stringify({ pid: process.ppid, startedAt: '2026-10-21T00:00:00.000Z', host: 'other-machine' }),
    )
    const out = handleCommand(`delete ${payload({ sessionId: 'session-a', backup: true })}`)
    assert.equal(out.kind, 'error')
    assert.match(out.text, /另一个 DSH 进程/)
    assert.equal(existsSync(join(library.root, 'sessions')), true, 'nothing was deleted')
  })
})

test('check reports the compatibility of the active library', () => {
  withLibrary(() => {
    const out = handleCommand('check')
    assert.equal(out.kind, 'success', out.text)
    const result = JSON.parse(out.text)
    assert.equal(result.library.ok, true)
    assert.equal(result.compat.ok, true)
    assert.deepEqual(result.compat.logGenerations, [4])
  })
})
