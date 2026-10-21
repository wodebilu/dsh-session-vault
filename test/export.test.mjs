// Clean export: keep what was said, drop everything a session actually needs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { cleanConversation, exportClean } from '../lib/relocate-core.mjs'
import { makeLibrary } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `export-${counter}-`))
}

const TITLE = '演示 对话/导出'
const ROWS = [
  { type: 'session', version: 4, id: 'session-a', createdAt: 1792566000000, cwd: 'F:\\demo' },
  { type: 'session/title', data: { title: TITLE } },
  { type: 'system/message', data: { content: [{ type: 'text', text: 'you are a helpful assistant' }] } },
  {
    type: 'user/message',
    seq: 10,
    time: 1792566093000,
    data: { content: [{ type: 'text', text: '第一个问题' }], role: 'user' },
  },
  { type: 'tool/call', seq: 12, data: { name: 'shell', args: 'ls' } },
  { type: 'tool/result', seq: 13, data: { text: 'a.txt' } },
  {
    type: 'assistant/message',
    seq: 21,
    time: 1792566095000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking that must not be exported' },
          { type: 'text', text: '第一个回答' },
        ],
      },
    },
  },
  {
    type: 'user/message',
    seq: 30,
    time: 1792566096000,
    data: { content: [{ type: 'image', source: 'x' }], role: 'user' },
  },
]

const libraryWithRows = (dir) =>
  makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a', rows: ROWS, title: TITLE }] })

test('cleanConversation keeps user and assistant text only', () => {
  const dir = scratch()
  try {
    const library = libraryWithRows(dir)
    const conversation = cleanConversation({ root: library.root, sessionId: 'session-a' })

    assert.equal(conversation.id, 'session-a')
    assert.equal(conversation.cwd, 'F:\\demo')
    assert.deepEqual(
      conversation.messages.map((message) => message.role),
      ['user', 'assistant'],
    )
    assert.equal(conversation.messages[0].text, '第一个问题')
    assert.equal(conversation.messages[1].text, '第一个回答')

    const serialized = JSON.stringify(conversation)
    assert.equal(serialized.includes('thinking that must not be exported'), false, 'reasoning is dropped')
    assert.equal(serialized.includes('helpful assistant'), false, 'system messages are dropped')
    assert.equal(serialized.includes('a.txt'), false, 'tool traffic is dropped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exportClean writes a markdown transcript with a safe file name', () => {
  const dir = scratch()
  try {
    const library = libraryWithRows(dir)
    const target = join(dir, 'out')
    const result = exportClean({
      root: library.root,
      sessionId: 'session-a',
      format: 'md',
      target,
    })

    assert.equal(result.messages, 2)
    assert.equal(result.path.startsWith(target), true)
    assert.equal(/[\\/:*?"<>|]/.test(basename(result.path)), false, 'no unsafe characters')
    assert.equal(existsSync(result.path), true)

    const text = readFileSync(result.path, 'utf8')
    assert.match(text, /# 演示 对话\/导出/)
    assert.match(text, /## 你/)
    assert.match(text, /## 助手/)
    assert.match(text, /第一个问题/)
    assert.doesNotMatch(text, /thinking that must not be exported/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exportClean writes JSON with the same message set', () => {
  const dir = scratch()
  try {
    const library = libraryWithRows(dir)
    const result = exportClean({
      root: library.root,
      sessionId: 'session-a',
      format: 'json',
      target: join(dir, 'out'),
    })
    assert.equal(result.format, 'json')
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'))
    assert.equal(parsed.format, 'clean-v1')
    assert.equal(parsed.messages.length, 2)
    assert.equal(parsed.messages[1].text, '第一个回答')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exportClean never writes inside the library', () => {
  const dir = scratch()
  try {
    const library = libraryWithRows(dir)
    const result = exportClean({
      root: library.root,
      sessionId: 'session-a',
      format: 'md',
      target: join(dir, 'outside'),
    })
    assert.equal(result.path.startsWith(library.root), false)
    assert.equal(existsSync(join(library.root, 'sessions')), true, 'the library is untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
