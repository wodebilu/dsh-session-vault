/**
 * Offline Host tests for Session Vault. They build a throwaway home and a
 * throwaway vault under the temp directory; no real drive is touched.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleInstalled, classify, detachAll, handleCommand, moveToVault, restoreAll, syncToVault } from '../index.js'

/**
 * Build a fake harness home with stored data and an empty vault.
 * @returns {Promise<{base: string, home: string, vault: string}>} fixture.
 */
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'vault-'))
  const home = join(base, 'home')
  const vault = join(base, 'usb', 'dsh-vault')
  await mkdir(join(home, 'sessions', '--demo--', 'session-1'), { recursive: true })
  await writeFile(join(home, 'sessions', '--demo--', 'session-1', 'log.jsonl'), 'hello')
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), '{}')
  await mkdir(join(home, 'attachments', 'v1'), { recursive: true })
  await mkdir(vault, { recursive: true })
  return { base, home, vault }
}

/** First sync moves local data into the vault and links every directory. */
{
  const { base, home, vault } = await fixture()
  const outcome = syncToVault(home, vault)
  assert.deepEqual(outcome.moved.sort(), ['attachments', 'sessions', 'storages'])
  for (const name of ['sessions', 'storages', 'attachments']) {
    assert.equal(classify(join(home, name)).kind, 'linked', `${name} not linked`)
    assert.equal(existsSync(join(vault, name)), true, `${name} missing in vault`)
  }
  assert.deepEqual(await readdir(join(vault, 'sessions', '--demo--', 'session-1')), ['log.jsonl'])
  assert.deepEqual(await readdir(join(home, 'sessions', '--demo--', 'session-1')), ['log.jsonl'])
  await rm(base, { recursive: true, force: true })
}

/** Detach makes every path dangling; writes fail and nothing is created. */
{
  const { base, home, vault } = await fixture()
  syncToVault(home, vault)
  detachAll(home)
  for (const name of ['sessions', 'storages', 'attachments']) {
    assert.equal(classify(join(home, name)).kind, 'dangling', `${name} not dangling`)
  }
  let failed = false
  try {
    await writeFile(join(home, 'sessions', 'x.txt'), 'x')
  } catch {
    failed = true
  }
  assert.equal(failed, true, 'write through a dangling junction must fail')
  // The vault keeps the only copy.
  assert.equal(existsSync(join(vault, 'sessions', '--demo--', 'session-1', 'log.jsonl')), true)
  await rm(base, { recursive: true, force: true })
}

/** Re-attaching after a detach restores access without moving anything. */
{
  const { base, home, vault } = await fixture()
  syncToVault(home, vault)
  detachAll(home)
  const again = syncToVault(home, vault)
  assert.equal(classify(join(home, 'sessions')).kind, 'linked')
  assert.deepEqual(again.moved, [])
  assert.deepEqual(await readdir(join(home, 'sessions', '--demo--', 'session-1')), ['log.jsonl'])
  await rm(base, { recursive: true, force: true })
}

/** A vault that already holds data is not overwritten by local data. */
{
  const { base, home, vault } = await fixture()
  await mkdir(join(vault, 'sessions', '--other--'), { recursive: true })
  const outcome = syncToVault(home, vault)
  assert.equal(outcome.conflicts.length, 1)
  assert.match(outcome.conflicts[0], /sessions/)
  assert.equal(classify(join(home, 'sessions')).kind, 'real', 'local data must stay accessible')
  await rm(base, { recursive: true, force: true })
}

/** Status and unknown commands answer without throwing. */
{
  const base = await mkdtemp(join(tmpdir(), 'vault-empty-'))
  const home = join(base, 'home')
  const status = handleCommand(home, 'status')
  assert.equal(status.kind, 'success')
  assert.equal(JSON.parse(status.text).items.length, 3)
  assert.equal(handleCommand(home, 'nonsense').kind, 'error')
  await rm(base, { recursive: true, force: true })
}

/** A manual move copies local data in; nothing happens without being asked. */
{
  const { base, home, vault } = await fixture()
  const steps = moveToVault(home, vault)
  assert.equal(steps.every((line) => line.includes('已搬到随身盘')), true, steps.join('|'))
  assert.equal(classify(join(home, 'sessions')).kind, 'linked')
  assert.equal(existsSync(join(vault, 'sessions', '--demo--', 'session-1', 'log.jsonl')), true)
  await rm(base, { recursive: true, force: true })
}

/** Restore copies the vault back and drops the links. */
{
  const { base, home, vault } = await fixture()
  moveToVault(home, vault)
  const steps = restoreAll(home, vault)
  assert.equal(steps.length, 3)
  assert.equal(classify(join(home, 'sessions')).kind, 'real')
  assert.deepEqual(await readdir(join(home, 'sessions', '--demo--', 'session-1')), ['log.jsonl'])
  assert.equal(existsSync(join(vault, 'sessions', '--demo--', 'session-1', 'log.jsonl')), true, 'vault copy must survive restore')
  await rm(base, { recursive: true, force: true })
}

console.log('session-vault host tests OK')