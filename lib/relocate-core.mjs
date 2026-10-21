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

export function findChildren(root, parentId) {
  const sessionsRoot = join(root, 'sessions')
  const out = []
  if (!isDir(sessionsRoot)) return out
  const seen = new Set()
  const walk = (id) => {
    for (const project of readdirSync(sessionsRoot)) {
      const projectDir = join(sessionsRoot, project)
      if (!isDir(projectDir)) continue
      for (const dirName of readdirSync(projectDir)) {
        const dir = join(projectDir, dirName)
        if (!isDir(dir)) continue
        const file = readdirSync(dir).find((name) => SESSION_FILE.test(name))
        if (file === undefined) continue
        const log = join(dir, file)
        const rows = readRows(log)
        const header = rows[0]
        if (header?.type !== 'session' || header.parentSession !== id) continue
        if (seen.has(header.id)) continue
        seen.add(header.id)
        out.push(findSession(root, header.id))
        walk(header.id)
      }
    }
  }
  walk(parentId)
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
      path,
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
    childCache.record.identity.cwd = child.header.cwd
    if (childCache.record.rows?.workingDirectory) {
      childCache.record.rows.workingDirectory.val = child.header.cwd
    }
    if (childCache.record.rows?.title) childCache.record.rows.title.val = child.title ?? childNewId
    if (childCache.record.rows?.sessionListMetadata) {
      childCache.record.rows.sessionListMetadata.val = {
        ...childCache.record.rows.sessionListMetadata.val,
        blank: false,
      }
    }
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

  const sourceUnchanged = sha256(source.log) === options.sourceSha && sha256(source.cacheFile) === options.sourceCacheSha
  const moved = options.move === true
  let sourceBackup = null
  if (moved) {
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
    moved,
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

  const defaultId = index.global.defaultWorkspaceId
  if (typeof defaultId !== 'string' || index.tables.workspaces[defaultId] === undefined) {
    const id = randomUUID()
    const dir = join(targetRoot, '_default')
    if (!dryRun) mkdirSync(dir, { recursive: true })
    index.tables.workspaces[id] = {
      path: dir,
      title: 'Default',
      sessionIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    index.global.defaultWorkspaceId = id
    if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
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

  const sourceUnchanged =
    sha256(source.log) === options.sourceSha &&
    sha256(source.cacheFile) === options.sourceCacheSha
  const moved = options.move === true
  let sourceBackup = null
  if (moved && !dryRun) {
    sourceBackup = deleteSession({ root: sourceRoot, sessionId: source.header.id, backup: options.backup !== false }).backupDir
  }
  return {
    sourceSessionId: source.header.id,
    sourceBackup,
    sessionId: source.header.id,
    targetRoot,
    targetWorkspacePath: cwd,
    rows: source.rows.length,
    frames: source.rows.length,
    attachments,
    children: children.length,
    sourceUnchanged,
    moved,
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
      const targetLog = join(backupDir, 'sessions', projectKey(session.header.cwd), session.header.id, 'session.v4.jsonl.zstd')
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
    copyAttachments(root, backupDir)
    copyFileSync(join(root, 'storages', 'workspace.json'), join(backupDir, 'workspace.json'))
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
    cache.record.identity.cwd = session.header.cwd
    if (cache.record.rows?.workingDirectory) {
      cache.record.rows.workingDirectory.val = session.header.cwd
    }
    if (cache.record.rows?.sessionListMetadata) {
      cache.record.rows.sessionListMetadata.val = {
        ...cache.record.rows.sessionListMetadata.val,
        blank: false,
      }
    }
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
  const defaultId = index.global.defaultWorkspaceId
  if (typeof defaultId !== 'string' || index.tables.workspaces[defaultId] === undefined) {
    const id = randomUUID()
    const dir = join(root, '_default')
    mkdirSync(dir, { recursive: true })
    index.tables.workspaces[id] = {
      path: dir,
      title: 'Default',
      sessionIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    index.global.defaultWorkspaceId = id
    if (!index.global.workspaceIds.includes(id)) index.global.workspaceIds.push(id)
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
