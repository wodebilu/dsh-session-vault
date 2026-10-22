/**
 * Print a drive-drift report for one vault directory.
 *
 * Read-only: this never writes to the vault, the index, or the session logs.
 *
 *   node tools/drift-report.mjs "E:\About DSH\My friend's memory"
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { detectDrift, driveOf, listDrives } from '../lib/drive-drift.mjs'

/**
 * Read the workspace index of a vault.
 * @param vaultRoot - vault directory.
 * @returns workspace records and the raw tables, or undefined when unreadable.
 */
function readIndex(vaultRoot) {
  const file = join(vaultRoot, 'storages', 'workspace.json')
  if (!existsSync(file)) return undefined
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { error: `索引无法解析：${error instanceof Error ? error.message : String(error)}` }
  }
  const tables = parsed?.tables?.workspaces
  const ids = parsed?.global?.workspaceIds
  if (tables === undefined || !Array.isArray(ids)) {
    return { error: '索引结构不符合 workspace v2（缺少 tables.workspaces 或 global.workspaceIds）' }
  }
  return {
    workspaces: ids.map((id) => ({ id, ...(tables[id] ?? {}) })),
    count: ids.length,
  }
}

/**
 * List session group directories of a vault.
 * @param vaultRoot - vault directory.
 * @returns directory names.
 */
function readGroups(vaultRoot) {
  const dir = join(vaultRoot, 'sessions')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * Render the report as text.
 * @param vaultRoot - vault directory.
 * @returns lines to print.
 */
function report(vaultRoot) {
  const drives = listDrives()
  const index = readIndex(vaultRoot)
  const groups = readGroups(vaultRoot)
  const lines = []

  lines.push(`库目录   ${vaultRoot}`)
  lines.push(`当前盘符 ${drives.join('  ')}`)
  if (index === undefined) {
    lines.push('')
    lines.push('✗ 这个目录里没有 storages/workspace.json，看起来不是 DSH 库。')
    return lines
  }
  if (index.error !== undefined) {
    lines.push('')
    lines.push(`✗ ${index.error}`)
    return lines
  }
  lines.push(`工作区   ${index.count} 个`)
  lines.push(`会话分组 ${groups.length} 个`)
  lines.push('')

  const result = detectDrift({
    workspaces: index.workspaces,
    sessionGroups: groups,
    drives,
    targetLetter: driveOf(root),
  })

  if (result.ok) {
    lines.push('✓ 没有发现盘符漂移，所有路径都在当前挂载的盘上。')
    return lines
  }

  for (const finding of result.findings) {
    lines.push(`✗ 工作区「${finding.title ?? finding.workspaceId}」`)
    lines.push(`    记录路径 ${finding.path}`)
    lines.push(`    ${finding.detail}`)
    if (finding.remappedPath !== undefined) {
      lines.push(`    建议改为 ${finding.remappedPath}`)
    }
    lines.push('')
  }

  for (const item of result.missing) {
    lines.push(`! 工作区「${item.title ?? item.workspaceId}」`)
    lines.push(`    记录路径 ${item.path}`)
    lines.push(`    ${item.detail}`)
    lines.push('    这不是盘符问题，只能由你指定新位置。')
    lines.push('')
  }

  for (const group of result.groups) {
    lines.push(`✗ 会话分组 ${group.name}`)
    lines.push(`    ${group.detail}`)
    if (group.suggestedName !== undefined) lines.push(`    建议改名为 ${group.suggestedName}`)
    lines.push('')
  }

  lines.push('以上只是报告，没有修改任何文件。')
  return lines
}

const target = process.argv[2]
if (target === undefined) {
  console.error('用法：node tools/drift-report.mjs <库目录>')
  process.exit(2)
}
const root = resolve(target)
if (!existsSync(root)) {
  console.error(`目录不存在：${root}`)
  process.exit(2)
}
for (const line of report(root)) console.log(line)
