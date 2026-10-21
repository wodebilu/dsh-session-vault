// Fixture builders for the session-vault core tests.
//
// A library here is the same shape DSH leaves on disk: a per-project session
// directory holding one zstd-framed log, a projection cache, and a Workspace
// index. Nothing touches the real ~/.dsh.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

/** @returns {string} current ISO timestamp. */
export const nowIso = () => new Date().toISOString()

/** Write rows as one complete zstd frame per row, the way DSH appends. */
export function writeFrames(file, rows) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    Buffer.concat(
      rows.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`, 'utf8'))),
    ),
  )
}

/**
 * Create one session: log, projection cache, and (optionally) nothing else.
 * @param {string} root - library root.
 * @param {object} options - id, cwd, title, project, logVersion, rows, cache.
 * @returns {object} the created session's absolute paths.
 */
export function createSession(root, options) {
  const id = options.id
  const cwd = options.cwd ?? join(root, 'project')
  const project = options.project ?? '-fixture-'
  const version = options.logVersion ?? 4
  const title = options.title ?? id
  const dir = join(root, 'sessions', project, id)
  const rows = options.rows ?? [
    { type: 'session', id, cwd, createdAt: nowIso() },
    { type: 'session/title', data: { title } },
  ]
  const log = join(dir, `session.v${version}.jsonl.zstd`)
  writeFrames(log, rows)

  const cache =
    options.cache === undefined
      ? {
          record: {
            identity: { id, cwd },
            rows: {
              title: { val: title },
              workingDirectory: { val: cwd },
              sessionListMetadata: { val: { blank: true } },
            },
          },
        }
      : options.cache
  const cacheFile = join(root, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  if (cache !== null) {
    mkdirSync(dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(cache))
  }
  return { id, cwd, title, dir, log, cacheFile, rows }
}

/** Write a Workspace index. */
export function writeIndex(root, options = {}) {
  const workspaces = options.workspaces ?? {}
  const file = join(root, 'storages', 'workspace.json')
  mkdirSync(dirname(file), { recursive: true })
  const ids = Object.keys(workspaces)
  writeFileSync(
    file,
    JSON.stringify({
      unit: { name: 'workspace', version: options.unitVersion ?? 2 },
      global: {
        initialized: true,
        workspaceIds: ids,
        archivedSessionIds: [],
        pinnedSessionIds: [],
        defaultWorkspaceId: options.defaultWorkspaceId ?? ids[0] ?? null,
      },
      tables: { workspaces },
    }),
  )
  return file
}

/**
 * Build a throwaway library; one Workspace per distinct cwd.
 * @param {string} root - library root.
 * @param {object} options - sessions, unitVersion, workspaces.
 * @returns {object} library fixture.
 */
export function makeLibrary(root, options = {}) {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const sessions = (options.sessions ?? [{ id: 'session-a' }]).map((session) =>
    createSession(root, session),
  )
  const workspaces = { ...(options.workspaces ?? {}) }
  const byCwd = new Map()
  for (const id of Object.keys(workspaces)) {
    byCwd.set(workspaces[id].path.toLowerCase(), id)
  }
  for (const session of sessions) {
    const key = session.cwd.toLowerCase()
    if (byCwd.has(key)) {
      workspaces[byCwd.get(key)].sessionIds.push(session.id)
      continue
    }
    const id = randomUUID()
    byCwd.set(key, id)
    workspaces[id] = {
      path: session.cwd,
      title: 'Fixture',
      sessionIds: [session.id],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
  }
  writeIndex(root, { workspaces, unitVersion: options.unitVersion })
  return { root, sessions, workspaces }
}

/** A fresh empty directory path under `parent`. */
export function workspaceDir(root, name = 'workspace') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}
