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

test('apply reports drive drift at startup but writes nothing', () => {
  const dir = scratch()
  const previous = process.env.DSH_HOME
  try {
    // A vault whose records name a drive that is not the one it sits on, and no
    // mirrored folder anywhere: the plan has work it *could* do and is forbidden
    // to do it at boot.
    const library = makeLibrary(join(dir, 'lib'), { sessions: [{ id: 'session-a', cwd: 'G:\\proj' }] })
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'session-vault.json'), JSON.stringify({ mode: 'custom', path: library.root }))
    process.env.DSH_HOME = home

    // Snapshot every file the repair would touch.
    const indexBefore = readFileSync(join(library.root, 'storages', 'workspace.json'), 'utf8')
    const treeBefore = snapshot(library.root, 'storages', 'sessions')

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
      // Nothing the *repair* would touch may change: no index rewrite, no
      // header rewrite, no backup directory. (The lock file is the one thing
      // boot is supposed to write, so it is excluded from the comparison.)
      assert.equal(readFileSync(join(library.root, 'storages', 'workspace.json'), 'utf8'), indexBefore)
      assert.deepEqual(
        snapshot(library.root, 'storages', 'sessions'),
        treeBefore,
        'boot must not touch the library',
      )
      assert.equal(existsSync(join(library.root, '_drift-backup')), false, 'boot must not back up')

      // The finding is surfaced instead, through status and the command.
      const status = command.handler({ rawInput: 'status' })
      assert.equal(status.kind, 'success', status.text)
      const parsed = JSON.parse(status.text)
      assert.ok(parsed.drift, 'status carries the drift report')
      assert.equal(parsed.drift.at !== undefined, true)
      assert.ok(parsed.drift.warnings.length >= 1, 'the drift is explained')
    } finally {
      dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Every path below the given subtrees with its byte length, for change detection. */
function snapshot(root, ...only) {
  const out = {}
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        out[key + '/'] = 'dir'
        walk(abs, key)
      } else {
        out[key] = readFileSync(abs).length
      }
    }
  }
  for (const top of only) walk(join(root, top), '')
  return out
}
