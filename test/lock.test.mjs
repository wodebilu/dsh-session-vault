// The library lock and the local-log cleanup, both of which delete things and
// therefore need to be pinned down.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  acquireVaultLock,
  cleanupLogs,
  isProcessAlive,
  lockFile,
  readLock,
  releaseVaultLock,
} from '../index.js'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `lock-${counter}-`))
}

test('a fresh library is locked by this process and released on request', () => {
  const dir = scratch()
  try {
    const acquired = acquireVaultLock(dir)
    assert.equal(acquired.mine, true)
    assert.equal(existsSync(lockFile(dir)), true)

    const lock = readLock(dir)
    assert.equal(lock.pid, process.pid)
    assert.equal(lock.alive, true)

    assert.equal(releaseVaultLock(dir), true)
    assert.equal(readLock(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock held by another live process is respected, not overwritten', () => {
  const dir = scratch()
  try {
    const parent = process.ppid
    assert.equal(isProcessAlive(parent), true, 'the test runner parent is alive')
    acquireVaultLock(dir, { pid: parent })

    const second = acquireVaultLock(dir)
    assert.equal(second.mine, false, 'a second process must not take the lock')
    assert.equal(second.holder.pid, parent)

    assert.equal(releaseVaultLock(dir), false, 'only the holder can release it')
    assert.equal(existsSync(lockFile(dir)), true)
    assert.equal(releaseVaultLock(dir, { pid: parent }), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock left by a dead process is replaced', () => {
  const dir = scratch()
  try {
    writeFileSync(
      lockFile(dir),
      JSON.stringify({ pid: 999999, startedAt: '2026-10-20T00:00:00.000Z', host: 'gone' }),
    )
    assert.equal(readLock(dir).alive, false)
    const acquired = acquireVaultLock(dir)
    assert.equal(acquired.mine, true, 'a stale lock never wedges the library')
    assert.equal(readLock(dir).pid, process.pid)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup removes the plugin logs and nothing else', () => {
  const dir = scratch()
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = dir
    for (const name of ['session-vault-host.log', 'session-vault-boot.log', 'session-vault-fallback.log']) {
      writeFileSync(join(dir, name), 'log line\n')
    }
    // These must survive: they are the recovery kit and the mode record.
    for (const name of ['session-vault.json', '恢复本机.cmd', 'session-vault-recover.ps1', 'session-vault.panic']) {
      writeFileSync(join(dir, name), '{}')
    }

    const result = cleanupLogs()
    assert.equal(result.removed.length, 3)
    assert.equal(result.bytes > 0, true)
    for (const name of ['session-vault-host.log', 'session-vault-boot.log', 'session-vault-fallback.log']) {
      assert.equal(existsSync(join(dir, name)), false, `${name} is gone`)
    }
    for (const name of ['session-vault.json', '恢复本机.cmd', 'session-vault-recover.ps1', 'session-vault.panic']) {
      assert.equal(existsSync(join(dir, name)), true, `${name} is kept`)
    }

    const again = cleanupLogs()
    assert.equal(again.removed.length, 0, 'a second cleanup is a no-op')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
