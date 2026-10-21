// A DOM-level smoke test of the client half.
//
// `client.js` is written for DSH's module loader, so it is loaded the same way
// DSH loads it: a stub `window.__ModuleLoader__` captures the factory, the
// factory is called with a real React, `apply(ctx)` registers the footer
// component, and that component is then mounted in jsdom and clicked through.
//
// It cannot prove the DSH shell renders it identically, but it does prove the
// React tree is valid, the hooks are legal, every handler exists, and the new
// dialogs open, call the host with the right payload and close again.
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document })
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, {
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})

let spec = null
globalThis.window.__ModuleLoader__ = {
  load(value) {
    spec = value
  },
}
await import('../client.js')
assert.notEqual(spec, null, 'client.js did not call the module loader')

const client = spec.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

const STATUS = {
  mode: 'custom',
  effective: 'custom',
  requested: 'F:\\vault',
  available: true,
  usable: true,
  reason: 'ok',
  degraded: false,
  needsRepair: false,
  panic: false,
  root: 'F:\\vault',
  sessions: 'F:\\vault\\sessions',
  storages: 'F:\\vault\\storages',
  attachments: 'F:\\vault\\attachments\\v1',
  home: 'C:\\Users\\tester\\.dsh',
  modeFile: 'C:\\Users\\tester\\.dsh\\session-vault.json',
  vault: { id: 'vault-id' },
  lock: { pid: 4242, host: 'OTHER-PC', alive: true, mine: false },
  updatedAt: null,
}

const BACKUPS = [
  {
    dir: 'F:\\vault\\_deleted\\1-session-x',
    name: '1-session-x',
    createdAt: '2026-10-21T00:00:00.000Z',
    sessions: [{ id: 'session-x', title: '备份里的会话', cwd: 'F:\\vault' }],
  },
]

// useSyncExternalStore compares snapshots by identity, so the store must hand
// back the same object every time — exactly like DSH's own session list does.
const SESSION_LIST = {
  ids: ['session-1'],
  byId: { 'session-1': { title: '第一条会话' } },
}

/** Mount the footer component with a scripted host and a session list. */
async function mount() {
  const calls = []
  const route = (line) => {
    if (line === 'status') return { kind: 'success', text: JSON.stringify(STATUS) }
    if (line === 'backups') return { kind: 'success', text: JSON.stringify(BACKUPS) }
    if (line.startsWith('export ')) {
      return {
        kind: 'success',
        text: JSON.stringify({ path: 'C:\\out\\导出-12345678.md', messages: 12, format: 'md' }),
      }
    }
    if (line.startsWith('drop-backups ')) {
      return { kind: 'success', text: JSON.stringify({ removed: [{ dir: 'x' }], remaining: 0 }) }
    }
    if (line === 'cleanup') {
      return { kind: 'success', text: JSON.stringify({ removed: [{ file: 'a' }], bytes: 2048 }) }
    }
    return { kind: 'success', text: '{}' }
  }

  let Component = null
  const ctx = {
    effect(run) {
      return run()
    },
    remote: {
      commands: {
        async execute(_sessionId, text) {
          const line = String(text).replace(/^\/vault\s*/, '')
          calls.push(line)
          return { ok: true, value: { result: route(line) } }
        },
      },
    },
    uiWorkspace: {
      sessions: {
        list: {
          subscribe() {
            return () => {}
          },
          getSnapshot() {
            return SESSION_LIST
          },
        },
      },
      async pickDirectory() {
        return 'C:\\out'
      },
    },
    slots: {
      inject(_name, fn) {
        fn()
      },
      register(_options, component) {
        Component = component
        return component
      },
    },
  }

  client.apply(ctx)
  assert.ok(Component, 'the footer component was not registered')

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(Component, { wide: true }))
  })

  const click = async (element) => {
    assert.ok(element, 'tried to click a missing element')
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }
  const buttonByText = (scope, pattern) =>
    [...scope.querySelectorAll('button')].find((button) => pattern.test(button.textContent ?? ''))

  return { container, calls, click, buttonByText, root }
}

test('the footer renders and opens the panel', async () => {
  const { container, calls, click } = await mount()
  assert.ok(container.querySelector('.sv-trigger'), 'the footer trigger exists')
  assert.equal(container.querySelector('.sv-panel'), null, 'the panel starts closed')

  await click(container.querySelector('.sv-trigger'))
  const panel = container.querySelector('.sv-panel')
  assert.ok(panel, 'the panel opened')
  assert.match(panel.textContent, /管理会话|Manage sessions/)
  assert.match(panel.textContent, /F:\\vault/, 'it shows the active library')
  assert.equal(calls.includes('status'), true, 'it asked the host for status')
})

test('a library held by another live DSH is reported in the panel', async () => {
  const { container, click } = await mount()
  await click(container.querySelector('.sv-trigger'))
  const warn = container.querySelector('.sv-warn')
  assert.ok(warn, 'the lock warning is rendered')
  assert.match(warn.textContent, /4242/, 'it names the holder pid')
  assert.match(warn.textContent, /OTHER-PC/, 'it names the holder host')
})

test('manage sessions offers export and the export dialog reaches the host', async () => {
  const { container, calls, click, buttonByText } = await mount()
  await click(container.querySelector('.sv-trigger'))
  const panel = container.querySelector('.sv-panel')

  await click(buttonByText(panel, /管理会话|Manage sessions/))
  const manage = container.querySelector('.sv-dialog')
  assert.ok(manage, 'the manage dialog opened')
  for (const label of [/搬家|Move library/, /换单位|Move workspace/, /删除|Delete/, /备份与恢复|Backup and restore/, /导出干净对话|Export clean transcript/]) {
    assert.ok(buttonByText(manage, label), `missing entry: ${label}`)
  }

  await click(buttonByText(manage, /导出干净对话|Export clean transcript/))
  const form = container.querySelector('.sv-dialog')
  assert.match(form.textContent, /导出到文件夹|Export to folder/)
  assert.match(form.textContent, /工具调用|tool calls/, 'the hint explains what is dropped')

  // The browse button fills the target through ctx.uiWorkspace.pickDirectory.
  await click(buttonByText(form, /浏览|Browse/))
  await click(buttonByText(container.querySelector('.sv-dialog'), /导出干净对话|Export clean transcript/))

  const exportCall = calls.find((line) => line.startsWith('export '))
  assert.ok(exportCall, 'the export command was sent')
  const payload = JSON.parse(Buffer.from(exportCall.slice('export b64:'.length), 'base64url').toString('utf8'))
  assert.deepEqual(payload, { sessionId: 'session-1', format: 'md', target: 'C:\\out' })

  const dialog = container.querySelector('.sv-dialog')
  assert.match(dialog.textContent, /导出完成|Export finished/)
  assert.match(dialog.textContent, /12345678\.md/, 'it reports the written file')
})

test('the backup dialog lists backups and offers pruning', async () => {
  const { container, calls, click, buttonByText } = await mount()
  await click(container.querySelector('.sv-trigger'))
  const panel = container.querySelector('.sv-panel')
  await click(buttonByText(panel, /管理会话|Manage sessions/))
  const manage = container.querySelector('.sv-dialog')
  await click(buttonByText(manage, /备份与恢复|Backup and restore/))

  const dialog = container.querySelector('.sv-dialog')
  assert.match(dialog.textContent, /备份里的会话/, 'the backup session is listed')
  const keepInput = dialog.querySelector('input[inputmode="numeric"]')
  assert.ok(keepInput, 'the keep-N input exists')
  assert.equal(keepInput.value, '1', 'it defaults to keeping one backup')

  await click(buttonByText(dialog, /清理旧备份|Prune old backups/))
  // The confirmation overlay is appended after the backup dialog, so the last
  // `.sv-dialog` is the one on top.
  const confirm = [...container.querySelectorAll('.sv-dialog')].at(-1)
  assert.notEqual(confirm, dialog, 'a confirmation overlay opened')
  assert.match(confirm.textContent, /1/, 'the confirmation repeats the keep count')
  await click(buttonByText(confirm, /清理旧备份|Prune old backups/))

  const pruneCall = calls.find((line) => line.startsWith('drop-backups '))
  assert.ok(pruneCall, 'the prune command was sent')
  const payload = JSON.parse(Buffer.from(pruneCall.slice('drop-backups b64:'.length), 'base64url').toString('utf8'))
  assert.deepEqual(payload, { keep: 1 })
})

test('advanced offers the local log cleanup and reports what went away', async () => {
  const { container, calls, click, buttonByText } = await mount()
  await click(container.querySelector('.sv-trigger'))
  const panel = container.querySelector('.sv-panel')
  await click(buttonByText(panel, /高级|Advanced/))
  const cleanup = buttonByText(panel, /清理本地日志|Clean local logs/)
  assert.ok(cleanup, 'the cleanup entry exists')

  await click(cleanup)
  const confirm = container.querySelector('.sv-dialog')
  assert.match(confirm.textContent, /模式记录|mode record/, 'the confirmation names what is kept')
  await click(buttonByText(confirm, /清理本地日志|Clean local logs/))

  assert.equal(calls.includes('cleanup'), true, 'the cleanup command was sent')
  assert.match(container.querySelector('.sv-dialog').textContent, /已删除|Removed/)
})
