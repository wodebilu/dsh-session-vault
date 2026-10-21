#!/usr/bin/env node
/**
 * relocate.mjs — copy one DSH session into another workspace, safely.
 *
 * Usage:
 *   node relocate.mjs --source <vault> --session <id> --target <vault>
 *                     --workspace <absolute-folder> [--title <title>]
 *                     [--workspace-title <title>] [--new-id <id>] [--dry-run]
 *
 * With no arguments it asks for the same values interactively.
 *
 * What it does:
 *   - reads the source session log and projection cache (read-only);
 *   - clones every record, one zstd frame per record (checksummed);
 *   - changes only the session id, the title and the header cwd;
 *   - copies/adapts the projection cache (cwd, title, blank=false);
 *   - finds or creates the target workspace with an ISO-8601 index;
 *   - never deletes, moves or rewrites the source; the source SHA-256 is checked.
 *
 * Known constraints (learned the hard way):
 *   - workspace createdAt/updatedAt must be ISO strings;
 *   - the DSH-bundled Node (24.21) decompresses only the first frame of a log,
 *     so logs are read frame by frame; this writer still emits one record per
 *     frame, which every reader accepts;
 *   - a projection cache is required for the session to appear in the sidebar.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { zstdCompressSync } from 'node:zlib'
import { decodeZstdRows } from './zstd-frames.mjs'

const SESSION_FILE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/
const ZSTD_CONTENT_SIZE = 200
const ZSTD_CHECKSUM = 201
const DEFAULT_SOURCE = 'F:\\dsh-vault'

const isDir = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const nowIso = () => new Date().toISOString()
/** Comparison key: resolved, symlink-free, case-folded on Windows. */
const canonical = (path) => {
  const absolute = canonicalPath(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * The path DSH itself would stamp on a Workspace record: `fs.realpath` at
 * create. A junction, an 8.3 name or a `..` segment would otherwise make two
 * Workspaces describe the same folder.
 */
function canonicalPath(path) {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** DSH's `encodeSegment`: safe chars literal, everything else `~XXXX`. */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** DSH's `projectKey`: separators collapse to `-`, unsafe units `~XXXX`. */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

const sessionLogPath = (root, cwd, id) =>
  join(root, 'sessions', projectKey(cwd), encodeSegment(id), 'session.v4.jsonl.zstd')
const projectionPath = (root, id) =>
  join(root, 'storages', 'session_projcache', 'sessions', `${id}.json`)

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function readRows(file) {
  const raw = readFileSync(file)
  if (file.endsWith('.zstd')) return decodeZstdRows(raw)
  return raw.toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

function writeJson(file, value, backup = false) {
  mkdirSync(dirname(file), { recursive: true })
  if (backup && existsSync(file)) {
    writeFileSync(`${file}.bak`, readFileSync(file))
  }
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

function writeFrames(file, rows) {
  const frames = rows.map((row) =>
    zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`, 'utf8'), {
      params: { [ZSTD_CONTENT_SIZE]: 0, [ZSTD_CHECKSUM]: 1 },
    }),
  )
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.concat(frames))
  return frames.length
}

function deepReplaceId(value, oldId, newId) {
  if (typeof value === 'string') return value === oldId ? newId : value
  if (Array.isArray(value)) return value.map((child) => deepReplaceId(child, oldId, newId))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = deepReplaceId(child, oldId, newId)
    }
    return out
  }
  return value
}

function cacheTitle(cache) {
  const value = cache?.record?.rows?.title?.val
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Reach the projection cache's mutable record.
 *
 * The cache is the one durable artifact this module rewrites in place, so its
 * shape is checked here instead of being dereferenced blind: when DSH changes
 * the projection schema the operation must fail with a sentence, not with a
 * `TypeError` after the log has already been published.
 */
function cacheRecord(cache, sessionId) {
  const record = cache?.record
  if (record === null || typeof record !== 'object') {
    throw new Error(
      `projection cache for ${sessionId} has no record; refusing to write a cache DSH cannot read`,
    )
  }
  if (record.rows === null || typeof record.rows !== 'object') record.rows = {}
  return record
}

/** Point a projection cache at a working directory. */
function setCacheCwd(cache, sessionId, cwd) {
  const record = cacheRecord(cache, sessionId)
  if (record.identity !== null && typeof record.identity === 'object') record.identity.cwd = cwd
  const row = record.rows.workingDirectory
  if (row !== null && typeof row === 'object') row.val = cwd
}

/** Retitle a projection cache and mark it as carrying a real session. */
function setCacheTitle(cache, sessionId, title) {
  const record = cacheRecord(cache, sessionId)
  const row = record.rows.title
  if (row !== null && typeof row === 'object') row.val = title
  setCacheVisible(cache, sessionId)
}

/** Mark a projection cache as carrying a real session. */
function setCacheVisible(cache, sessionId) {
  const record = cacheRecord(cache, sessionId)
  const metadata = record.rows.sessionListMetadata
  if (metadata !== null && typeof metadata === 'object') {
    metadata.val = { ...metadata.val, blank: false }
  }
}

/**
 * Whether the source files still match the digests the caller captured when the
 * command started. An absent digest means "not checked", not "changed".
 */
function sourceUnchangedNow(source, options) {
  if (typeof options.sourceSha === 'string' && sha256(source.log) !== options.sourceSha) return false
  if (typeof options.sourceCacheSha === 'string' && sha256(source.cacheFile) !== options.sourceCacheSha) {
    return false
  }
  return true
}

/**
 * Refuse to touch a source that moved under us. A live session appends to its
 * log while we read it, so a clone taken across an append is a torn snapshot —
 * fine to keep as a target, never fine to delete the source for.
 */
function requireStableSource(source, options, action) {
  if (sourceUnchangedNow(source, options)) return
  throw new Error(
    `${action}: the source session changed while it was being copied; the source was not deleted. Retry while it is idle.`,
  )
}

/** The projection cache of one session, or a sentence explaining why cloning is off. */
function requireCache(root, sessionId) {
  const cacheFile = projectionPath(root, sessionId)
  const cache = readJson(cacheFile)
  if (cache === null) {
    throw new Error(
      `source projection cache is missing: ${cacheFile}\n` +
        'DSH hides sessions without a projection cache; refusing to create an invisible clone.',
    )
  }
  return { cache, cacheFile }
}

export function findSession(root, sessionId) {
  const sessionsRoot = join(root, 'sessions')
  if (!isDir(sessionsRoot)) throw new Error(`not a session root: ${sessionsRoot}`)
  const dirName = encodeSegment(sessionId)
  for (const project of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, project, dirName)
    if (!isDir(dir)) continue
    const file = readdirSync(dir).find((name) => SESSION_FILE.test(name))
    if (file === undefined) continue
    const log = join(dir, file)
    const rows = readRows(log)
    const header = rows[0]
    if (header?.type !== 'session' || header.id !== sessionId) continue
    const { cache, cacheFile } = requireCache(root, sessionId)
    return { log, rows, cache, cacheFile, header, title: cacheTitle(cache) }
  }
  throw new Error(`session not found: ${sessionId} under ${sessionsRoot}`)
}

/**
 * Every session below one parent, in a single pass over the library.
 *
 * The previous version re-walked the whole library for every child it found,
 * which is quadratic: a library with 500 sessions and a 3-deep tree meant
 * thousands of directory reads and log parses. This builds a
 * `parentSession -> children` map once and then walks it, so every session
 * directory is read exactly once.
 */
export function findChildren(root, parentId) {
  const sessionsRoot = join(root, 'sessions')
  const out = []
  if (!isDir(sessionsRoot)) return out

  const byParent = new Map()
  for (const project of readdirSync(sessionsRoot)) {
    const projectDir = join(sessionsRoot, project)
    if (!isDir(projectDir)) continue
    for (const dirName of readdirSync(projectDir)) {
      const dir = join(projectDir, dirName)
      if (!isDir(dir)) continue
      const file = readdirSync(dir).find((name) => SESSION_FILE.test(name))
      if (file === undefined) continue
      const log = join(dir, file)
      let rows
      try {
        rows = readRows(log)
      } catch {
        // A log we cannot read cannot claim a parent; leave it for repair.
        continue
      }
      const header = rows[0]
      if (header?.type !== 'session' || typeof header.parentSession !== 'string') continue
      const bucket = byParent.get(header.parentSession)
      if (bucket === undefined) byParent.set(header.parentSession, [{ log, rows, header }])
      else bucket.push({ log, rows, header })
    }
  }

  const seen = new Set()
  const queue = [parentId]
  while (queue.length > 0) {
    const id = queue.shift()
    for (const child of byParent.get(id) ?? []) {
      if (seen.has(child.header.id)) continue
      seen.add(child.header.id)
      const { cache, cacheFile } = requireCache(root, child.header.id)
      out.push({
        log: child.log,
        rows: child.rows,
        cache,
        cacheFile,
        header: child.header,
        title: cacheTitle(cache),
      })
      queue.push(child.header.id)
    }
  }
  return out
}

export function listSessions(root) {
  const sessionsRoot = join(root, 'sessions')
  const out = []
  if (!isDir(sessionsRoot)) return out
  for (const project of readdirSync(sessionsRoot)) {
    const projectDir = join(sessionsRoot, project)
    if (!isDir(projectDir)) continue
    for (const id of readdirSync(projectDir)) {
      const dir = join(projectDir, id)
      if (!isDir(dir)) continue
      const file = readdirSync(dir).find((name) => SESSION_FILE.test(name))
      if (file === undefined) continue
      const cache = readJson(projectionPath(root, id))
      out.push({ id, title: cacheTitle(cache) ?? id, project })
    }
  }
  return out.sort((left, right) => left.title.localeCompare(right.title))
}

function ensureIndex(targetRoot) {
  const indexFile = join(targetRoot, 'storages', 'workspace.json')
  let index = readJson(indexFile)
  if (index === null || typeof index !== 'object') {
    index = {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: [],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        defaultWorkspaceId: null,
      },
      tables: { workspaces: {} },
    }
  }
  index.unit = index.unit ?? { name: 'workspace', version: 2 }
  index.global = index.global ?? {}
  index.tables = index.tables ?? {}
  index.tables.workspaces = index.tables.workspaces ?? {}
  index.global.workspaceIds = Array.isArray(index.global.workspaceIds)
    ? index.global.workspaceIds
    : []
  index.global.archivedSessionIds = Array.isArray(index.global.archivedSessionIds)
    ? index.global.archivedSessionIds
    : []
  index.global.pinnedSessionIds = Array.isArray(index.global.pinnedSessionIds)
    ? index.global.pinnedSessionIds
    : []
  return { indexFile, index }
}

/** Coerce legacy numeric timestamps to ISO strings, as DSH's schema requires. */
function normalizeTimestamps(workspaces) {
  for (const workspace of Object.values(workspaces)) {
    for (const key of ['createdAt', 'updatedAt']) {
      const value = workspace[key]
      const date =
        typeof value === 'string' && !Number.isNaN(Date.parse(value))
          ? new Date(value)
          : typeof value === 'number' && Number.isFinite(value)
            ? new Date(value)
            : new Date()
      workspace[key] = date.toISOString()
    }
  }
}

function copyAttachments(fromRoot, toRoot, dryRun = false) {
  const from = join(fromRoot, 'attachments', 'v1')
  const to = join(toRoot, 'attachments', 'v1')
  const result = { copied: 0, skipped: 0 }
  if (!isDir(from)) return result
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const source = join(dir, entry.name)
      const target = join(to, rel, entry.name)
      if (entry.isDirectory()) {
        if (!dryRun) mkdirSync(target, { recursive: true })
        walk(source, join(rel, entry.name))
      } else if (existsSync(target)) {
        result.skipped += 1
      } else {
        if (!dryRun) {
          mkdirSync(dirname(target), { recursive: true })
          copyFileSync(source, target)
        }
        result.copied += 1
      }
    }
  }
  walk(from, '')
  return result
}

function sourceWorkspaceTitle(root, cwd) {
  const index = readJson(join(root, 'storages', 'workspace.json'))
  for (const workspace of Object.values(index?.tables?.workspaces ?? {})) {
    if (
      typeof workspace?.path === 'string' &&
      canonical(workspace.path) === canonical(cwd)
    ) {
      return workspace.title || basename(cwd)
    }
  }
  return basename(cwd)
}

function ensureWorkspace(index, targetRoot, path, title, dryRun) {
  const workspaces = index.tables.workspaces
  normalizeTimestamps(workspaces)
  let id = Object.keys(workspaces).find(
    (key) =>
      typeof workspaces[key]?.path === 'string' &&
      canonical(workspaces[key].path) === canonical(path),
  )
  if (id === undefined) {
    id = randomUUID()
    workspaces[id] = {
      path: canonicalPath(path),
      title: title || basename(path),
      sessionIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
  }
  if (!dryRun) mkdirSync(path, { recursive: true })
  return id
}

/**
 * The library's own `_default` Workspace: find the existing one instead of
 * minting a second record for the same folder, which used to happen whenever a
 * migration targeted the current default Workspace.
 */
function ensureDefaultWorkspace(index, targetRoot, dryRun) {
  const workspaces = index.tables.workspaces
  const dir = join(targetRoot, '_default')
  const existing = Object.keys(workspaces).find(
    (id) => typeof workspaces[id]?.path === 'string' && canonical(workspaces[id].path) === canonical(dir),
  )
  if (existing !== undefined) {
    index.global.defaultWorkspaceId = existing
    if (!index.global.workspaceIds.includes(existing)) index.global.workspaceIds.push(existing)
    return existing
  }
  const id = randomUUID()
  if (!dryRun) mkdirSync(dir, { recursive: true })
  workspaces[id] = {
    path: canonicalPath(dir),
    title: 'Default',
    sessionIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  index.global.defaultWorkspaceId = id
  if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
  return id
}

function addSessionToWorkspace(index, workspaceId, sessionId) {
  const workspace = index.tables.workspaces[workspaceId]
  workspace.sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
  if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
  workspace.updatedAt = nowIso()
}

export function relocate(options) {
  const sourceRoot = resolve(options.sourceRoot)
  const targetRoot = resolve(options.targetRoot)
  const workspacePath = resolve(options.workspace)
  const source = findSession(sourceRoot, options.sessionId)
  const oldTitle = source.title ?? source.header.id
  const title = options.title && options.title.trim() !== '' ? options.title.trim() : `迁移自 ${oldTitle}`
  const newId = options.newId && options.newId.trim() !== '' ? options.newId.trim() : `session-${randomUUID()}`
  const dryRun = options.dryRun === true

  const targetLog = sessionLogPath(targetRoot, workspacePath, newId)
  const targetCacheFile = projectionPath(targetRoot, newId)
  if (existsSync(targetLog) || existsSync(targetCacheFile)) {
    throw new Error(`target session already exists: ${newId}`)
  }

  const rows = source.rows.map((row) => {
    const next = deepReplaceId(row, source.header.id, newId)
    if (next.type === 'session') next.cwd = workspacePath
    if (next.type === 'session/title') next.data = { ...next.data, title }
    return next
  })

  const cache = deepReplaceId(source.cache, source.header.id, newId)
  setCacheCwd(cache, newId, workspacePath)
  setCacheTitle(cache, newId, title)

  // Directories come last: a cache this build cannot rewrite must abort before
  // the target library is touched at all.
  if (!dryRun) {
    mkdirSync(join(targetRoot, 'sessions'), { recursive: true })
    mkdirSync(join(targetRoot, 'storages'), { recursive: true })
    mkdirSync(join(targetRoot, 'attachments', 'v1'), { recursive: true })
    mkdirSync(workspacePath, { recursive: true })
  }

  const children = findChildren(sourceRoot, source.header.id)
  const attachments = copyAttachments(sourceRoot, targetRoot, dryRun)
  const { indexFile, index } = ensureIndex(targetRoot)
  const workspaces = index.tables.workspaces
  normalizeTimestamps(workspaces)

  let targetWorkspaceId = Object.keys(workspaces).find(
    (id) => typeof workspaces[id]?.path === 'string' && canonical(workspaces[id].path) === canonical(workspacePath),
  )
  if (targetWorkspaceId === undefined) {
    targetWorkspaceId = randomUUID()
    workspaces[targetWorkspaceId] = {
      path: workspacePath,
      title: options.workspaceTitle && options.workspaceTitle.trim() !== ''
        ? options.workspaceTitle.trim()
        : basename(workspacePath),
      sessionIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
  }

  const workspace = workspaces[targetWorkspaceId]
  workspace.sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
  if (!workspace.sessionIds.includes(newId)) workspace.sessionIds.push(newId)
  workspace.updatedAt = nowIso()

  const currentDefault = index.global.defaultWorkspaceId
  const defaultIsValid =
    typeof currentDefault === 'string' && workspaces[currentDefault] !== undefined
  const defaultId =
    defaultIsValid && currentDefault !== targetWorkspaceId
      ? currentDefault
      : ensureDefaultWorkspace(index, targetRoot, dryRun)

  for (const id of Object.keys(workspaces)) {
    if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
  }
  index.global.initialized = true

  for (const child of children) {
    const childNewId = `session-${randomUUID()}`
    const childRows = child.rows.map((row) => {
      let next = deepReplaceId(row, child.header.id, childNewId)
      next = deepReplaceId(next, source.header.id, newId)
      if (next.type === 'session') next.cwd = child.header.cwd
      if (next.type === 'session/title') {
        next.data = { ...next.data, title: child.title ?? childNewId }
      }
      return next
    })
    const childCache = deepReplaceId(
      deepReplaceId(child.cache, child.header.id, childNewId),
      source.header.id,
      newId,
    )
    setCacheCwd(childCache, childNewId, child.header.cwd)
    setCacheTitle(childCache, childNewId, child.title ?? childNewId)
    const childWorkspaceId = ensureWorkspace(
      index,
      targetRoot,
      child.header.cwd,
      sourceWorkspaceTitle(sourceRoot, child.header.cwd),
      dryRun,
    )
    addSessionToWorkspace(index, childWorkspaceId, childNewId)
    if (!dryRun) {
      writeFrames(sessionLogPath(targetRoot, child.header.cwd, childNewId), childRows)
      writeJson(projectionPath(targetRoot, childNewId), childCache)
    }
  }

  let frames = null
  if (!dryRun) {
    frames = writeFrames(targetLog, rows)
    writeJson(targetCacheFile, cache)
    if (!existsSync(join(targetRoot, 'vault.json'))) {
      writeJson(join(targetRoot, 'vault.json'), {
        format: 1,
        id: randomUUID(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
    }
    writeJson(indexFile, index, true)
  } else {
    frames = rows.length
  }

  const sourceUnchanged = sourceUnchangedNow(source, options)
  const moved = options.move === true
  let sourceBackup = null
  // A preview writes nothing, so it must delete nothing either: `dryRun`
  // promises the source is untouched. A real move additionally refuses a
  // source that grew while it was being cloned.
  if (moved && !dryRun) {
    requireStableSource(source, options, 'migrate')
    sourceBackup = deleteSession({ root: sourceRoot, sessionId: source.header.id, backup: options.backup !== false }).backupDir
  }
  return {
    sourceSessionId: source.header.id,
    sourceBackup,
    attachments,
    children: children.length,
    sourceTitle: oldTitle,
    newSessionId: newId,
    newTitle: title,
    targetRoot,
    targetWorkspacePath: workspacePath,
    targetWorkspaceId,
    defaultWorkspaceId: index.global.defaultWorkspaceId,
    targetLog,
    targetCacheFile,
    rows: rows.length,
    frames,
    dryRun,
    sourceUnchanged,
    moved: sourceBackup !== null,
  }
}

export function copyStorage(options) {
  const sourceRoot = resolve(options.sourceRoot)
  const targetRoot = resolve(options.targetRoot)
  const source = findSession(sourceRoot, options.sessionId)
  const cwd = source.header.cwd
  const dryRun = options.dryRun === true
  if (canonical(sourceRoot) === canonical(targetRoot)) {
    throw new Error('target library is the source library')
  }
  const targetLog = sessionLogPath(targetRoot, cwd, source.header.id)
  const targetCache = projectionPath(targetRoot, source.header.id)
  if (existsSync(targetLog) || existsSync(targetCache)) {
    throw new Error(`target session already exists: ${source.header.id}`)
  }
  if (!dryRun) {
    mkdirSync(join(targetRoot, 'sessions'), { recursive: true })
    mkdirSync(join(targetRoot, 'storages'), { recursive: true })
    mkdirSync(join(targetRoot, 'attachments', 'v1'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
  }

  const { indexFile, index } = ensureIndex(targetRoot)
  const workspaceId = ensureWorkspace(
    index,
    targetRoot,
    cwd,
    sourceWorkspaceTitle(sourceRoot, cwd),
    dryRun,
  )
  addSessionToWorkspace(index, workspaceId, source.header.id)

  const children = findChildren(sourceRoot, source.header.id)
  for (const child of children) {
    const childLog = sessionLogPath(targetRoot, child.header.cwd, child.header.id)
    const childCache = projectionPath(targetRoot, child.header.id)
    if (existsSync(childLog) || existsSync(childCache)) continue
    const childWorkspaceId = ensureWorkspace(
      index,
      targetRoot,
      child.header.cwd,
      sourceWorkspaceTitle(sourceRoot, child.header.cwd),
      dryRun,
    )
    addSessionToWorkspace(index, childWorkspaceId, child.header.id)
    if (!dryRun) {
      writeFrames(childLog, child.rows)
      writeJson(childCache, child.cache)
    }
  }

  const currentDefault = index.global.defaultWorkspaceId
  if (typeof currentDefault !== 'string' || index.tables.workspaces[currentDefault] === undefined) {
    ensureDefaultWorkspace(index, targetRoot, dryRun)
  }

  const attachments = copyAttachments(sourceRoot, targetRoot, dryRun)
  if (!dryRun) {
    writeFrames(targetLog, source.rows)
    writeJson(targetCache, source.cache)
    if (!existsSync(join(targetRoot, 'vault.json'))) {
      writeJson(join(targetRoot, 'vault.json'), {
        format: 1,
        id: randomUUID(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
    }
    writeJson(indexFile, index, true)
  }

  const sourceUnchanged = sourceUnchangedNow(source, options)
  const moved = options.move === true
  let sourceBackup = null
  if (moved && !dryRun) {
    requireStableSource(source, options, 'copy')
    sourceBackup = deleteSession({ root: sourceRoot, sessionId: source.header.id, backup: options.backup !== false }).backupDir
  }
  return {
    sourceSessionId: source.header.id,
    sourceBackup,
    sessionId: source.header.id,
    targetRoot,
    targetWorkspacePath: cwd,
    targetLog,
    targetCacheFile: targetCache,
    rows: source.rows.length,
    frames: source.rows.length,
    attachments,
    children: children.length,
    sourceUnchanged,
    moved: sourceBackup !== null,
    dryRun,
  }
}


export function deleteSession(options) {
  const root = resolve(options.root)
  const source = findSession(root, options.sessionId)
  const children = findChildren(root, source.header.id)
  const deleted = [source, ...children]
  const ids = deleted.map((session) => session.header.id)
  const backupDir =
    options.backup === false
      ? null
      : join(root, '_deleted', `${Date.now()}-${source.header.id}`)
  if (backupDir !== null) {
    mkdirSync(backupDir, { recursive: true })
    for (const session of deleted) {
      const targetLog = join(
        backupDir,
        'sessions',
        projectKey(session.header.cwd),
        session.header.id,
        basename(session.log),
      )
      mkdirSync(dirname(targetLog), { recursive: true })
      copyFileSync(session.log, targetLog)
      const targetCache = join(
        backupDir,
        'storages',
        'session_projcache',
        'sessions',
        `${session.header.id}.json`,
      )
      mkdirSync(dirname(targetCache), { recursive: true })
      copyFileSync(session.cacheFile, targetCache)
    }
    // Attachments are shared by sessions and are never removed by a delete or a
    // move, so copying the whole library into every backup only duplicated
    // bytes: N deletes cost N times the attachment total. The backup keeps the
    // logs, their caches and the index, which is everything a restore needs.
    copyFileSync(join(root, 'storages', 'workspace.json'), join(backupDir, 'workspace.json'))
    writeJson(join(backupDir, 'backup.json'), {
      format: 1,
      createdAt: nowIso(),
      sessionIds: ids,
      attachments: 'left in place',
    })
  }

  const { indexFile, index } = ensureIndex(root)
  const set = new Set(ids)
  for (const workspace of Object.values(index.tables.workspaces)) {
    workspace.sessionIds = (workspace.sessionIds ?? []).filter((id) => !set.has(id))
  }
  if (Array.isArray(index.global.archivedSessionIds)) {
    index.global.archivedSessionIds = index.global.archivedSessionIds.filter((id) => !set.has(id))
  }
  if (Array.isArray(index.global.pinnedSessionIds)) {
    index.global.pinnedSessionIds = index.global.pinnedSessionIds.filter((id) => !set.has(id))
  }
  writeJson(indexFile, index, true)
  for (const session of deleted) {
    rmSync(session.log, { force: true })
    rmSync(session.cacheFile, { force: true })
    try {
      // Only succeeds when nothing else lives there; a session-local artifact
      // we do not know about keeps the directory.
      rmdirSync(dirname(session.log))
    } catch {
      // not empty, or already gone
    }
  }
  return { deleted: ids, backupDir, children: children.length }
}

function backupWorkspaceTitle(index, cwd) {
  for (const workspace of Object.values(index?.tables?.workspaces ?? {})) {
    if (typeof workspace?.path === 'string' && canonical(workspace.path) === canonical(cwd)) {
      return workspace.title || basename(cwd)
    }
  }
  return basename(cwd)
}

export function listBackups(root) {
  const base = join(resolve(root), '_deleted')
  if (!isDir(base)) return []
  const out = []
  for (const name of readdirSync(base)) {
    const dir = join(base, name)
    if (!isDir(dir)) continue
    const sessions = []
    const collect = (sessionRoot) => {
      const file = readdirSync(sessionRoot).find((entry) => SESSION_FILE.test(entry))
      if (file !== undefined) {
        const rows = readRows(join(sessionRoot, file))
        const header = rows[0]
        if (header?.type === 'session') {
          const cache = readJson(projectionPath(dir, header.id))
          sessions.push({
            id: header.id,
            title: cacheTitle(cache) ?? header.id,
            cwd: header.cwd,
          })
        }
        return
      }
      for (const entry of readdirSync(sessionRoot)) {
        const sub = join(sessionRoot, entry)
        if (isDir(sub)) collect(sub)
      }
    }
    const sessionsRoot = join(dir, 'sessions')
    if (isDir(sessionsRoot)) collect(sessionsRoot)
    out.push({
      dir,
      name,
      createdAt: statSync(dir).mtime.toISOString(),
      sessions,
    })
  }
  return out.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function dropAllBackups(options) {
  const root = resolve(options.root)
  const base = join(root, '_deleted')
  const keep = options.keep === undefined ? 0 : Number(options.keep)
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error('keep must be a non-negative integer')
  }
  const backups = listBackups(root)
  const doomed = backups.slice(keep)
  const dryRun = options.dryRun === true
  const removed = []
  for (const backup of doomed) {
    const dir = resolve(backup.dir)
    if (dir === base || !dir.startsWith(base + sep)) {
      throw new Error(`refusing to remove ${dir}: it is not inside this library's _deleted`)
    }
    if (!dryRun) rmSync(dir, { recursive: true, force: true })
    removed.push({ dir, sessions: backup.sessions.length })
  }
  return {
    root,
    keep,
    dryRun,
    removed,
    kept: Math.min(keep, backups.length),
    remaining: dryRun ? backups.length - doomed.length : listBackups(root).length,
  }
}

/**
 * Join the text parts of a message. Reasoning, images and tool payloads are
 * deliberately dropped: this is a readable transcript, not a session artifact.
 */
function messageText(parts) {
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/**
 * Read one session and keep only what a human wrote and what the assistant
 * answered. The result is not a DSH session: it cannot be opened as one.
 * @param {object} options - root and sessionId.
 * @returns {object} clean conversation.
 */
export function cleanConversation(options) {
  const root = resolve(options.root)
  const source = findSession(root, options.sessionId)
  const messages = []
  for (const row of source.rows) {
    if (row?.type === 'user/message') {
      const text = messageText(row.data?.content)
      if (text !== '') {
        messages.push({ role: 'user', text, time: row.time ?? null, seq: row.seq ?? null })
      }
    } else if (row?.type === 'assistant/message') {
      const text = messageText(row.data?.message?.content)
      if (text !== '') {
        messages.push({
          role: 'assistant',
          text,
          time: row.time ?? null,
          seq: row.seq ?? null,
          turn: row.data?.turn ?? null,
        })
      }
    }
  }
  return {
    id: source.header.id,
    title: source.title ?? source.header.id,
    cwd: typeof source.header.cwd === 'string' ? source.header.cwd : null,
    createdAt: source.header.createdAt ?? null,
    messages,
  }
}

/** One filesystem-safe file name, keeping the title readable. */
function safeFileName(value) {
  const cleaned = String(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const clipped = cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned
  return clipped === '' ? 'session' : clipped
}

/** Render a clean conversation as Markdown. */
function renderMarkdown(conversation, exportedAt) {
  const lines = [`# ${conversation.title}`, '']
  lines.push(`- 会话：\`${conversation.id}\``)
  if (conversation.cwd !== null) lines.push(`- 工作区：\`${conversation.cwd}\``)
  lines.push(`- 消息：${conversation.messages.length} 条`)
  lines.push(`- 导出：${exportedAt}`)
  lines.push('', '---')
  for (const message of conversation.messages) {
    const when = typeof message.time === 'number' ? new Date(message.time).toISOString() : ''
    lines.push('', `## ${message.role === 'user' ? '你' : '助手'}${when === '' ? '' : ` · ${when}`}`, '', message.text)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Write a clean transcript next to the library, never inside it.
 * @param {object} options - root, sessionId, format ('md' | 'json'), target.
 * @returns {object} where the file went and how much is in it.
 */
export function exportClean(options) {
  const format = options.format === 'json' ? 'json' : 'md'
  const target = resolve(options.target)
  const conversation = cleanConversation(options)
  mkdirSync(target, { recursive: true })
  const exportedAt = nowIso()
  const name = `${safeFileName(conversation.title)}-${conversation.id.slice(0, 8)}.${format}`
  const file = join(target, name)
  const body =
    format === 'json'
      ? `${JSON.stringify({ ...conversation, exportedAt, format: 'clean-v1' }, null, 2)}\n`
      : renderMarkdown(conversation, exportedAt)
  writeFileSync(file, body, 'utf8')
  return {
    path: file,
    format,
    messages: conversation.messages.length,
    bytes: Buffer.byteLength(body, 'utf8'),
    title: conversation.title,
    id: conversation.id,
  }
}

export function restoreBackup(options) {
  const root = resolve(options.root)
  const backupDir = resolve(options.backupDir)
  const base = join(root, '_deleted')
  if (!isDir(backupDir) || (backupDir !== base && !backupDir.startsWith(base + sep))) {
    throw new Error('backup is not inside this library')
  }
  const backupIndex = readJson(join(backupDir, 'workspace.json'))
  const sessionsRoot = join(backupDir, 'sessions')
  const sessions = []
  const collect = (sessionRoot) => {
    const file = readdirSync(sessionRoot).find((entry) => SESSION_FILE.test(entry))
    if (file !== undefined) {
      const rows = readRows(join(sessionRoot, file))
      const header = rows[0]
      if (header?.type === 'session') {
        const cache = readJson(projectionPath(backupDir, header.id))
        if (cache !== null) sessions.push({ header, rows, cache })
      }
      return
    }
    for (const entry of readdirSync(sessionRoot)) {
      const sub = join(sessionRoot, entry)
      if (isDir(sub)) collect(sub)
    }
  }
  if (isDir(sessionsRoot)) collect(sessionsRoot)
  if (sessions.length === 0) throw new Error('backup has no session')

  const { indexFile, index } = ensureIndex(root)
  const mapping = new Map()
  for (const session of sessions) {
    const oldId = session.header.id
    let newId = oldId
    if (
      existsSync(sessionLogPath(root, session.header.cwd, oldId)) ||
      existsSync(projectionPath(root, oldId))
    ) {
      newId = `session-${randomUUID()}`
    }
    mapping.set(oldId, newId)
  }

  const restored = []
  for (const session of sessions) {
    const oldId = session.header.id
    const newId = mapping.get(oldId)
    const rows = session.rows.map((row) => {
      let next = deepReplaceId(row, oldId, newId)
      for (const [from, to] of mapping) {
        if (from !== oldId) next = deepReplaceId(next, from, to)
      }
      if (next.type === 'session') next.cwd = session.header.cwd
      return next
    })
    let cache = deepReplaceId(session.cache, oldId, newId)
    for (const [from, to] of mapping) {
      if (from !== oldId) cache = deepReplaceId(cache, from, to)
    }
    setCacheCwd(cache, newId, session.header.cwd)
    setCacheVisible(cache, newId)
    const workspaceId = ensureWorkspace(
      index,
      root,
      session.header.cwd,
      backupWorkspaceTitle(backupIndex, session.header.cwd),
      false,
    )
    addSessionToWorkspace(index, workspaceId, newId)
    writeFrames(sessionLogPath(root, session.header.cwd, newId), rows)
    writeJson(projectionPath(root, newId), cache)
    restored.push(newId)
  }

  copyAttachments(backupDir, root)
  const currentDefault = index.global.defaultWorkspaceId
  if (typeof currentDefault !== 'string' || index.tables.workspaces[currentDefault] === undefined) {
    ensureDefaultWorkspace(index, root, false)
  }
  writeJson(indexFile, index, true)
  return { restored, targetRoot: root, backupDir }
}

export function dropBackup(options) {
  const root = resolve(options.root)
  const backupDir = resolve(options.backupDir)
  const base = join(root, '_deleted')
  if (!isDir(backupDir) || (backupDir !== base && !backupDir.startsWith(base + sep))) {
    throw new Error('backup is not inside this library')
  }
  rmSync(backupDir, { recursive: true, force: true })
  return { dropped: backupDir }
}
