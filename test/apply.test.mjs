// The host half's `apply()`: the part DSH calls on boot. It leaves a trace, the
// recovery kit, takes the library lock and registers the command — none of that
// is exercised by the core tests, and a failure there is a boot failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

// The repair is a Win32-path feature: `driveOf` reads a two-character prefix and
// the vault root must carry one. A POSIX temp directory has no drive letter, so
// these two behaviours cannot be exercised there — the unit-level coverage in
// drift-repair.test.mjs injects the letter explicitly and runs everywhere.
const WINDOWS_ONLY = process.platform !== 'win32'
const skipReason = 'drive letters are a Win32 concept; covered by drift-repair tests'

test('apply repairs a carried vault at startup, with a backup', { skip: WINDOWS_ONLY && skipReason }, () => {
  const dir = scratch()
  const previous = process.env.DSH_HOME
  try {
    // A vault whose records name a drive that is not the one this machine has:
    // exactly what a USB stick becomes after moving to another PC. Booting must
    // make it usable without the user running anything.
    const recorded = (process.env.SystemDrive?.[0] ?? 'C').toUpperCase() === 'G' ? 'H' : 'G'
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a', cwd: `${recorded}:\\proj` }] })
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'session-vault.json'), JSON.stringify({ mode: 'custom', path: library.root }))
    process.env.DSH_HOME = home

    let command = null
    const dispose = apply({
      effect(run) {
        return run()
      },
      commands: {
        register(definition) {
          command = definition
          return () => {}
        },
      },
    })
    try {
      // The library now names the drive the vault is really on, and the originals
      // were kept: a rewrite at boot is allowed, a rewrite without a backup is not.
      const index = JSON.parse(readFileSync(join(library.root, 'storages', 'workspace.json'), 'utf8'))
      const vaultLetter = index.tables.workspaces[Object.keys(index.tables.workspaces)[0]].path.slice(0, 2)
      assert.notEqual(vaultLetter, `${recorded}:`, 'the recorded letter was replaced')
      assert.equal(existsSync(join(library.root, '_drift-backup')), true, 'the originals are backed up')

      // And the boot reports what it did, so the panel can say so.
      const status = command.handler({ rawInput: 'status' })
      assert.equal(status.kind, 'success', status.text)
      const parsed = JSON.parse(status.text)
      assert.ok(parsed.drift, 'status carries the drift report')
      assert.equal(parsed.drift.applied, true, 'status says the repair happened')
      assert.ok(parsed.drift.changes > 0)
      assert.equal(typeof parsed.drift.backup, 'string')
    } finally {
      dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply never rewrites a library owned by another live DSH', { skip: WINDOWS_ONLY && skipReason }, () => {
  const dir = scratch()
  const previous = process.env.DSH_HOME
  try {
    const recorded = (process.env.SystemDrive?.[0] ?? 'C').toUpperCase() === 'G' ? 'H' : 'G'
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a', cwd: `${recorded}:\\proj` }] })
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'session-vault.json'), JSON.stringify({ mode: 'custom', path: library.root }))
    process.env.DSH_HOME = home
    // Another live process owns the library. Its pid must be a real one, else the
    // lock is treated as stale and taken over.
    writeFileSync(lockFile(library.root), JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), host: 'other' }))
    const indexBefore = readFileSync(join(library.root, 'storages', 'workspace.json'), 'utf8')

    let command = null
    const dispose = apply({
      effect(run) {
        return run()
      },
      commands: {
        register(definition) {
          command = definition
          return () => {}
        },
      },
    })
    try {
      // Rewriting under a live reader could tear a log, so it is deferred.
      assert.equal(readFileSync(join(library.root, 'storages', 'workspace.json'), 'utf8'), indexBefore)
      const parsed = JSON.parse(command.handler({ rawInput: 'status' }).text)
      assert.equal(parsed.drift.applied, false)
      assert.equal(parsed.drift.deferred, 'library in use')
      assert.ok(parsed.drift.repairable === false, 'the work is still outstanding')
    } finally {
      dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
