/**
 * Vault storage engine.
 *
 * Moves DSH's conversation directories onto a removable drive by replacing
 * them with directory junctions, without changing any DSH configuration:
 * DSH keeps using `$DSH_HOME/<name>`, the OS redirects it to the vault.
 *
 * States per managed path:
 *   linked    junction -> existing vault directory (normal use)
 *   dangling  junction -> deleted target (USB absent: reads empty, writes fail)
 *   real      ordinary local directory
 *
 * `dangling` is the safe offline state: nothing can be written locally, so
 * there is nothing to delete afterwards.
 */

import { execFileSync } from 'node:child_process'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rmdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Directories managed by the vault. */
export const MANAGED = ['sessions', 'storages', 'attachments']

/** Request file written by the plugin, consumed on the next start. */
export const REQUEST_FILE = '.session-vault-request.json'

/** Result file written by the boot migration, read by the settings page. */
export const RESULT_FILE = '.session-vault-result.json'

/**
 * Resolve the harness home the way DSH does.
 * @param {NodeJS.ProcessEnv} env - environment.
 * @returns {string} absolute home.
 */
export function resolveHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

/**
 * Describe one managed path without following the link.
 * @param {string} path - managed path.
 * @returns {Promise<{kind: string, target?: string, entries?: number}>} state.
 */
export async function classify(path) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { kind: 'missing' }
    throw error
  }
  if (info.isSymbolicLink()) {
    let target
    try {
      target = resolve(dirname(path), await readlink(path))
    } catch {
      target = undefined
    }
    if (target === undefined) return { kind: 'dangling', target: '<unreadable>' }
    const alive = await stat(target).then((value) => value.isDirectory(), () => false)
    return { kind: alive ? 'linked' : 'dangling', target }
  }
  if (info.isDirectory()) {
    const entries = await readdir(path).catch(() => [])
    return { kind: 'real', entries: entries.length }
  }
  return { kind: 'other' }
}

/**
 * Remove a junction or symlink itself, never its target.
 * @param {string} path - link path.
 */
export async function removeLink(path) {
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      try {
        await unlink(path)
        return
      } catch (error) {
        if (error.code !== 'EPERM' && error.code !== 'EISDIR' && error.code !== 'EACCES') throw error
      }
      await rmdir(path)
      return
    } catch (error) {
      lastError = error
      if (error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'EACCES') break
      await new Promise((done) => setTimeout(done, 200))
    }
  }
  throw lastError ?? new Error(`could not remove link ${path}`)
}

/**
 * Replace `path` with a junction to `target`; the target must exist.
 * @param {string} path - link path.
 * @param {string} target - existing directory.
 */
export async function linkTo(path, target) {
  const state = await classify(path)
  if (state.kind === 'linked' || state.kind === 'dangling') await removeLink(path)
  else if (state.kind === 'real') {
    if ((state.entries ?? 0) > 0) throw new Error(`${path} still holds data`)
    await rmdir(path)
  } else if (state.kind === 'other') {
    throw new Error(`${path} is neither a directory nor a link`)
  }
  await symlink(target, path, 'junction')
}

/**
 * Turn `path` into a dangling junction.
 * @param {string} path - managed path.
 */
export async function makeDangling(path) {
  const state = await classify(path)
  if (state.kind === 'dangling') return
  if (state.kind === 'real') {
    if ((state.entries ?? 0) > 0) throw new Error(`${path} holds data`)
    await rmdir(path)
  } else if (state.kind === 'linked') {
    await removeLink(path)
  } else if (state.kind === 'other') {
    throw new Error(`${path} is neither a directory nor a link`)
  }
  const empty = join(dirname(path), `.vault-empty-${process.pid}`)
  await mkdir(empty, { recursive: true })
  await symlink(empty, path, 'junction')
  await rmdir(empty)
}

/**
 * Move the contents of `from` into `to`, then remove `from`.
 * @param {string} from - source directory.
 * @param {string} to - destination directory.
 * @param {boolean} merge - allow a non-empty destination.
 */
async function moveInto(from, to, merge) {
  await mkdir(to, { recursive: true })
  const existing = await readdir(to)
  if (existing.length > 0 && !merge) throw new Error(`vault target ${to} is not empty`)
  for (const entry of await readdir(from)) {
    const source = join(from, entry)
    const destination = join(to, entry)
    try {
      await rename(source, destination)
    } catch (error) {
      if (error.code !== 'EXDEV') throw error
      await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
      await rm(source, { recursive: true, force: false })
    }
  }
  await rmdir(from)
}

/**
 * Attach every managed path to the vault, moving existing local data.
 * @param {{home: string, usb: string, names?: string[], merge?: boolean}} options - inputs.
 * @returns {Promise<string[]>} human-readable steps.
 */
export async function attachToVault({ home, usb, names = MANAGED, merge = false }) {
  const vault = resolve(usb)
  await mkdir(vault, { recursive: true })
  const steps = []
  for (const name of names) {
    const local = join(home, name)
    const remote = join(vault, name)
    await mkdir(remote, { recursive: true })
    const state = await classify(local)
    if (state.kind === 'real' && (state.entries ?? 0) > 0) {
      const remoteEntries = await readdir(remote)
      if (remoteEntries.length > 0 && !merge) {
        throw new Error(`${remote} is not empty and ${local} still has data`)
      }
      await moveInto(local, remote, true)
      await linkTo(local, remote)
      steps.push(`${name}: moved into the vault`)
      continue
    }
    if (state.kind === 'linked' && state.target === remote) {
      steps.push(`${name}: already attached`)
      continue
    }
    await linkTo(local, remote)
    steps.push(`${name}: linked`)
  }
  return steps
}

/**
 * Detach every managed path into the dangling state.
 * @param {{home: string, names?: string[]}} options - inputs.
 * @returns {Promise<string[]>} human-readable steps.
 */
export async function detachAll({ home, names = MANAGED }) {
  const steps = []
  for (const name of names) {
    await makeDangling(join(home, name))
    steps.push(`${name}: dangling`)
  }
  return steps
}

/**
 * Restore ordinary local directories, optionally copying vault data back.
 * @param {{home: string, usb?: string, names?: string[], copyBack?: boolean}} options - inputs.
 * @returns {Promise<string[]>} human-readable steps.
 */
export async function restoreLocal({ home, usb, names = MANAGED, copyBack = false }) {
  const steps = []
  for (const name of names) {
    const path = join(home, name)
    const state = await classify(path)
    if (state.kind === 'linked') await removeLink(path)
    else if (state.kind === 'dangling') await removeLink(path)
    await mkdir(path, { recursive: true })
    if (copyBack && usb !== undefined) {
      const source = join(resolve(usb), name)
      const entries = await readdir(source).catch(() => [])
      for (const entry of entries) {
        await cp(join(source, entry), join(path, entry), { recursive: true, force: false, errorOnExist: false })
      }
      if (entries.length > 0) steps.push(`${name}: copied back`)
      else steps.push(`${name}: local (vault empty)`)
      continue
    }
    steps.push(`${name}: local`)
  }
  return steps
}

/**
 * Read the current state of every managed path.
 * @param {{home: string, names?: string[]}} options - inputs.
 * @returns {Promise<{home: string, rows: Array<{name: string, kind: string, target?: string, entries?: number}>}>} state.
 */
export async function readStatus({ home, names = MANAGED }) {
  const rows = []
  for (const name of names) {
    const state = await classify(join(home, name))
    rows.push({ name, ...state })
  }
  return { home, rows }
}

/**
 * List removable drive letters.
 * @returns {string[]} letters such as `["E:"]`.
 */
export function removableDrives() {
  try {
    const output = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Volume | Where-Object { $_.DriveType -eq 'Removable' -and $_.DriveLetter } | ForEach-Object { $_.DriveLetter + ':' }",
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 },
    )
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Z]:$/.test(line))
  } catch {
    return []
  }
}

/**
 * Persist one pending request for the next start.
 * @param {string} home - harness home.
 * @param {{action: 'attach'|'local', usb?: string, names?: string[]}} request - request body.
 */
export async function writeRequest(home, request) {
  await writeFile(
    join(home, REQUEST_FILE),
    `${JSON.stringify({ ...request, requestedAt: new Date().toISOString() }, null, 2)}\n`,
  )
}

/**
 * Read the pending request, if any.
 * @param {string} home - harness home.
 * @returns {Promise<{action: string, usb?: string, names?: string[]} | undefined>} request.
 */
export async function readRequest(home) {
  try {
    return JSON.parse(await readFile(join(home, REQUEST_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Remove the pending request.
 * @param {string} home - harness home.
 */
export async function clearRequest(home) {
  await rm(join(home, REQUEST_FILE), { force: true })
}

/**
 * Persist the outcome of the last boot migration.
 * @param {string} home - harness home.
 * @param {{ok: boolean, action: string, message: string}} result - outcome.
 */
export async function writeResult(home, result) {
  await writeFile(
    join(home, RESULT_FILE),
    `${JSON.stringify({ ...result, finishedAt: new Date().toISOString() }, null, 2)}\n`,
  )
}

/**
 * Read the outcome of the last boot migration.
 * @param {string} home - harness home.
 * @returns {Promise<{ok: boolean, action: string, message: string, finishedAt: string} | undefined>} result.
 */
export async function readResult(home) {
  try {
    return JSON.parse(await readFile(join(home, RESULT_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Perform the pending request, if any. Called during plugin startup, before
 * any session opens a file handle.
 * @param {string} home - harness home.
 * @returns {Promise<{ok: boolean, action: string, message: string} | undefined>} outcome.
 */
export async function runPendingMigration(home) {
  const request = await readRequest(home)
  if (request === undefined) return undefined
  let outcome
  try {
    if (request.action === 'attach') {
      if (typeof request.usb !== 'string' || request.usb.trim() === '') throw new Error('request has no vault path')
      const steps = await attachToVault({ home, usb: request.usb, names: request.names ?? MANAGED })
      outcome = { ok: true, action: 'attach', message: steps.join('; ') }
    } else if (request.action === 'local') {
      const steps = await restoreLocal({
        home,
        usb: request.usb,
        names: request.names ?? MANAGED,
        copyBack: true,
      })
      outcome = { ok: true, action: 'local', message: steps.join('; ') }
    } else {
      throw new Error(`unknown request action ${String(request.action)}`)
    }
  } catch (error) {
    outcome = { ok: false, action: String(request.action), message: error instanceof Error ? error.message : String(error) }
  }
  await clearRequest(home)
  await writeResult(home, outcome)
  return outcome
}
