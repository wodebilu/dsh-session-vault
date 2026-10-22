/**
 * Session Vault — Host half.
 *
 * Job:
 *   1. Remember which folder DSH should read its conversations from.
 *   2. Keep that folder a *usable* library, not just a directory.
 *   3. Copy sessions between the local library and the chosen folder, on demand.
 *
 * Why the guard exists:
 *   The first version could switch DSH to a folder that had no Workspace index.
 *   DSH then had no Workspace and no Session, and the only route back — the
 *   `/vault` command — needs an open Session. That is a deadlock in which the
 *   repair button requires the thing it repairs. Three rules now prevent it:
 *     - a chosen folder is seeded with a valid index before it is ever used;
 *     - the Loader patch refuses an unusable custom library at boot;
 *     - a panic file and a recovery script work without any Session at all.
 *
 * Copy rules — the whole safety story:
 *   - the source is only ever read, never renamed, moved or deleted;
 *   - an existing target file is never overwritten;
 *   - every copy goes to a `.copying` sibling first and is renamed only after
 *     the source size is proven stable across the copy;
 *   - the target's Workspace index is repaired, never replaced: every Workspace
 *     stays in `global.workspaceIds`, duplicate paths are merged, and the
 *     default Workspace is always one that exists.
 *
 *   /vault status              -> current state as JSON
 *   /vault check               -> state plus a library diagnosis
 *   /vault default             -> use the ordinary local folders
 *   /vault custom <b64:path>   -> use that folder (USB stick, SSD, anything)
 *   /vault target <b64:path>   -> remember a copy target without switching mode
 *   /vault push                -> copy local sessions into the chosen folder
 *   /vault pull                -> copy the chosen folder's sessions back home
 *   /vault repair              -> normalize the chosen folder's Workspace index
 *   /vault drift               -> report workspaces whose drive letter moved
 *   /vault drift-fix <b64>     -> repair that drift (needs {confirm:true})
 */
import { applyRepairPlan, autoRepairVault, buildRepairPlan } from './lib/drift-repair.mjs'
import { listDrives } from './lib/drive-drift.mjs'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import {
  copyStorage,
  deleteSession,
  dropAllBackups,
  dropBackup,
  findSession,
  listBackups,
  relocate,
  restoreBackup,
  sha256,
} from './lib/relocate-core.mjs'

/** Loader entry id used by `cordis.patch.yml`. */
export const name = 'session-vault'

/** Services this plugin cannot work without. */
export const inject = ['commands']

/** Record file, computed exactly like the guard expressions in the patch. */
export const MODE_FILE_NAME = 'session-vault.json'

/** One-line startup trace, so a failed load is diagnosable without the browser. */
export const TRACE_FILE_NAME = 'session-vault-host.log'

/** Boot-decision trace written by the Loader expressions. */
export const BOOT_FILE_NAME = 'session-vault-boot.log'

/** When present, the Loader expressions ignore a custom folder for one boot. */
export const PANIC_FILE_NAME = 'session-vault.panic'

/** Why the last boot fell back from a custom folder. */
export const FALLBACK_FILE_NAME = 'session-vault-fallback.log'

/** A vault is a folder carrying this manifest. */
export const VAULT_FILE_NAME = 'vault.json'

/** Session artifacts, raw or compressed. */
const SESSION_FILE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/

/** Identity of the Workspace index schema. */
const WORKSPACE_UNIT = { name: 'workspace', version: 2 }

/** Session log generation this host half knows how to read and write. */
const SESSION_FORMAT_VERSION = 4

/** Highest Workspace index version this host half knows how to write. */
const WORKSPACE_UNIT_MAX = 2

/**
 * The harness home used to locate the mode record.
 * Mirrors the expression in `cordis.patch.yml`; keep the two in sync.
 * @returns {string} absolute home.
 */
export function homeDirectory() {
  const env = process.env.DSH_HOME
  if (env !== undefined && env.trim() !== '') return resolve(env.trim())
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir !== undefined && profileDir.trim() !== '') {
    // <home>/profiles/<name>
    return resolve(profileDir.trim(), '..', '..')
  }
  return join(homedir(), '.dsh')
}

/**
 * Absolute path of the mode record.
 * @returns {string} mode record path.
 */
export function modeFile() {
  return join(homeDirectory(), MODE_FILE_NAME)
}

/**
 * Absolute path of the panic marker.
 * @returns {string} panic path.
 */
export function panicFile() {
  return join(homeDirectory(), PANIC_FILE_NAME)
}

/** @returns {string} current ISO timestamp. */
function now() {
  return new Date().toISOString()
}

/**
 * Whether a path is an existing directory.
 * @param {string} path - candidate.
 * @returns {boolean} true when it is a directory.
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Read a directory, treating an unreadable one as empty.
 * @param {string} path - directory.
 * @returns {string[]} entry names.
 */
function list(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Read JSON, tolerating a UTF-8 BOM and every read/parse failure.
 * @param {string} path - file.
 * @returns {any | null} parsed value, or null.
 */
function readJson(path) {
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Write JSON through a temporary sibling. Existing files get a `.bak` courtesy
 * copy of the previous bytes; the real file only changes on a successful rename.
 * @param {string} target - destination file.
 * @param {any} value - JSON value.
 * @param {boolean} backup - write `<target>.bak` first.
 */
function writeJsonAtomic(target, value, backup) {
  mkdirSync(dirname(target), { recursive: true })
  if (backup && existsSync(target)) {
    try {
      writeFileSync(`${target}.bak`, readFileSync(target))
    } catch {
      // A backup is a courtesy, not a precondition.
    }
  }
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
}

/**
 * Append one line, never failing the caller.
 * @param {string} file - log file.
 * @param {string} line - text without a trailing newline.
 */
function appendLine(file, line) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${line}\n`, { encoding: 'utf8', flag: 'a' })
  } catch {
    // Diagnostics must never break a boot.
  }
}

/**
 * Canonical comparison key for a folder path.
 * @param {string} path - folder.
 * @returns {string} comparison key.
 */
function pathKey(path) {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Read the recorded mode. Anything unreadable means "default".
 * @returns {{mode: string, path?: string, updatedAt?: string}} recorded mode.
 */
export function readMode() {
  const parsed = readJson(modeFile())
  if (parsed !== null && typeof parsed === 'object') {
    const mode = parsed.mode === 'custom' ? 'custom' : 'default'
    const path = typeof parsed.path === 'string' && parsed.path !== '' ? resolve(parsed.path) : undefined
    return { mode, path, updatedAt: parsed.updatedAt }
  }
  return { mode: 'default' }
}

/**
 * Write the mode record through a temporary sibling.
 * @param {object} record - mode record.
 */
function writeMode(record) {
  const target = modeFile()
  mkdirSync(homeDirectory(), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(
    temporary,
    `${JSON.stringify({ ...record, updatedAt: now() }, null, 2)}\n`,
    'utf8',
  )
  renameSync(temporary, target)
}

/**
 * Read the vault manifest of a folder.
 * @param {string} root - vault root.
 * @returns {{format: number, id: string, createdAt?: string, updatedAt?: string} | null} manifest.
 */
export function readManifest(root) {
  const value = readJson(join(root, VAULT_FILE_NAME))
  if (value === null || typeof value !== 'object') return null
  if (value.format !== 1 || typeof value.id !== 'string') return null
  return value
}

/**
 * Diagnose a candidate library.
 *
 * `ok` means DSH can boot into it and show at least one Workspace. `needsRepair`
 * means it boots but its index has orphan Workspaces, duplicate paths or a bad
 * default, all of which the host half can normalize without touching a Session.
 * @param {string} root - candidate library root.
 * @returns {object} diagnosis.
 */
export function inspectLibrary(root) {
  const absolute = resolve(root)
  if (!isDirectory(absolute)) return { ok: false, reason: 'folder-missing', root: absolute }
  if (!isDirectory(join(absolute, 'sessions'))) {
    return { ok: false, reason: 'sessions-missing', root: absolute }
  }
  const wsFile = join(absolute, 'storages', 'workspace.json')
  if (!existsSync(wsFile)) return { ok: false, reason: 'index-missing', root: absolute, wsFile }
  const index = readJson(wsFile)
  if (index === null || typeof index !== 'object') {
    return { ok: false, reason: 'index-unreadable', root: absolute, wsFile }
  }
  const tables = index?.tables?.workspaces
  if (tables === null || typeof tables !== 'object') {
    return { ok: false, reason: 'index-no-workspaces', root: absolute, wsFile, index }
  }
  const tableIds = Object.keys(tables)
  if (tableIds.length === 0) {
    return { ok: false, reason: 'index-empty', root: absolute, wsFile, index }
  }
  const listed = Array.isArray(index?.global?.workspaceIds)
    ? index.global.workspaceIds.filter((id) => tables[id] !== undefined)
    : []
  if (listed.length === 0) {
    return { ok: false, reason: 'index-unlisted', root: absolute, wsFile, index }
  }
  const missing = tableIds.filter((id) => !listed.includes(id))
  const seen = new Set()
  const duplicates = []
  for (const [id, workspace] of Object.entries(tables)) {
    const path = typeof workspace?.path === 'string' ? pathKey(workspace.path) : `id:${id}`
    if (seen.has(path)) duplicates.push(id)
    else seen.add(path)
  }
  const defaultId = index?.global?.defaultWorkspaceId
  const defaultOk = typeof defaultId === 'string' && tables[defaultId] !== undefined
  return {
    ok: true,
    reason: 'ok',
    root: absolute,
    wsFile,
    index,
    tableIds,
    visible: listed,
    needsRepair: missing.length > 0 || duplicates.length > 0 || !defaultOk,
    missing,
    duplicates,
    defaultOk,
  }
}

/**
 * One DSH at a time per library: this file names the process that owns it.
 * It lives in the library, so it travels with the drive.
 */
export const LOCK_FILE_NAME = '.dsh-session-vault.lock'

/** Local diagnostics the cleanup command may remove. Nothing else is touched. */
const LOCAL_LOG_FILES = [
  'session-vault-host.log',
  'session-vault-boot.log',
  'session-vault-fallback.log',
]

/** @param {string} root - library root. @returns {string} absolute lock path. */
export function lockFile(root) {
  return join(resolve(root), LOCK_FILE_NAME)
}

/**
 * Whether a pid is a live process on this machine.
 * `EPERM` means it exists but belongs to someone else, which still counts.
 * @param {number} pid - process id.
 * @returns {boolean} true when alive.
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Read the lock of a library without judging it.
 * @param {string} root - library root.
 * @returns {object | null} lock record plus liveness, or null.
 */
export function readLock(root) {
  const value = readJson(lockFile(root))
  if (value === null || typeof value !== 'object' || !Number.isInteger(value.pid)) return null
  return {
    pid: value.pid,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    host: typeof value.host === 'string' ? value.host : null,
    alive: isProcessAlive(value.pid),
  }
}

/**
 * Take the library lock for this process, or report who already holds it.
 * A lock left behind by a dead process is replaced, so a crash cannot wedge the
 * library.
 * @param {string} root - library root.
 * @param {object} [options] - pid override, for tests.
 * @returns {{held: boolean, mine: boolean, holder: object | null, file: string}} outcome.
 */
export function acquireVaultLock(root, options = {}) {
  const file = lockFile(root)
  const me = Number.isInteger(options.pid) ? options.pid : process.pid
  const existing = readLock(root)
  if (existing !== null && existing.pid !== me && existing.alive) {
    return { held: true, mine: false, holder: existing, file }
  }
  const record = {
    pid: me,
    startedAt: now(),
    host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown',
  }
  try {
    writeJsonAtomic(file, record, false)
  } catch {
    // A read-only or unplugged library is not a reason to fail the boot; the
    // lock is an advisory guard, and the caller sees `held: false`.
    return { held: false, mine: false, holder: existing, file }
  }
  return { held: true, mine: true, holder: { ...record, alive: true }, file }
}

/**
 * Release the lock when this process owns it.
 * @param {string} root - library root.
 * @param {object} [options] - pid override, for tests.
 * @returns {boolean} true when a lock was removed.
 */
export function releaseVaultLock(root, options = {}) {
  const me = Number.isInteger(options.pid) ? options.pid : process.pid
  const existing = readLock(root)
  if (existing === null || existing.pid !== me) return false
  rmSync(lockFile(root), { force: true })
  return true
}

/**
 * Remove the plugin's own logs from the harness home. Credentials, the profile,
 * the mode record and the recovery scripts are never in this list.
 * @returns {{removed: object[], bytes: number, home: string}} what went away.
 */
export function cleanupLogs() {
  const home = homeDirectory()
  const removed = []
  let bytes = 0
  for (const name of LOCAL_LOG_FILES) {
    const file = join(home, name)
    try {
      if (!existsSync(file)) continue
      const size = statSync(file).size
      rmSync(file, { force: true })
      removed.push({ file, size })
      bytes += size
    } catch {
      // A log we cannot remove is not worth failing the command over.
    }
  }
  return { removed, bytes, home }
}

/**
 * Current, effective state for the panel.
 * @returns {object} status payload.
 */
export function status() {
  const recorded = readMode()
  const requested = typeof recorded.path === 'string' ? recorded.path : null
  const available = requested !== null && isDirectory(requested)
  const library = available
    ? inspectLibrary(requested)
    : { ok: false, reason: requested === null ? 'not-chosen' : 'folder-missing', needsRepair: false }
  const usable = library.ok === true
  const active = recorded.mode === 'custom' && available && usable ? requested : homeDirectory()
  const effective = pathKey(active) === pathKey(homeDirectory()) ? 'default' : 'custom'
  const vault = requested !== null && available ? readManifest(requested) : null
  return {
    mode: recorded.mode,
    effective,
    requested,
    available,
    usable,
    reason: library.reason,
    degraded: recorded.mode === 'custom' && !(available && usable),
    needsRepair: library.needsRepair === true,
    panic: existsSync(panicFile()),
    root: active,
    sessions: join(active, 'sessions'),
    storages: join(active, 'storages'),
    attachments: join(active, 'attachments', 'v1'),
    home: homeDirectory(),
    modeFile: modeFile(),
    vault: vault === null ? null : { id: vault.id, createdAt: vault.createdAt ?? null },
    lock: (() => {
      const held = readLock(active)
      return held === null ? null : { ...held, mine: held.pid === process.pid }
    })(),
    updatedAt: recorded.updatedAt ?? null,
  }
}

/**
 * Refuse a write when another live DSH process owns the library. Two instances
 * appending to one library diverge; this is the only place that can say so.
 * @param {string} action - operation name, for the message.
 * @returns {object} status whose lock is free or ours.
 */
function requireVaultFree(action) {
  const state = status()
  const lock = state.lock
  if (lock === null || lock.pid === process.pid || lock.alive === false) return state
  throw new Error(
    `${action} 已拒绝：另一个 DSH 进程（pid ${lock.pid}${lock.host === null ? '' : `，${lock.host}`}）正在使用这个库。` +
      '同一个库同时只能被一个 DSH 写入；请关掉另一个窗口后再试。',
  )
}

/**
 * Every Session log generation present in a library.
 * @param {string} root - library root.
 * @returns {number[]} sorted generation numbers.
 */
function logGenerations(root) {
  const found = new Set()
  for (const project of list(join(root, 'sessions'))) {
    const projectDir = join(root, 'sessions', project)
    if (!isDirectory(projectDir)) continue
    for (const session of list(projectDir)) {
      const sessionDir = join(projectDir, session)
      if (!isDirectory(sessionDir)) continue
      for (const file of list(sessionDir)) {
        const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(file)
        if (match !== null) found.add(Number(match[1]))
      }
    }
  }
  return [...found].sort((left, right) => left - right)
}

/**
 * Compare the formats a library already carries with the formats this host half
 * writes. A build newer than the plugin must fail loudly, not write an index the
 * new DSH cannot read; older generations are left to DSH's own upgrade path.
 * @param {string} [root] - library root, defaults to the effective one.
 * @returns {object} compatibility report.
 */
export function capability(root) {
  const library = resolve(typeof root === 'string' && root !== '' ? root : status().root)
  const unitVersion = readJson(join(library, 'storages', 'workspace.json'))?.unit?.version
  const unit = typeof unitVersion === 'number' ? unitVersion : null
  const generations = logGenerations(library)
  const blocking = []
  if (unit !== null && unit > WORKSPACE_UNIT_MAX) {
    blocking.push(`工作区索引版本 ${unit}（本插件最高支持 ${WORKSPACE_UNIT_MAX}）`)
  }
  for (const generation of generations) {
    if (generation > SESSION_FORMAT_VERSION) {
      blocking.push(`会话日志 v${generation}（本插件最高支持 v${SESSION_FORMAT_VERSION}）`)
    }
  }
  return {
    library,
    ok: blocking.length === 0,
    unitVersion: unit,
    logGenerations: generations,
    blocking,
    checked: unit !== null || generations.length > 0,
  }
}

/**
 * Refuse a destructive operation on a library whose format is newer than this
 * build understands.
 * @param {string} action - operation name, for the message.
 * @returns {object} compatibility report.
 */
function requireCompatible(action) {
  const report = capability()
  if (!report.checked || report.ok) return report
  throw new Error(
    `${action} 已拒绝：这个库的格式比插件新（${report.blocking.join('；')}）。` +
      '继续写下去会产出 DSH 读不懂的数据，请先把 dsh-session-vault 升级到匹配的版本。',
  )
}

/**
 * Build a Workspace index that is valid on its own.
 * Clones the Workspaces currently visible to this DSH, with no Sessions, so the
 * new library opens to a usable folder list instead of an empty void.
 * @param {string} target - library being seeded.
 * @returns {{workspaces: number, defaultWorkspaceId: string}} summary.
 */
function seedIndex(target) {
  const current = status()
  let sourceRoot = current.root
  if (pathKey(sourceRoot) === pathKey(target)) {
    // Repairing the active custom library: the local index still knows the
    // Workspaces that were cloned when the vault was created.
    sourceRoot = homeDirectory()
  }
  let source = null
  if (pathKey(sourceRoot) !== pathKey(target)) {
    const inspected = inspectLibrary(sourceRoot)
    if (inspected.ok) source = inspected.index
  }

  const workspaces = {}
  const ids = []
  const workspaceIdsOf = (index) => {
    const tables = index?.tables?.workspaces ?? {}
    const listed = Array.isArray(index?.global?.workspaceIds) ? index.global.workspaceIds : []
    const ordered = listed.filter((id) => tables[id] !== undefined)
    for (const id of Object.keys(tables)) if (!ordered.includes(id)) ordered.push(id)
    return ordered
  }

  if (source !== null) {
    for (const id of workspaceIdsOf(source)) {
      const workspace = source?.tables?.workspaces?.[id]
      if (workspace === undefined || typeof workspace?.path !== 'string') continue
      const nextId = workspaces[id] === undefined ? id : randomUUID()
      workspaces[nextId] = {
        path: resolve(workspace.path),
        title: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : basename(workspace.path),
        sessionIds: [],
        createdAt: typeof workspace.createdAt === 'string' ? workspace.createdAt : now(),
        updatedAt: now(),
      }
      ids.push(nextId)
    }
  }

  if (ids.length === 0) {
    // No local index yet (fresh install): give the vault a portable Workspace
    // of its own, so a Session can always be created there.
    const portable = join(resolve(target), 'workspace')
    mkdirSync(portable, { recursive: true })
    const id = randomUUID()
    workspaces[id] = {
      path: portable,
      title: 'Vault workspace',
      sessionIds: [],
      createdAt: now(),
      updatedAt: now(),
    }
    ids.push(id)
  }

  const sourceDefault = source?.global?.defaultWorkspaceId
  const defaultWorkspaceId =
    typeof sourceDefault === 'string' && workspaces[sourceDefault] !== undefined
      ? sourceDefault
      : ids[0]

  writeJsonAtomic(
    join(target, 'storages', 'workspace.json'),
    {
      unit: source?.unit ?? WORKSPACE_UNIT,
      global: {
        initialized: true,
        workspaceIds: ids,
        archivedSessionIds: [],
        pinnedSessionIds: [],
        defaultWorkspaceId,
      },
      tables: { workspaces },
    },
    true,
  )
  return { workspaces: ids.length, defaultWorkspaceId }
}

/**
 * Normalize a Workspace index in place: merge Workspaces that point at the same
 * canonical folder, list every remaining Workspace, and repair the default.
 * Sessions are never read, renamed or removed by this operation.
 * @param {string} root - library root.
 * @returns {object} repair summary.
 */
export function repairLibrary(root) {
  const absolute = resolve(root)
  const wsFile = join(absolute, 'storages', 'workspace.json')
  const index = readJson(wsFile)
  if (index === null || typeof index !== 'object') {
    throw new Error(`没有可修复的工作区索引：${wsFile}`)
  }
  const tables = index?.tables?.workspaces
  if (tables === null || typeof tables !== 'object') {
    throw new Error('工作区索引里没有 workspaces 表，无法修复')
  }

  const deduped = {}
  const remap = new Map()
  const byPath = new Map()
  for (const [id, workspace] of Object.entries(tables)) {
    const path = typeof workspace?.path === 'string' ? resolve(workspace.path) : null
    const key = path === null ? `id:${id}` : pathKey(path)
    const existing = byPath.get(key)
    if (existing !== undefined) {
      const keep = deduped[existing]
      const merged = new Set([...(keep.sessionIds ?? []), ...(workspace?.sessionIds ?? [])])
      keep.sessionIds = [...merged]
      keep.updatedAt = now()
      remap.set(id, existing)
      continue
    }
    byPath.set(key, id)
    deduped[id] = {
      ...workspace,
      path: path ?? workspace.path,
      sessionIds: [...new Set(workspace?.sessionIds ?? [])],
    }
  }

  const listed = Array.isArray(index?.global?.workspaceIds) ? index.global.workspaceIds : []
  const ids = []
  for (const id of listed) {
    const mapped = remap.get(id) ?? id
    if (deduped[mapped] !== undefined && !ids.includes(mapped)) ids.push(mapped)
  }
  for (const id of Object.keys(deduped)) if (!ids.includes(id)) ids.push(id)

  const rawDefault = index?.global?.defaultWorkspaceId
  const mappedDefault = remap.get(rawDefault) ?? rawDefault
  const defaultWorkspaceId =
    typeof mappedDefault === 'string' && deduped[mappedDefault] !== undefined
      ? mappedDefault
      : ids[0] ?? null

  const archivedSource = Array.isArray(index?.global?.archivedSessionIds)
    ? index.global.archivedSessionIds
    : []
  const pinnedSource = Array.isArray(index?.global?.pinnedSessionIds)
    ? index.global.pinnedSessionIds
    : []
  const next = {
    unit: index.unit ?? WORKSPACE_UNIT,
    // Spread first: DSH keeps a `pendingMutation` crash marker in `global`, and
    // a repair must not silently drop it.
    global: {
      ...(index.global ?? {}),
      initialized: true,
      workspaceIds: ids,
      archivedSessionIds: [...new Set(archivedSource.map(String))],
      pinnedSessionIds: [...new Set(pinnedSource.map(String))],
      defaultWorkspaceId,
    },
    tables: { workspaces: deduped },
  }
  writeJsonAtomic(wsFile, next, true)
  return {
    root: absolute,
    workspaces: ids.length,
    merged: remap.size,
    addedToList: ids.filter((id) => !listed.includes(id)).length,
    defaultWorkspaceId,
  }
}

/**
 * Read the first record of a session log, tolerating raw and zstd formats.
 * @param {string} file - session log.
 * @returns {{id?: string, cwd?: string} | null} header, or null.
 */
function readSessionHeader(file) {
  try {
    const raw = readFileSync(file)
    const text = file.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
    const first = text.split('\n', 1)[0]
    const row = JSON.parse(first)
    if (row !== null && typeof row === 'object' && row.type === 'session') {
      return { id: row.id, cwd: row.cwd }
    }
  } catch {
    // A log we cannot read is left for the next repair; never guess its cwd.
  }
  return null
}

/**
 * Give every Session file in a library a Workspace home.
 *
 * `workspace.sessionIds` is the only list DSH's sidebar reads. A log that was
 * copied or dropped into `sessions/` without an index entry is therefore
 * invisible: the file exists, but no Workspace owns it. This scans the tree,
 * reads each orphan's `cwd`, and attaches it to the Workspace with that path
 * (creating one when needed). Logs with no readable header go to a portable
 * `Recovered sessions` Workspace, so nothing stays invisible.
 * @param {string} root - library root.
 * @returns {{adopted: number, created: number, skipped: number}} summary.
 */
export function adoptOrphans(root) {
  const absolute = resolve(root)
  const wsFile = join(absolute, 'storages', 'workspace.json')
  const index = readJson(wsFile)
  if (index === null || typeof index !== 'object') {
    return { adopted: 0, created: 0, skipped: 0 }
  }
  const tables = index?.tables?.workspaces
  if (tables === null || typeof tables !== 'object') {
    return { adopted: 0, created: 0, skipped: 0 }
  }

  const owned = new Set()
  for (const workspace of Object.values(tables)) {
    for (const sessionId of workspace?.sessionIds ?? []) owned.add(sessionId)
  }
  const byPath = new Map()
  for (const [id, workspace] of Object.entries(tables)) {
    if (typeof workspace?.path === 'string') byPath.set(pathKey(workspace.path), id)
  }

  const orphans = []
  for (const project of list(join(absolute, 'sessions'))) {
    const projectDir = join(absolute, 'sessions', project)
    if (!isDirectory(projectDir)) continue
    for (const session of list(projectDir)) {
      if (owned.has(session)) continue
      const sessionDir = join(projectDir, session)
      if (!isDirectory(sessionDir)) continue
      const file = list(sessionDir).find((name) => SESSION_FILE.test(name))
      if (file === undefined) continue
      const header = readSessionHeader(join(sessionDir, file))
      orphans.push({
        id: session,
        cwd: typeof header?.cwd === 'string' && header.cwd !== '' ? resolve(header.cwd) : null,
      })
    }
  }
  if (orphans.length === 0) return { adopted: 0, created: 0, skipped: 0 }

  let adopted = 0
  let created = 0
  for (const orphan of orphans) {
    const portable = join(absolute, 'workspace')
    const desiredPath = orphan.cwd ?? portable
    let workspaceId = byPath.get(pathKey(desiredPath))
    if (workspaceId === undefined) {
      if (orphan.cwd === null) mkdirSync(portable, { recursive: true })
      workspaceId = randomUUID()
      tables[workspaceId] = {
        path: desiredPath,
        title: orphan.cwd === null ? 'Recovered sessions' : basename(orphan.cwd),
        sessionIds: [],
        createdAt: now(),
        updatedAt: now(),
      }
      byPath.set(pathKey(desiredPath), workspaceId)
      created += 1
    }
    const workspace = tables[workspaceId]
    workspace.sessionIds = workspace.sessionIds ?? []
    if (!workspace.sessionIds.includes(orphan.id)) {
      workspace.sessionIds.push(orphan.id)
      adopted += 1
    }
    workspace.updatedAt = now()
    owned.add(orphan.id)
  }

  const listed = Array.isArray(index?.global?.workspaceIds)
    ? index.global.workspaceIds.filter((id) => tables[id] !== undefined)
    : []
  for (const id of Object.keys(tables)) if (!listed.includes(id)) listed.push(id)
  index.global = index.global ?? {}
  index.global.initialized = true
  index.global.workspaceIds = listed
  if (tables[index.global.defaultWorkspaceId] === undefined) {
    index.global.defaultWorkspaceId = listed[0] ?? null
  }
  if (!Array.isArray(index.global.archivedSessionIds)) index.global.archivedSessionIds = []
  if (!Array.isArray(index.global.pinnedSessionIds)) index.global.pinnedSessionIds = []
  index.tables = { workspaces: tables }
  index.unit = index.unit ?? WORKSPACE_UNIT
  writeJsonAtomic(wsFile, index, true)
  return { adopted, created, skipped: 0 }
}

/**
 * Prepare a folder to be used as a library.
 * Creates the three roots, writes a vault manifest, and seeds or normalizes the
 * Workspace index before the mode record can point at it.
 * @param {string} target - folder chosen by the user.
 * @returns {object} manifest.
 */
function ensureVault(target) {
  mkdirSync(join(target, 'sessions'), { recursive: true })
  mkdirSync(join(target, 'storages'), { recursive: true })
  mkdirSync(join(target, 'attachments', 'v1'), { recursive: true })

  const manifestFile = join(target, VAULT_FILE_NAME)
  const existing = readManifest(target)
  if (existing === null) {
    const created = { format: 1, id: randomUUID(), createdAt: now(), updatedAt: now() }
    writeJsonAtomic(manifestFile, created, false)
  } else {
    writeJsonAtomic(manifestFile, { ...existing, updatedAt: now() }, false)
  }

  const inspected = inspectLibrary(target)
  if (!inspected.ok) {
    // A parseable but incomplete index is repaired, not replaced: Workspaces
    // and Session membership survive, which matters most when this is the
    // library DSH is already using.
    let repaired = false
    if (inspected.index !== undefined) {
      try {
        repairLibrary(target)
        repaired = inspectLibrary(target).ok
      } catch {
        // Fall through to seeding when the index cannot be normalized.
      }
    }
    if (!repaired) {
      if (
        inspected.reason === 'index-missing' ||
        inspected.reason === 'index-empty' ||
        inspected.reason === 'index-no-workspaces' ||
        inspected.reason === 'index-unlisted' ||
        inspected.reason === 'index-unreadable'
      ) {
        seedIndex(target)
      } else {
        throw new Error(`这个文件夹不能作为会话库：${inspected.reason}`)
      }
    }
  } else if (inspected.needsRepair) {
    repairLibrary(target)
  }
  // A folder may already contain Session logs that no index entry owns. Adopt
  // them before the mode record can point here, so "prepared" means visible.
  adoptOrphans(target)
  return readManifest(target)
}

/**
 * Switch to the ordinary local folders.
 * @returns {object} status after the change.
 */
export function useDefault() {
  // Keep the chosen folder on record: the copy buttons still need to know it.
  const previous = readMode()
  rmSync(panicFile(), { force: true })
  writeMode({ mode: 'default', path: previous.path })
  return status()
}

/**
 * Switch to a folder of the user's choice.
 * The folder is made into a usable library first; if that fails, the mode is not
 * changed, so a failed switch can never strand DSH.
 * @param {string} path - absolute folder.
 * @returns {object} status after the change.
 */
export function useCustom(path) {
  const target = resolve(path)
  if (!isDirectory(target)) throw new Error(`不是已存在的文件夹：${target}`)
  ensureVault(target)
  rmSync(panicFile(), { force: true })
  writeMode({ mode: 'custom', path: target })
  return status()
}

/**
 * Remember a folder for copying without changing which library is active.
 * @param {string} path - absolute folder.
 * @returns {object} status after the change.
 */
export function useTarget(path) {
  const target = resolve(path)
  if (!isDirectory(target)) throw new Error(`不是已存在的文件夹：${target}`)
  const current = readMode()
  writeMode({ mode: current.mode, path: target })
  return status()
}

/**
 * Decode a path carried through the command line (`b64:` keeps spaces intact).
 * @param {string | undefined} token - raw argument.
 * @returns {string | undefined} decoded path.
 */
export function decodePath(token) {
  if (typeof token !== 'string' || token === '') return undefined
  if (!token.startsWith('b64:')) return token
  try {
    return Buffer.from(token.slice(4), 'base64url').toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * The two libraries, named by role rather than by mode, so a copy works no
 * matter which one is currently active.
 * @returns {{local: string, custom: string | null}} absolute roots.
 */
export function roots() {
  const recorded = readMode()
  const custom = typeof recorded.path === 'string' ? recorded.path : null
  return { local: homeDirectory(), custom }
}

/**
 * Copy one file safely.
 *
 * The source is append-only, so any length we read is a valid prefix of the log.
 * The only real hazard is reading while the writer grows the file: the copy may
 * end inside a frame. We copy, then compare the source size before and after —
 * an unchanged size proves we captured one consistent length — and retry once
 * when it moved. The source itself is only ever read.
 * @param {string} from - source file.
 * @param {string} to - destination file.
 * @returns {'copied' | 'exists' | 'empty' | 'unstable'} what happened.
 */
function copyOne(from, to) {
  if (existsSync(to)) return 'exists'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = statSync(from)
    if (before.size === 0) return 'empty'
    mkdirSync(dirname(to), { recursive: true })
    const temporary = `${to}.copying`
    rmSync(temporary, { force: true })
    copyFileSync(from, temporary)
    const after = statSync(from)
    const copied = statSync(temporary)
    if (after.size === before.size && copied.size === before.size) {
      renameSync(temporary, to)
      return 'copied'
    }
    rmSync(temporary, { force: true })
  }
  return 'unstable'
}

/**
 * Walk `<root>/sessions/<project>/<session>/session*.jsonl*` and copy what is
 * missing.
 * @param {string} fromRoot - source root.
 * @param {string} toRoot - target root.
 * @returns {{copied: string[], skipped: Record<string, number>, ids: string[]}} outcome.
 */
function copySessions(fromRoot, toRoot) {
  const copied = []
  const skipped = { exists: 0, empty: 0, unstable: 0 }
  const ids = []
  for (const project of list(join(fromRoot, 'sessions'))) {
    const projectDir = join(fromRoot, 'sessions', project)
    if (!isDirectory(projectDir)) continue
    for (const session of list(projectDir)) {
      const sessionDir = join(projectDir, session)
      if (!isDirectory(sessionDir)) continue
      for (const file of list(sessionDir)) {
        if (!SESSION_FILE.test(file)) continue
        const outcome = copyOne(join(sessionDir, file), join(toRoot, 'sessions', project, session, file))
        if (outcome === 'copied') {
          copied.push(`${project}/${session}`)
          if (!ids.includes(session)) ids.push(session)
        } else {
          skipped[outcome] += 1
        }
      }
    }
  }
  return { copied, skipped, ids }
}

/**
 * Copy the projection cache rows of the Sessions we just copied. The cache is
 * optional for correctness (DSH refolds from the log) but it carries titles.
 * @param {string} fromRoot - source root.
 * @param {string} toRoot - target root.
 * @param {string[]} ids - copied Session ids.
 * @returns {number} rows copied.
 */
function copyProjections(fromRoot, toRoot, ids) {
  let copied = 0
  for (const id of ids) {
    const from = join(fromRoot, 'storages', 'session_projcache', 'sessions', `${id}.json`)
    const to = join(toRoot, 'storages', 'session_projcache', 'sessions', `${id}.json`)
    if (!existsSync(from) || existsSync(to)) continue
    try {
      if (copyOne(from, to) === 'copied') copied += 1
    } catch {
      // The cache is fail-soft; never fail a copy over it.
    }
  }
  return copied
}

/**
 * Merge the copied Sessions into the target Workspace index.
 *
 * Invariants this function establishes, because DSH's sidebar reads them:
 *   - every Workspace in `tables` is also listed in `global.workspaceIds`;
 *   - two Workspaces never point at the same canonical folder;
 *   - a Session belongs to at most one Workspace;
 *   - `defaultWorkspaceId` names a Workspace that exists.
 * It only ever adds or repairs; no Session id is removed from the index.
 * @param {string} fromRoot - source root.
 * @param {string} toRoot - target root.
 * @param {string[]} ids - copied Session ids.
 * @returns {object} index outcome.
 */
function registerInWorkspaces(fromRoot, toRoot, ids) {
  const empty = {
    registered: 0,
    unregistered: ids.length,
    created: false,
    addedWorkspaces: 0,
    mergedWorkspaces: 0,
    repairedWorkspaces: 0,
  }
  if (ids.length === 0) return empty
  const source = readJson(join(fromRoot, 'storages', 'workspace.json'))
  if (source === null || typeof source !== 'object') return empty

  const toFile = join(toRoot, 'storages', 'workspace.json')
  const recorded = readJson(toFile)
  const created = recorded === null || typeof recorded !== 'object'
  const base = created
    ? {
        unit: source.unit ?? WORKSPACE_UNIT,
        global: {
          initialized: true,
          workspaceIds: [],
          archivedSessionIds: [],
          pinnedSessionIds: [],
          defaultWorkspaceId: null,
        },
        tables: { workspaces: {} },
      }
    : recorded
  base.unit = base.unit ?? WORKSPACE_UNIT
  base.global = base.global ?? {}
  base.tables = base.tables ?? {}
  base.tables.workspaces = base.tables.workspaces ?? {}
  const workspaces = base.tables.workspaces

  const byPath = new Map()
  for (const [id, workspace] of Object.entries(workspaces)) {
    if (typeof workspace?.path === 'string') byPath.set(pathKey(workspace.path), id)
  }
  const owner = new Map()
  for (const [id, workspace] of Object.entries(workspaces)) {
    for (const sessionId of workspace?.sessionIds ?? []) owner.set(sessionId, id)
  }

  const wanted = new Set(ids)
  const claimed = new Set()
  const archivedSource = Array.isArray(source?.global?.archivedSessionIds)
    ? source.global.archivedSessionIds
    : []
  const sourceArchived = new Set(archivedSource.map(String))
  let registered = 0
  let addedWorkspaces = 0
  let mergedWorkspaces = 0

  for (const [sourceId, workspace] of Object.entries(source?.tables?.workspaces ?? {})) {
    const sessionIds = (workspace?.sessionIds ?? []).filter((id) => wanted.has(id))
    if (sessionIds.length === 0) continue
    for (const sessionId of sessionIds) claimed.add(sessionId)
    const path = typeof workspace?.path === 'string' ? resolve(workspace.path) : null
    let targetId = path === null ? undefined : byPath.get(pathKey(path))
    if (targetId === undefined) {
      targetId = workspaces[sourceId] === undefined ? sourceId : randomUUID()
      workspaces[targetId] = {
        path: path ?? workspace.path,
        title:
          typeof workspace.title === 'string' && workspace.title !== ''
            ? workspace.title
            : path === null
              ? 'Workspace'
              : basename(path),
        sessionIds: [],
        createdAt: typeof workspace.createdAt === 'string' ? workspace.createdAt : now(),
        updatedAt: now(),
      }
      if (path !== null) byPath.set(pathKey(path), targetId)
      addedWorkspaces += 1
    } else {
      mergedWorkspaces += 1
    }
    const entry = workspaces[targetId]
    entry.sessionIds = entry.sessionIds ?? []
    for (const sessionId of sessionIds) {
      const current = owner.get(sessionId)
      if (current !== undefined && current !== targetId) {
        workspaces[current].sessionIds = (workspaces[current].sessionIds ?? []).filter(
          (id) => id !== sessionId,
        )
      }
      if (!entry.sessionIds.includes(sessionId)) {
        entry.sessionIds.push(sessionId)
        registered += 1
      }
      owner.set(sessionId, targetId)
    }
    entry.updatedAt = now()
  }

  // List every Workspace, including ones an older copy left in `tables` only.
  const listed = Array.isArray(base.global.workspaceIds)
    ? base.global.workspaceIds.filter((id) => workspaces[id] !== undefined)
    : []
  let repairedWorkspaces = 0
  for (const id of Object.keys(workspaces)) {
    if (!listed.includes(id)) {
      listed.push(id)
      if (!created) repairedWorkspaces += 1
    }
  }
  base.global.workspaceIds = listed
  if (workspaces[base.global.defaultWorkspaceId] === undefined) {
    base.global.defaultWorkspaceId = listed[0] ?? null
  }
  if (!Array.isArray(base.global.archivedSessionIds)) base.global.archivedSessionIds = []
  const archived = new Set(base.global.archivedSessionIds.map(String))
  for (const sessionId of ids) if (sourceArchived.has(sessionId)) archived.add(sessionId)
  base.global.archivedSessionIds = [...archived]
  if (!Array.isArray(base.global.pinnedSessionIds)) base.global.pinnedSessionIds = []
  if (typeof base.global.initialized !== 'boolean') base.global.initialized = true

  writeJsonAtomic(toFile, base, !created)
  return {
    registered,
    unregistered: ids.filter((id) => !claimed.has(id)).length,
    created,
    addedWorkspaces,
    mergedWorkspaces,
    repairedWorkspaces,
  }
}

/**
 * Copy one library into the other.
 * @param {'local' | 'custom'} from - source role.
 * @param {'local' | 'custom'} to - target role.
 * @returns {object} summary for the panel.
 */
export function copyBetween(from, to) {
  if (from === to) throw new Error('两个位置是同一个，不需要复制')
  const rootsNow = roots()
  const fromRoot = from === 'local' ? rootsNow.local : rootsNow.custom
  const toRoot = to === 'local' ? rootsNow.local : rootsNow.custom
  if (fromRoot === null || fromRoot === undefined) throw new Error('还没有选择指定的文件夹')
  if (toRoot === null || toRoot === undefined) throw new Error('还没有选择指定的文件夹')
  if (pathKey(fromRoot) === pathKey(toRoot)) throw new Error('两个位置是同一个，不需要复制')
  if (!isDirectory(fromRoot)) throw new Error(`来源文件夹不存在：${fromRoot}`)

  if (to === 'custom') ensureVault(toRoot)
  else {
    mkdirSync(join(toRoot, 'sessions'), { recursive: true })
    mkdirSync(join(toRoot, 'storages'), { recursive: true })
  }

  const outcome = copySessions(fromRoot, toRoot)
  const projections = copyProjections(fromRoot, toRoot, outcome.ids)
  const index = registerInWorkspaces(fromRoot, toRoot, outcome.ids)
  // A source log may not be listed by any source Workspace. The copy still
  // happened; adoption reads its cwd and gives it a home, so it is visible.
  const adopted = adoptOrphans(toRoot)
  const owned = new Set()
  const targetIndex = readJson(join(toRoot, 'storages', 'workspace.json'))
  for (const workspace of Object.values(targetIndex?.tables?.workspaces ?? {})) {
    for (const sessionId of workspace?.sessionIds ?? []) owned.add(sessionId)
  }
  return {
    from: fromRoot,
    to: toRoot,
    sessions: outcome.copied.length,
    projections,
    registered: index.registered,
    unregistered: outcome.ids.filter((id) => !owned.has(id)).length,
    adopted: adopted.adopted,
    adoptedWorkspaces: adopted.created,
    workspaces: {
      added: index.addedWorkspaces,
      merged: index.mergedWorkspaces,
      repaired: index.repairedWorkspaces,
    },
    skipped: outcome.skipped,
  }
}

/**
 * Which library `/vault repair` should normalize.
 * @returns {string} absolute root.
 */
function repairRoot() {
  const state = status()
  if (typeof state.requested === 'string' && state.requested !== '') return state.requested
  return state.root
}

/**
 * Handle `/vault ...`.
 * @param {string} raw - command input.
 * @returns {{kind: string, text: string}} command result.
 */
/**
 * Compare two absolute paths with Windows case rules.
 * @param left - first path.
 * @param right - second path.
 * @returns whether they name the same directory.
 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = left.replace(/[\\/]+$/, '').toLowerCase()
  const b = right.replace(/[\\/]+$/, '').toLowerCase()
  return a === b
}

export function handleCommand(raw) {
  const [action, argument] = String(raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  try {
    if (action === undefined || action === 'status') {
      return { kind: 'success', text: JSON.stringify(status()) }
    }
    if (action === 'check') {
      const state = status()
      const inspected = inspectLibrary(state.requested ?? state.root)
      return {
        kind: 'success',
        text: JSON.stringify({
          status: state,
          library: {
            ok: inspected.ok,
            reason: inspected.reason,
            needsRepair: inspected.needsRepair === true,
            workspaces: Array.isArray(inspected.tableIds) ? inspected.tableIds.length : 0,
          },
          compat: capability(state.root),
        }),
      }
    }
    if (action === 'default') {
      return { kind: 'success', text: JSON.stringify(useDefault()) }
    }
    if (action === 'custom') {
      const path = decodePath(argument)
      if (path === undefined) throw new Error('custom 需要一个文件夹路径')
      return { kind: 'success', text: JSON.stringify(useCustom(path)) }
    }
    if (action === 'target') {
      const path = decodePath(argument)
      if (path === undefined) throw new Error('target 需要一个文件夹路径')
      return { kind: 'success', text: JSON.stringify(useTarget(path)) }
    }
    if (action === 'push') {
      requireVaultFree('复制会话')
      requireCompatible('复制会话')
      return { kind: 'success', text: JSON.stringify(copyBetween('local', 'custom')) }
    }
    if (action === 'pull') {
      requireVaultFree('复制会话')
      requireCompatible('复制会话')
      return { kind: 'success', text: JSON.stringify(copyBetween('custom', 'local')) }
    }
    if (action === 'drift') {
      const state = status()
      const root = state.requested ?? state.root
      const plan = buildRepairPlan({ vaultRoot: root, drives: listDrives() })
      if (plan.error !== undefined) throw new Error(plan.error)
      return {
        kind: 'success',
        text: JSON.stringify({
          root: plan.root,
          target: plan.target,
          ok: plan.ok,
          inUse: samePath(state.root, root),
          remaps: plan.remaps,
          groups: plan.groupRenames,
          headers: plan.headerRewrites.map((item) => ({ file: item.file, from: item.from, to: item.to })),
          warnings: plan.warnings,
        }),
      }
    }
    if (action === 'drift-fix') {
      // Two accepted spellings: a literal `confirm`, or a b64 JSON payload with
      // { confirm: true }. Both exist so the panel can avoid encoding a payload.
      let confirmed = argument === 'confirm'
      if (!confirmed && argument !== undefined) {
        const payload = decodePath(argument)
        if (payload === undefined) throw new Error('drift-fix 需要 confirm，或一个 b64 JSON 载荷')
        confirmed = JSON.parse(payload).confirm === true
      }
      if (!confirmed) throw new Error('drift-fix 需要 confirm：这是一次会改写文件的修复')
      const state = status()
      const root = state.requested ?? state.root
      if (samePath(state.root, root)) {
        throw new Error('这个库正在被使用。请先在面板里切回本机默认、完全退出 DSH，再回来修正。')
      }
      // Rebuild from disk: never act on a plan the caller could have edited.
      const plan = buildRepairPlan({ vaultRoot: root, drives: listDrives() })
      if (plan.error !== undefined) throw new Error(plan.error)
      if (plan.ok === true) {
        return { kind: 'success', text: JSON.stringify({ ok: true, changes: 0 }) }
      }
      const result = applyRepairPlan(plan)
      return {
        kind: 'success',
        text: JSON.stringify({ ok: true, changes: result.changes, backup: result.backup }),
      }
    }
    if (action === 'repair') {
      const root = repairRoot()
      const repaired = repairLibrary(root)
      const adopted = adoptOrphans(root)
      return {
        kind: 'success',
        text: JSON.stringify({
          ...repaired,
          adopted: adopted.adopted,
          adoptedWorkspaces: adopted.created,
        }),
      }
    }
    if (action === 'copy') {
      const payload = decodePath(argument)
      if (payload === undefined) throw new Error('copy 需要一个 b64 JSON 载荷')
      const request = JSON.parse(payload)
      if (typeof request.sessionId !== 'string' || request.sessionId === '') {
        throw new Error('copy 缺少 sessionId')
      }
      if (typeof request.targetRoot !== 'string' || request.targetRoot === '') {
        throw new Error('copy 缺少 targetRoot')
      }
      const state = status()
      const sourceRoot = state.root
      requireVaultFree('复制会话')
      requireCompatible('复制会话')
      const source = findSession(sourceRoot, request.sessionId)
      const result = copyStorage({
        sourceRoot,
        targetRoot: request.targetRoot,
        sessionId: request.sessionId,
        move: request.move === true,
        backup: request.backup !== false,
        dryRun: request.dryRun === true,
        sourceSha: sha256(source.log),
        sourceCacheSha: sha256(source.cacheFile),
      })
      return { kind: 'success', text: JSON.stringify(result) }
    }
    if (action === 'delete') {
      const payload = decodePath(argument)
      if (payload === undefined) throw new Error('delete 需要一个 b64 JSON 载荷')
      const request = JSON.parse(payload)
      if (typeof request.sessionId !== 'string' || request.sessionId === '') {
        throw new Error('delete 缺少 sessionId')
      }
      const state = status()
      requireVaultFree('删除会话')
      requireCompatible('删除会话')
      const result = deleteSession({
        root: state.root,
        sessionId: request.sessionId,
        backup: request.backup !== false,
      })
      return { kind: 'success', text: JSON.stringify(result) }
    }
    if (action === 'backups') {
      const state = status()
      return { kind: 'success', text: JSON.stringify(listBackups(state.root)) }
    }
    if (action === 'restore') {
      const payload = decodePath(argument)
      if (payload === undefined) throw new Error('restore 需要一个 b64 JSON 载荷')
      const request = JSON.parse(payload)
      if (typeof request.backupDir !== 'string' || request.backupDir === '') {
        throw new Error('restore 缺少 backupDir')
      }
      const state = status()
      requireVaultFree('恢复会话')
      requireCompatible('恢复会话')
      const result = restoreBackup({ root: state.root, backupDir: request.backupDir })
      return { kind: 'success', text: JSON.stringify(result) }
    }
    if (action === 'drop-backup') {
      const payload = decodePath(argument)
      if (payload === undefined) throw new Error('drop-backup 需要一个 b64 JSON 载荷')
      const request = JSON.parse(payload)
      if (typeof request.backupDir !== 'string' || request.backupDir === '') {
        throw new Error('drop-backup 缺少 backupDir')
      }
      const state = status()
      requireVaultFree('删除备份')
      const result = dropBackup({ root: state.root, backupDir: request.backupDir })
      return { kind: 'success', text: JSON.stringify(result) }
    }
    if (action === 'drop-backups') {
      const payload = decodePath(argument)
      if (payload === undefined) throw new Error('drop-backups 需要一个 b64 JSON 载荷')
      const request = JSON.parse(payload)
      const keep = request.keep === undefined ? 0 : Number(request.keep)
      if (!Number.isInteger(keep) || keep < 0) {
        throw new Error('drop-backups 的 keep 必须是非负整数')
      }
      const state = status()
      requireVaultFree('清理备份')
      const result = dropAllBackups({ root: state.root, keep, dryRun: request.dryRun === true })
      return { kind: 'success', text: JSON.stringify(result) }
    }
    if (action === 'cleanup') {
      return { kind: 'success', text: JSON.stringify(cleanupLogs()) }
    }
    if (action === 'migrate') {
      const payload = decodePath(argument)
      if (payload === undefined) throw new Error('migrate 需要一个 b64 JSON 载荷')
      const request = JSON.parse(payload)
      if (typeof request.sessionId !== 'string' || request.sessionId === '') {
        throw new Error('migrate 缺少 sessionId')
      }
      if (typeof request.workspace !== 'string' || request.workspace === '') {
        throw new Error('migrate 缺少 workspace')
      }
      const state = status()
      const sourceRoot = state.root
      requireVaultFree('迁移会话')
      requireCompatible('迁移会话')
      const targetRoot =
        typeof request.targetRoot === 'string' && request.targetRoot !== ''
          ? request.targetRoot
          : sourceRoot
      const source = findSession(sourceRoot, request.sessionId)
      const result = relocate({
        sourceRoot,
        sessionId: request.sessionId,
        targetRoot,
        workspace: request.workspace,
        title: typeof request.title === 'string' ? request.title : '',
        workspaceTitle:
          typeof request.workspaceTitle === 'string' ? request.workspaceTitle : '',
        move: request.move === true,
        backup: request.backup !== false,
        dryRun: request.dryRun === true,
        sourceSha: sha256(source.log),
        sourceCacheSha: sha256(source.cacheFile),
      })
      return { kind: 'success', text: JSON.stringify(result) }
    }
    throw new Error(`未知操作：${action}`)
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** PowerShell body of the no-UI recovery script. ASCII only, so 5.1 reads it. */
const RECOVERY_PS1 = `$ErrorActionPreference = 'Stop'
$vaultHome = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($vaultHome)) {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_PROFILE_DIR)) {
    $vaultHome = Split-Path (Split-Path $env:DSH_PROFILE_DIR -Parent) -Parent
  } else {
    $vaultHome = Join-Path $env:USERPROFILE '.dsh'
  }
}
New-Item -ItemType Directory -Force -Path $vaultHome | Out-Null
$mode = Join-Path $vaultHome 'session-vault.json'
$panic = Join-Path $vaultHome 'session-vault.panic'
Set-Content -LiteralPath $mode -Value '{"mode":"default"}' -Encoding Ascii
New-Item -ItemType File -Force -Path $panic | Out-Null
Write-Host ''
Write-Host 'OK: DSH will use the local default on the next start.'
Write-Host 'Fully quit DeepSeek Harness, then open it again.'
Write-Host ''
`

/** Launcher body; ASCII, and it uses its own folder so spaces are safe. */
const RECOVERY_CMD = `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0session-vault-recover.ps1"\r\npause\r\n`

/** Human explanation, UTF-8 with BOM so Notepad shows Chinese correctly. */
const RECOVERY_TXT = `\uFEFF会话位置插件 · 急救说明\r
\r
如果 DSH 打不开、侧栏里没有会话、或者「会话位置」面板点不动：\r
\r
1. 双击这个文件夹里的「恢复本机.cmd」。\r
2. 看到 OK 后，完全关闭 DeepSeek Harness（整个窗口），再重新打开。\r
3. 打开后 DSH 会使用本机默认位置；你的对话不会丢。\r
\r
它做了什么：\r
- 把 session-vault.json 改回 {"mode":"default"}\r
- 放一个 session-vault.panic 标记，强制忽略「指定文件夹」\r
\r
想再次使用指定文件夹：打开 DSH 后，点侧栏底部的「会话位置」，重新选择文件夹。\r
`

/**
 * Write a file only when its bytes would change.
 * @param {string} file - target.
 * @param {string} content - exact content.
 */
function writeIfChanged(file, content) {
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return
    writeFileSync(file, content, 'utf8')
  } catch {
    // Recovery files are a safety net, never a boot precondition.
  }
}

/**
 * Leave the no-UI recovery kit in the harness home.
 * It is refreshed on every successful boot, so it is already there when a later
 * boot fails before any Session exists.
 */
function writeRecoveryFiles() {
  const home = homeDirectory()
  writeIfChanged(join(home, 'session-vault-recover.ps1'), RECOVERY_PS1)
  writeIfChanged(join(home, 'session-vault-recover.cmd'), RECOVERY_CMD)
  writeIfChanged(join(home, '恢复本机.cmd'), RECOVERY_CMD)
  writeIfChanged(join(home, '恢复本机-说明.txt'), RECOVERY_TXT)
}

/**
 * Leave a startup trace we can read from disk, then register the command.
 * Returns the disposer so a host can tear the plugin down deterministically.
 * @param ctx - owning plugin context.
 * @returns {() => void} disposer.
 */
export function apply(ctx) {
  return ctx.effect(() => {
    const state = status()
    try {
      mkdirSync(homeDirectory(), { recursive: true })
      writeFileSync(
        join(homeDirectory(), TRACE_FILE_NAME),
        `${now()}\nhost half loaded pid=${process.pid}\nhome=${homeDirectory()}\nmode=${JSON.stringify(readMode())}\nstatus=${JSON.stringify(state)}\n`,
        'utf8',
      )
      if (state.degraded) {
        appendLine(
          join(homeDirectory(), FALLBACK_FILE_NAME),
          `${now()} custom folder fell back to local: requested=${state.requested} reason=${state.reason}`,
        )
      }
    } catch {
      // Verification only; never fail the plugin over it.
    }
    writeRecoveryFiles()
    // Silent drive-letter normalization. A vault carried from another machine
    // keeps the letter it was written under, so every session path inside it
    // misses; normalizing here means the user never sees the ENOENT. It only
    // touches the working-directory side (index path, group directory, header
    // cwd) and never the library root. Failures are logged, never thrown.
    try {
      const carried = status().requested
      if (typeof carried === 'string' && carried !== '' && existsSync(carried)) {
        const normalized = autoRepairVault({ vaultRoot: carried, drives: listDrives() })
        if (normalized.changes > 0) {
          appendLine(
            join(homeDirectory(), FALLBACK_FILE_NAME),
            `${now()} drive drift normalized: ${normalized.changes} item(s) backup=${normalized.backup ?? '?'}`,
          )
        } else if (normalized.ok === false) {
          appendLine(
            join(homeDirectory(), FALLBACK_FILE_NAME),
            `${now()} drive drift normalization skipped: ${normalized.reason ?? 'unknown'}`,
          )
        }
      }
    } catch {
      // A repair must never be the reason a vault fails to open.
    }
    // Take the library lock for this process and leave it on disk, so a second
    // DSH can name the holder instead of silently forking the library.
    const lockRoot = state.root
    const lock = acquireVaultLock(lockRoot)
    if (lock.held && !lock.mine && lock.holder !== null) {
      appendLine(
        join(homeDirectory(), FALLBACK_FILE_NAME),
        `${now()} library is held by another DSH: pid=${lock.holder.pid} host=${lock.holder.host ?? '?'} startedAt=${lock.holder.startedAt ?? '?'}`,
      )
    }
    const dispose = ctx.commands.register({
      name: 'vault',
      description:
        '会话存放位置：本机默认 / 指定文件夹；按需复制、索引修复；切换后重启生效',
      input: {
        hint:
          'status | check | default | custom <path> | target <path> | push | pull | repair | backups | restore <b64-json> | drop-backup <b64-json> | drop-backups <b64-json> | cleanup | copy <b64-json> | delete <b64-json> | migrate <b64-json>',
      },
      handler: (invocation) => handleCommand(invocation?.rawInput ?? ''),
    })
    return () => {
      dispose()
      releaseVaultLock(lockRoot)
    }
  }, 'session-vault: command')
}
