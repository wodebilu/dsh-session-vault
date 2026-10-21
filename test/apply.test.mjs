// The host half's `apply()`: the part DSH calls on boot. It leaves a trace, the
// recovery kit, takes the library lock and registers the command — none of that
// is exercised by the core tests, and a failure there is a boot failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, lockFile, readLock } from '../index.js'
import { makeLibrary } from './fixtures.mjs'

const TEMP = join(import.meta.dirname, '.tmp')
mkdirSync(TEMP, { recursive: true })
let counter = 0
const scratch = () => {
  counter += 1
  return mkdtempSync(join(TEMP, `apply-${counter}-`))
}

/** Boot the host half against a throwaway home and library. */
function boot() {
  const dir = scratch()
  const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'session-vault.json'),
    JSON.stringify({ mode: 'custom', path: library.root }),
  )

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home

  let command = null
  const ctx = {
    effect(run) {
      return run()
    },
    commands: {
      register(definition) {
        command = definition
        return () => {}
      },
    },
  }

  const dispose = apply(ctx)
  return {
    dir,
    home,
    library,
    command,
    dispose,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('apply leaves a trace, the recovery kit, and a lock it can release', () => {
  const booted = boot()
  try {
    assert.ok(existsSync(join(booted.home, 'session-vault-host.log')), 'the startup trace exists')
    const trace = readFileSync(join(booted.home, 'session-vault-host.log'), 'utf8')
    assert.match(trace, /host half loaded/)
    assert.match(trace, /"mode":"custom"/)

    for (const name of ['恢复本机.cmd', 'session-vault-recover.cmd', 'session-vault-recover.ps1']) {
      assert.ok(existsSync(join(booted.home, name)), `the recovery kit wrote ${name}`)
    }

    const lock = readLock(booted.library.root)
    assert.notEqual(lock, null, 'the library is locked on boot')
    assert.equal(lock.pid, process.pid)
    assert.equal(lock.alive, true)

    assert.ok(booted.command, 'the /vault command was registered')
    assert.equal(booted.command.name, 'vault')

    const status = booted.command.handler({ rawInput: 'status' })
    assert.equal(status.kind, 'success', status.text)
    assert.match(status.text, /"effective":"custom"/)

    booted.dispose()
    assert.equal(existsSync(lockFile(booted.library.root)), false, 'the lock is released')
  } finally {
    booted.restore()
  }
})

test('apply records why a custom folder was not used', () => {
  const dir = scratch()
  const previous = process.env.DSH_HOME
  try {
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a' }] })
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    // Point at the library but delete its index: the guard must report a fallback.
    writeFileSync(
      join(home, 'session-vault.json'),
      JSON.stringify({ mode: 'custom', path: library.root }),
    )
    rmSync(join(library.root, 'storages', 'workspace.json'))
    process.env.DSH_HOME = home

    const dispose = apply({
      effect(run) {
        return run()
      },
      commands: {
        register() {
          return () => {}
        },
      },
    })
    try {
      const fallback = join(home, 'session-vault-fallback.log')
      assert.ok(existsSync(fallback), 'the fallback reason was written down')
      assert.match(readFileSync(fallback, 'utf8'), /custom folder fell back to local/)
    } finally {
      dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
