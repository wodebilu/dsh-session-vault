/**
 * Repair drive-letter drift in one vault.
 *
 * Three things carry the letter and all three have to move together, or the
 * sessions silently disappear from the sidebar:
 *
 *   1. `storages/workspace.json` — each workspace's `path`
 *   2. `sessions/<escaped path>/` — the directory name is derived from `path`
 *   3. the `cwd` field in each session header (first zstd frame of the log)
 *
 * Only the first frame is recompressed; every later event frame is copied
 * byte-for-byte, so a repaired log keeps its append history intact.
 *
 * Nothing here runs on its own: {@link buildRepairPlan} is pure, and
 * {@link applyRepairPlan} is the only function that writes.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { detectDrift, driveOf } from './drive-drift.mjs'
import { splitZstdFrames } from './zstd-frames.mjs'

const BACKUP_DIR = '_drift-backup'
const LOG_GLOB = 'session.jsonl.zstd'

/**
 * Read a session header and how many bytes its complete frames occupy.
 * @param file - session log path.
 * @returns header, consumed frame bytes, raw buffer, or an error string.
 */
export function readSessionHeader(file) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch (error) {
    return { error: `无法读取：${error instanceof Error ? error.message : String(error)}` }
  }
  const frames = splitZstdFrames(buffer)
  if (frames.length === 0) return { error: '不是可识别的 zstd 帧序列' }
  let text
  try {
    text = zstdDecompressSync(frames[0]).toString('utf8')
  } catch (error) {
    return { error: `第一帧无法解压：${error instanceof Error ? error.message : String(error)}` }
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length !== 1) {
    return { error: `第一帧里不是单个 header 行（${lines.length} 行），拒绝改写` }
  }
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    return { error: 'header 不是合法 JSON' }
  }
  const firstFrameBytes = frames[0].length
  return { header, buffer, firstFrameBytes }
}

/**
 * Rewrite the `cwd` of a session header, preserving every later frame.
 * @param file - session log path.
 * @param replacement - new cwd.
 * @returns nothing; throws on an unreadable or unexpected log.
 */
export function rewriteSessionCwd(file, replacement) {
  const read = readSessionHeader(file)
  if (read.error !== undefined) throw new Error(read.error)
  const header = { ...read.header, cwd: replacement }
  const line = `${JSON.stringify(header)}\n`
  const frame = zstdCompressSync(Buffer.from(line, 'utf8'))
  // Keep everything after the header frame byte-for-byte: every later event
  // frame, plus any trailing partial append a live session left behind.
  const tail = read.buffer.subarray(read.firstFrameBytes)
  atomicWrite(file, Buffer.concat([frame, tail]))
  const check = readSessionHeader(file)
  if (check.error !== undefined) throw new Error(`写入后无法读回：${check.error}`)
  if (check.header.cwd !== replacement) throw new Error('写入后 cwd 校验失败')
}

/**
 * Write a file through a temporary sibling, then rename over the target.
 * @param file - destination path.
 * @param data - bytes or text.
 */
export function atomicWrite(file, data) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temp, data)
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best effort: a leftover temp file is better than a lost original.
    }
    throw error
  }
}

/**
 * List every session log under a vault.
 * @param vaultRoot - vault directory.
 * @returns absolute log paths.
 */
export function listSessionLogs(vaultRoot) {
  const sessions = join(vaultRoot, 'sessions')
  if (!existsSync(sessions)) return []
  const out = []
  for (const group of readdirSync(sessions, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(sessions, group.name)
    for (const session of readdirSync(groupDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDir = join(groupDir, session.name)
      for (const file of readdirSync(sessionDir, { withFileTypes: true })) {
        if (!file.isFile()) continue
        if (!/^session(\.[0-9a-z]+)?\.jsonl\.zstd$/i.test(file.name)) continue
        out.push(join(sessionDir, file.name))
      }
    }
  }
  return out
}

/**
 * Decide what a repair would change. Never writes.
 * @param options - vault and environment.
 * @returns a plan with remaps, group renames, header rewrites and warnings.
 */
export function buildRepairPlan({ vaultRoot, drives, pathExists = existsSync }) {
  const root = resolve(vaultRoot)
  const target = driveOf(root)
  const warnings = []

  const indexPath = join(root, 'storages', 'workspace.json')
  if (!existsSync(indexPath)) {
    return { root, target, error: `找不到 ${indexPath}` }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
  } catch (error) {
    return { root, target, error: `索引无法解析：${error instanceof Error ? error.message : String(error)}` }
  }
  const tables = parsed?.tables?.workspaces
  const ids = parsed?.global?.workspaceIds
  if (tables === undefined || !Array.isArray(ids)) {
    return { root, target, error: '索引结构不是 workspace v2' }
  }
  const workspaces = ids.map((id) => ({ id, ...(tables[id] ?? {}) }))

  const groupNames = existsSync(join(root, 'sessions'))
    ? readdirSync(join(root, 'sessions'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : []

  const drift = detectDrift({ workspaces, sessionGroups: groupNames, drives, pathExists, targetLetter: target })

  const remaps = drift.findings
    .filter((finding) => finding.kind === 'drive-missing' && finding.confident === true)
    .map((finding) => ({ workspaceId: finding.workspaceId, from: finding.path, to: finding.remappedPath }))

  for (const finding of drift.findings) {
    if (finding.kind === 'drive-missing' && finding.confident !== true) {
      warnings.push(`工作区「${finding.title ?? finding.workspaceId}」无法自动判定：${finding.detail}`)
    }
    if (finding.kind === 'not-absolute') warnings.push(finding.detail)
  }

  const groupRenames = []
  for (const group of drift.groups) {
    if (group.suggestedName === undefined) continue
    const targetPath = join(root, 'sessions', group.suggestedName)
    if (existsSync(targetPath)) {
      warnings.push(`会话分组 ${group.suggestedName} 已存在，跳过 ${group.name}`)
      continue
    }
    groupRenames.push({ from: group.name, to: group.suggestedName })
  }

  // Session headers: every log whose cwd still names a missing drive.
  const headerRewrites = []
  for (const file of listSessionLogs(root)) {
    const read = readSessionHeader(file)
    if (read.error !== undefined) {
      warnings.push(`${relative(root, file)} 无法解析，跳过：${read.error}`)
      continue
    }
    const cwd = read.header.cwd
    const drive = driveOf(cwd)
    if (drive === undefined || drives.includes(drive)) continue
    const rest = cwd.slice(2).replace(/^[\\/]+/, '')
    const candidates = drives.filter((candidate) => pathExists(join(`${candidate}\\`, rest)))
    if (candidates.length !== 1) {
      warnings.push(
        `${relative(root, file)} 的 cwd 是 ${cwd}，但${candidates.length === 0 ? '没有找到对应目录' : '有多个盘都匹配'}，跳过`,
      )
      continue
    }
    headerRewrites.push({
      file,
      from: cwd,
      to: join(`${candidates[0]}\\`, rest),
    })
  }

  return {
    root,
    target,
    remaps,
    groupRenames,
    headerRewrites,
    warnings,
    ok: remaps.length === 0 && groupRenames.length === 0 && headerRewrites.length === 0,
  }
}

/**
 * Apply a plan: back up, write the index, rename groups, rewrite headers.
 * @param plan - result of {@link buildRepairPlan}.
 * @param options - optional clock and label.
 * @returns what was done, plus backup location.
 */
export function applyRepairPlan(plan, options = {}) {
  if (plan.error !== undefined) throw new Error(plan.error)
  if (plan.ok === true) return { ok: true, changes: 0, backup: undefined, actions: [] }
  const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(plan.root, BACKUP_DIR, stamp)
  const actions = []

  // 1. Back up everything that will change, before any write.
  mkdirSync(backup, { recursive: true })
  const indexPath = join(plan.root, 'storages', 'workspace.json')
  copyFileSync(indexPath, join(backup, 'workspace.json'))
  for (const rewrite of plan.headerRewrites) {
    const rel = relative(plan.root, rewrite.file)
    const dst = join(backup, rel)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(rewrite.file, dst)
  }
  actions.push(`备份 -> ${backup}`)

  // 2. Index: rewrite only the drifted workspace paths.
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
  for (const remap of plan.remaps) {
    parsed.tables.workspaces[remap.workspaceId].path = remap.to
    parsed.tables.workspaces[remap.workspaceId].updatedAt = new Date().toISOString()
    actions.push(`索引 ${remap.workspaceId}: ${remap.from} -> ${remap.to}`)
  }
  atomicWrite(indexPath, `${JSON.stringify(parsed, null, 2)}\n`)

  // 3. Group directories.
  for (const rename of plan.groupRenames) {
    renameSync(join(plan.root, 'sessions', rename.from), join(plan.root, 'sessions', rename.to))
    actions.push(`分组 ${rename.from} -> ${rename.to}`)
  }

  // 4. Headers, at their (possibly renamed) locations.
  for (const rewrite of plan.headerRewrites) {
    let file = rewrite.file
    for (const rename of plan.groupRenames) {
      const after = join(plan.root, 'sessions', rename.to)
      const before = join(plan.root, 'sessions', rename.from)
      if (file.startsWith(before)) file = join(after, relative(before, file))
    }
    rewriteSessionCwd(file, rewrite.to)
    actions.push(`header ${relative(plan.root, file)}: ${rewrite.from} -> ${rewrite.to}`)
  }

  writeFileSync(
    join(backup, 'repair.json'),
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        target: plan.target,
        remaps: plan.remaps,
        groupRenames: plan.groupRenames,
        headerRewrites: plan.headerRewrites.map((item) => ({ file: relative(plan.root, item.file), from: item.from, to: item.to })),
        warnings: plan.warnings,
      },
      null,
      2,
    )}\n`,
  )

  return { ok: true, changes: actions.length, backup, actions }
}
