/**
 * Session Vault — Host half.
 *
 * The whole product is one sentence: conversation data lives on a USB drive,
 * DSH keeps reading its normal paths, and nothing is left on the local disk.
 *
 * How: each managed directory (`sessions`, `storages`, `attachments`) is a
 * directory junction into a vault on the removable drive. DSH resolves the
 * path on every open, so the redirect is invisible to it.
 *
 * The vault is discovered at startup by looking for its marker file on every
 * drive letter — no OS query, no configuration, no button. If the vault is
 * present, the plugin points at it (moving any local data in first). If it is
 * absent, the managed paths become **dangling** junctions: reads see an empty
 * directory, writes fail, and no local copy can ever appear.
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Loader entry id used by `cordis.patch.yml`. */
export const name = 'session-vault'

/** Services this plugin cannot work without. */
export const inject = ['commands']

/** Directories kept on the removable drive. */
const MANAGED = ['sessions', 'storages', 'attachments']

/** Folder name on the drive, and the file that identifies a vault. */
const VAULT_DIR = 'dsh-vault'
const MARKER = 'session-vault.json'
const HOME_MARKER = '.session-vault.json'

/**
 * Resolve the harness home the way DSH does.
 * @returns {string} absolute home.
 */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return resolve(env)
  return join(homedir(), '.dsh')
}

/**
 * Describe one managed path without following the link.
 * @param {string} path - managed path.
 * @returns {{kind: string, target?: string, entries?: number}} state.
 */
export function classify(path) {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { kind: 'missing' }
    throw error
  }
  if (info.isSymbolicLink()) {
    let target
    try {
      target = resolve(dirname(path), readlinkSync(path))
    } catch {
      return { kind: 'dangling', target: '<unreadable>' }
    }
    const alive = (() => {
      try {
        return statSync(target).isDirectory()
      } catch {
        return false
      }
    })()
    return { kind: alive ? 'linked' : 'dangling', target }
  }
  if (info.isDirectory()) {
    let entries = 0
    try {
      entries = readdirSync(path).length
    } catch {
      entries = 0
    }
    return { kind: 'real', entries }
  }
  return { kind: 'other' }
}

/**
 * Remove a junction itself, never its target.
 * @param {string} path - link path.
 */
function removeLink(path) {
  try {
    unlinkSync(path)
    return
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EISDIR' && error.code !== 'EACCES') throw error
  }
  rmdirSync(path)
}

/**
 * Replace `path` with a junction to an existing `target`.
 * @param {string} path - link path.
 * @param {string} target - existing directory.
 */
function linkTo(path, target) {
  const state = classify(path)
  if (state.kind === 'linked' || state.kind === 'dangling') removeLink(path)
  else if (state.kind === 'real') {
    if ((state.entries ?? 0) > 0) throw new Error(`${path} 里还有数据`)
    rmdirSync(path)
  } else if (state.kind === 'other') {
    throw new Error(`${path} 既不是目录也不是链接`)
  }
  symlinkSync(target, path, 'junction')
}

/**
 * Turn `path` into a dangling junction: a link to an empty directory that is
 * then removed, so writes fail and reads see nothing.
 * @param {string} path - managed path.
 */
function makeDangling(path) {
  const state = classify(path)
  if (state.kind === 'dangling') return
  if (state.kind === 'real') {
    if ((state.entries ?? 0) > 0) throw new Error(`${path} 里有本地数据，不能直接断开`)
    rmdirSync(path)
  } else if (state.kind === 'linked') {
    removeLink(path)
  } else if (state.kind === 'other') {
    throw new Error(`${path} 既不是目录也不是链接`)
  }
  const empty = join(dirname(path), `.vault-empty-${process.pid}`)
  mkdirSync(empty, { recursive: true })
  symlinkSync(empty, path, 'junction')
  rmdirSync(empty)
}

/**
 * Copy every entry of `from` into `to`, skipping names that already exist.
 * @param {string} from - source directory.
 * @param {string} to - destination directory.
 */
function copyDirectory(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const source = join(from, entry)
    const target = join(to, entry)
    if (existsSync(target)) continue
    cpSync(source, target, { recursive: true })
  }
}

/**
 * Migrate one local directory into the vault and leave a junction behind.
 *
 * Copy first, touch nothing until the copy succeeded, then swap the directory
 * for a link. A failure at any step leaves the local directory intact, so the
 * data can never be split between the two locations.
 * @param {string} local - local directory.
 * @param {string} remote - vault directory.
 */
function migrateDirectory(local, remote) {
  copyDirectory(local, remote)
  const parked = `${local}.vault-migrating`
  rmSync(parked, { recursive: true, force: true })
  renameSync(local, parked)
  try {
    symlinkSync(remote, local, 'junction')
  } catch (error) {
    renameSync(parked, local)
    throw error
  }
  rmSync(parked, { recursive: true, force: true })
}

/**
 * Find a vault on any mounted drive.
 * @returns {string | undefined} absolute vault path, when one is present.
 */
export function findVault() {
  // The folder the user picked last wins, even on another drive letter.
  try {
    const recorded = JSON.parse(readFileSync(join(dshHome(), HOME_MARKER), 'utf8'))?.vault
    if (typeof recorded === 'string' && existsSync(join(recorded, MARKER))) return resolve(recorded)
  } catch {
    // No record yet, or it is unreadable: fall through to the scan.
  }
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\${VAULT_DIR}`
    if (existsSync(join(root, MARKER))) return root
  }
  return undefined
}

/**
 * Prepare a vault directory on a drive.
 * @param {string} drive - drive letter such as `F:`.
 * @returns {string} absolute vault path.
 */
export function prepareVault(target) {
  // Accept either a bare drive letter ("F:") or any absolute folder.
  const root = /^[A-Za-z]:$/.test(target) ? join(`${target}\\`, VAULT_DIR) : resolve(target)
  mkdirSync(root, { recursive: true })
  for (const name of MANAGED) mkdirSync(join(root, name), { recursive: true })
  const marker = join(root, MARKER)
  if (!existsSync(marker)) {
    writeFileSync(marker, `${JSON.stringify({ version: 1, createdAt: new Date().toISOString() }, null, 2)}\n`)
  }
  return root
}

/**
 * Point every managed directory at the vault, moving local data in once.
 * @param {string} home - harness home.
 * @param {string} vault - vault root.
 * @returns {{moved: string[], linked: string[], conflicts: string[]}} outcome.
 */
export function syncToVault(home, vault) {
  const moved = []
  const linked = []
  const conflicts = []
  const failed = []
  mkdirSync(vault, { recursive: true })
  for (const name of MANAGED) {
    const local = join(home, name)
    const remote = join(vault, name)
    try {
      mkdirSync(remote, { recursive: true })
      const state = classify(local)
      if (state.kind === 'real' && (state.entries ?? 0) > 0) {
        if (readdirSync(remote).length > 0) {
          conflicts.push(`${name}: 本机和随身盘都有数据，已保留本机`)
          continue
        }
        migrateDirectory(local, remote)
        linkTo(local, remote)
        moved.push(name)
        continue
      }
      if (state.kind === 'linked' && state.target === remote) {
        linked.push(name)
        continue
      }
      linkTo(local, remote)
      linked.push(name)
    } catch (error) {
      // A busy directory must never abort startup or hide the others.
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    writeFileSync(join(home, HOME_MARKER), `${JSON.stringify({ vault, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  } catch {
    // Bookkeeping only.
  }
  return { moved, linked, conflicts, failed }
}

/**
 * Detach every managed directory: no reads, no writes, no local residue.
 * @param {string} home - harness home.
 * @returns {string[]} managed names now dangling.
 */
export function detachAll(home) {
  const done = []
  for (const name of MANAGED) {
    makeDangling(join(home, name))
    done.push(name)
  }
  return done
}

/** Registry value that tells Windows to grant symlink creation to users. */
const DEV_MODE_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock'

/**
 * Read whether Developer Mode is enabled.
 * @returns {boolean} whether the policy value is 1.
 */
export function developerModeEnabled() {
  try {
    const out = execFileSync('reg', ['query', DEV_MODE_KEY, '/v', 'AllowDevelopmentWithoutDevLicense'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10000,
    })
    return /AllowDevelopmentWithoutDevLicense\s+REG_DWORD\s+0x1/i.test(out)
  } catch {
    return false
  }
}

/**
 * Try to create a file symlink, which is exactly what per-session mounting
 * needs. Returns the raw failure so the UI can show real evidence.
 * @returns {{ok: boolean, code?: string, message?: string, developerMode: boolean}} probe.
 */
export function symlinkProbe() {
  const developerMode = developerModeEnabled()
  const base = join(tmpdir(), `vault-probe-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(base, { recursive: true })
    const target = join(base, 'target.txt')
    writeFileSync(target, 'probe')
    symlinkSync(target, join(base, 'link.txt'), 'file')
    return { ok: true, developerMode }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
      developerMode,
    }
  } finally {
    try {
      rmSync(base, { recursive: true, force: true })
    } catch {
      // Probe leftovers are harmless.
    }
  }
}

/**
 * Ask Windows to enable Developer Mode through one elevated confirmation.
 * @returns {{ok: boolean, message: string, probe: object}} outcome after a re-probe.
 */
export function enableDeveloperMode() {
  const script = [
    `New-Item -Path '${DEV_MODE_KEY}' -Force | Out-Null`,
    `New-ItemProperty -Path '${DEV_MODE_KEY}' -Name AllowDevelopmentWithoutDevLicense -Value 1 -PropertyType DWord -Force | Out-Null`,
  ].join('; ')
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-NonInteractive','-Command',${JSON.stringify(script)}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000 },
    )
  } catch (error) {
    return {
      ok: false,
      message: `没有获得管理员确认：${error instanceof Error ? error.message : String(error)}`,
      probe: symlinkProbe(),
    }
  }
  const probe = symlinkProbe()
  return {
    ok: probe.ok,
    message: probe.ok ? '权限已就绪。' : '已写入设置，但当前进程还拿不到权限；请注销或重启一次 Windows。',
    probe,
  }
}

/**
 * Current state, for the settings page and for diagnostics.
 * @param {string} home - harness home.
 * @returns {object} status payload.
 */
export function statusOf(home) {
  return {
    home,
    vault: findVault() ?? null,
    items: MANAGED.map((name) => ({ name, ...classify(join(home, name)) })),
  }
}

/**
 * Whether this plugin is still listed in the profile manifest. Used to tell an
 * uninstall (clean up) from an ordinary application quit (leave everything).
 * @returns {boolean} true when installed or unknowable.
 */
export function bundleInstalled() {
  const root = join(dshHome(), 'profiles')
  let candidates = []
  try {
    candidates = readdirSync(root).map((name) => join(root, name, 'package.json'))
  } catch {
    return true
  }
  let parsed = 0
  for (const manifest of candidates) {
    try {
      const bundles = JSON.parse(readFileSync(manifest, 'utf8'))?.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) continue
      parsed += 1
      if (bundles.includes('dsh-session-vault')) return true
    } catch {
      // A profile without a readable manifest tells us nothing.
    }
  }
  // Only claim "uninstalled" when at least one manifest was read.
  return parsed === 0
}

/**
 * Point the managed directories at a vault without ever moving local data.
 * Directories that still hold data stay untouched until the user asks.
 * @param {string} home - harness home.
 * @returns {{vault: string | null, linked: string[], skipped: string[]}} outcome.
 */
export function autoLink(home) {
  const vault = findVault()
  if (vault === undefined) return { vault: null, linked: [], skipped: [] }
  const linked = []
  const skipped = []
  for (const name of MANAGED) {
    const local = join(home, name)
    const remote = join(vault, name)
    try {
      mkdirSync(remote, { recursive: true })
      const state = classify(local)
      if (state.kind === 'real' && (state.entries ?? 0) > 0) {
        skipped.push(name)
        continue
      }
      linkTo(local, remote)
      linked.push(name)
    } catch {
      skipped.push(name)
    }
  }
  return { vault, linked, skipped }
}

/**
 * Copy local data into the vault, then leave a junction. User-initiated.
 * @param {string} home - harness home.
 * @param {string} vault - vault root.
 * @returns {string[]} steps.
 */
export function moveToVault(home, vault) {
  const steps = []
  for (const name of MANAGED) {
    const local = join(home, name)
    const remote = join(vault, name)
    const state = classify(local)
    try {
      mkdirSync(remote, { recursive: true })
      if (state.kind === 'real' && (state.entries ?? 0) > 0) {
        migrateDirectory(local, remote)
        steps.push(`${name}: 已搬到随身盘`)
      } else if (state.kind === 'linked' && state.target === remote) {
        steps.push(`${name}: 已在随身盘`)
      } else {
        linkTo(local, remote)
        steps.push(`${name}: 已指向随身盘`)
      }
    } catch (error) {
      steps.push(`${name}: 失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  return steps
}

/**
 * Copy the vault back to local directories and drop the junctions.
 * @param {string} home - harness home.
 * @returns {string[]} steps.
 */
export function restoreAll(home, vault = findVault()) {
  const steps = []
  for (const name of MANAGED) {
    const local = join(home, name)
    const state = classify(local)
    if (state.kind === 'real') {
      steps.push(`${name}: 已经是本地目录`)
      continue
    }
    const source = vault === undefined ? undefined : join(vault, name)
    try {
      if (state.kind === 'linked' || state.kind === 'dangling') removeLink(local)
      mkdirSync(local, { recursive: true })
      if (source !== undefined && existsSync(source)) {
        copyDirectory(source, local)
        steps.push(`${name}: 已复制回本机`)
      } else {
        steps.push(`${name}: 已恢复为空目录`)
      }
    } catch (error) {
      steps.push(`${name}: 失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  return steps
}

/**
 * Handle `/vault ...`.
 * @param {string} home - harness home.
 * @param {string} raw - command input.
 * @returns {{kind: string, text: string}} result.
 */
export function handleCommand(home, raw) {
  const [action, argument] = raw.trim().split(/\s+/).filter(Boolean)
  try {
    if (action === undefined || action === 'status') {
      return { kind: 'success', text: JSON.stringify(statusOf(home)) }
    }
    if (action === 'prepare') {
      if (argument === undefined) throw new Error('prepare 需要一个文件夹路径，例如 F:\\我的随身盘')
      const created = prepareVault(argument)
      return { kind: 'success', text: created }
    }
    if (action === 'attach') {
      const vault = argument === undefined ? findVault() : prepareVault(argument)
      if (vault === undefined) throw new Error('没有找到随身盘')
      const outcome = syncToVault(home, vault)
      return { kind: 'success', text: JSON.stringify(outcome) }
    }
    if (action === 'eject') {
      return { kind: 'success', text: detachAll(home).join(', ') }
    }
    if (action === 'move') {
      const vault = findVault()
      if (vault === undefined) throw new Error('没有找到随身盘')
      return { kind: 'success', text: moveToVault(home, vault).join('\n') }
    }
    if (action === 'restore') {
      return { kind: 'success', text: restoreAll(home).join('\n') }
    }
    if (action === 'permission') {
      return { kind: 'success', text: JSON.stringify(symlinkProbe()) }
    }
    if (action === 'enable') {
      return { kind: 'success', text: JSON.stringify(enableDeveloperMode()) }
    }
    throw new Error(`未知操作：${action}`)
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Apply the vault policy once at startup, before any Session is opened.
 * @param {string} home - harness home.
 * @returns {object} what happened.
 */
export function syncAtBoot(home) {
  const vault = findVault()
  if (vault !== undefined) {
    const outcome = syncToVault(home, vault)
    return { vault, ...outcome }
  }
  let detached = []
  try {
    detached = detachAll(home)
  } catch {
    // A local directory may still hold data; keep it rather than hide it.
  }
  return { vault: null, detached }
}

/**
 * Register the command and apply the vault policy.
 * @param ctx - owning plugin context.
 */
export function apply(ctx) {
  const home = dshHome()
  // Startup only redirects; it never moves data between locations.
  try {
    autoLink(home)
  } catch (error) {
    console.warn('session-vault: startup link failed', error)
  }
  // On uninstall (but not on application quit) leave the profile as we found it.
  ctx.effect(() => () => {
    // Wait a moment: the profile manifest is rewritten around the same time the
    // plugin is unloaded. A plain application quit exits before the timer runs,
    // so quitting never copies anything.
    const timer = setTimeout(() => {
      try {
        if (!bundleInstalled()) restoreAll(home)
      } catch (error) {
        console.warn('session-vault: uninstall cleanup failed', error)
      }
    }, 3000)
    timer.unref?.()
  }, 'session-vault uninstall cleanup')

  ctx.commands.register({
    name: 'vault',
    description: '随身盘：从 U 盘读取对话记录，本机不留副本',
    input: { hint: 'status | prepare <drive> | attach [drive] | eject' },
    handler: (invocation) => handleCommand(home, invocation?.rawInput ?? ''),
  })
}

/** Test seam. */
export const __internals = {
  MANAGED,
  MARKER,
  VAULT_DIR,
  classify,
  detachAll,
  findVault,
  handleCommand,
  prepareVault,
  statusOf,
  syncAtBoot,
  syncToVault,
}
