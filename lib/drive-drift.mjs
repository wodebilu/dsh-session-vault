/**
 * Drive-letter drift detection.
 *
 * A vault carried between machines keeps absolute paths: the workspace index
 * and the session directory names both freeze the drive letter that was in use
 * when the record was written. Plug the same drive into a machine with a
 * different partition count and every one of those paths points at a letter
 * that no longer exists.
 *
 * This module only *detects* that. It never writes: the caller decides whether
 * to offer a repair, and a repair has to touch three things at once (index
 * path, session group directory, session header cwd) or sessions disappear.
 *
 * Everything is injected (`drives`, `pathExists`) so a test can simulate a
 * machine with a different set of drives without touching a real one.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DRIVE = /^([A-Za-z]):/
const GROUP = /^--([A-Za-z])-/

/**
 * List mounted drive letters.
 * @param exists - existence probe, injected for tests.
 * @returns drive letters such as `E:`.
 */
export function listDrives(exists = existsSync) {
  const out = []
  for (let code = 65; code <= 90; code += 1) {
    const letter = `${String.fromCharCode(code)}:`
    if (exists(`${letter}\\`)) out.push(letter)
  }
  return out
}

/**
 * Extract the drive letter of an absolute Windows path.
 * @param path - candidate path.
 * @returns `E:` style letter, or undefined.
 */
export function driveOf(path) {
  const match = DRIVE.exec(typeof path === 'string' ? path : '')
  return match === null ? undefined : `${match[1].toUpperCase()}:`
}

/**
 * Strip the drive prefix from an absolute path.
 * @param path - absolute path.
 * @returns the remainder without a leading separator.
 */
export function restOf(path) {
  const text = typeof path === 'string' ? path : ''
  return DRIVE.test(text) ? text.slice(2).replace(/^[\\/]+/, '') : text
}

/**
 * Detect workspaces whose drive letter is gone, and rewrite that letter only.
 *
 * The anchor is the drive the vault itself sits on: a carried vault keeps its
 * internal layout, so `E:\aaa` on one machine is `F:\aaa` on another. One
 * letter substitution, no search for "which drive has a folder with this name".
 * A recorded drive that is still mounted is left alone — those paths belong to
 * the machine, not to the carried vault.
 *
 * @param options - detection inputs.
 * @param options.workspaces - `{ id, path, title }` records from the index.
 * @param options.sessionGroups - session group directory names.
 * @param options.drives - mounted drive letters.
 * @param options.pathExists - existence probe.
 * @param options.targetLetter - letter the vault now lives on, used to suggest renames.
 * @returns findings; `ok` is true when nothing drifts.
 */
export function detectDrift({
  workspaces = [],
  sessionGroups = [],
  drives,
  pathExists = existsSync,
  targetLetter,
}) {
  const findings = []
  const missing = []

  for (const workspace of workspaces) {
    const path = workspace?.path
    const drive = driveOf(path)
    if (drive === undefined) {
      findings.push({
        kind: 'not-absolute',
        workspaceId: workspace?.id,
        path,
        detail: '工作区路径不是绝对路径，无法判断盘符',
      })
      continue
    }
    if (drives.includes(drive)) {
      // The letter is mounted, but that says nothing about this machine: a vault
      // written on another PC keeps that PC's user directory. Say so.
      if (!pathExists(path)) {
        missing.push({
          kind: 'folder-missing',
          workspaceId: workspace?.id,
          title: workspace?.title,
          path,
          detail: `盘符 ${drive} 存在，但这个目录不存在（可能来自另一台电脑）`,
        })
      }
      continue
    }

    const rest = restOf(path)
    const remappedPath = targetLetter === undefined ? undefined : join(`${targetLetter}\\`, rest)
    findings.push({
      kind: 'drive-missing',
      workspaceId: workspace?.id,
      title: workspace?.title,
      path,
      drive,
      targetLetter,
      remappedPath,
      targetExists: remappedPath === undefined ? false : pathExists(remappedPath),
      detail:
        remappedPath === undefined
          ? `盘符 ${drive} 不存在，且不知道库现在在哪个盘`
          : `盘符 ${drive} 不存在，按库所在盘换算为 ${remappedPath}`,
    })
  }

  const groups = []
  for (const name of sessionGroups) {
    const match = GROUP.exec(name)
    if (match === null) continue
    const drive = `${match[1].toUpperCase()}:`
    if (drives.includes(drive)) continue
    groups.push({
      kind: 'group-drive-missing',
      name,
      drive,
      suggestedName: targetLetter === undefined ? undefined : renameGroup(name, targetLetter),
      detail: `会话分组目录仍按 ${drive} 命名，改路径后必须同步改名，否则会话会从侧栏消失`,
    })
  }

  return { findings, groups, missing, ok: findings.length === 0 && groups.length === 0 }
}

/**
 * Suggest the renamed group directory for a changed drive letter.
 * @param name - current group directory name.
 * @param letter - new drive letter such as `E:`.
 * @returns the renamed directory, or undefined when the name is not a group.
 */
export function renameGroup(name, letter) {
  const match = GROUP.exec(name)
  if (match === null) return undefined
  return name.replace(/^--[A-Za-z]-/, `--${letter[0].toUpperCase()}-`)
}
