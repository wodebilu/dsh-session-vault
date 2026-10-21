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
 *   - one zstd frame per record; a single multi-row frame is ignored by DSH;
 *   - a projection cache is required for the session to appear in the sidebar.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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
const canonical = (path) => {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
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
    const cacheFile = projectionPath(root, sessionId)
    const cache = readJson(cacheFile)
    if (cache === null) {
      throw new Error(
        `source projection cache is missing: ${cacheFile}\n` +
          'DSH hides sessions without a projection cache; refusing to create an invisible clone.',
      )
    }
    return { log, rows, cache, cacheFile, header, title: cacheTitle(cache) }
  }
  throw new Error(`session not found: ${sessionId} under ${sessionsRoot}`)
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

export function relocate(options) {
  const sourceRoot = resolve(options.sourceRoot)
  const targetRoot = resolve(options.targetRoot)
  const workspacePath = resolve(options.workspace)
  const source = findSession(sourceRoot, options.sessionId)
  const oldTitle = source.title ?? source.header.id
  const title = options.title && options.title.trim() !== '' ? options.title.trim() : `迁移自 ${oldTitle}`
  const newId = options.newId && options.newId.trim() !== '' ? options.newId.trim() : `session-${randomUUID()}`
  const dryRun = options.dryRun === true

  if (!dryRun) {
    mkdirSync(join(targetRoot, 'sessions'), { recursive: true })
    mkdirSync(join(targetRoot, 'storages'), { recursive: true })
    mkdirSync(join(targetRoot, 'attachments', 'v1'), { recursive: true })
    mkdirSync(workspacePath, { recursive: true })
  }

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
  cache.record.identity.cwd = workspacePath
  if (cache.record.rows?.workingDirectory) cache.record.rows.workingDirectory.val = workspacePath
  if (cache.record.rows?.title) cache.record.rows.title.val = title
  if (cache.record.rows?.sessionListMetadata) {
    cache.record.rows.sessionListMetadata.val = {
      ...cache.record.rows.sessionListMetadata.val,
      blank: false,
    }
  }

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

  const ensureDefault = () => {
    const current = index.global.defaultWorkspaceId
    if (typeof current === 'string' && workspaces[current] !== undefined) return current
    const id = randomUUID()
    const dir = join(targetRoot, '_default')
    if (!dryRun) mkdirSync(dir, { recursive: true })
    workspaces[id] = {
      path: dir,
      title: 'Default',
      sessionIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    index.global.defaultWorkspaceId = id
    if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
    return id
  }
  let defaultId = ensureDefault()
  if (defaultId === targetWorkspaceId) {
    const id = randomUUID()
    const dir = join(targetRoot, '_default')
    if (!dryRun) mkdirSync(dir, { recursive: true })
    workspaces[id] = {
      path: dir,
      title: 'Default',
      sessionIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    index.global.defaultWorkspaceId = id
    if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
    defaultId = id
  }

  for (const id of Object.keys(workspaces)) {
    if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
  }
  index.global.initialized = true

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

  const sourceUnchanged = sha256(source.log) === options.sourceSha && sha256(source.cacheFile) === options.sourceCacheSha
  return {
    sourceSessionId: source.header.id,
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
  }
}

