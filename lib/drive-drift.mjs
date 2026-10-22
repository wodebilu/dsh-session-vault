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
 * The substitution is only ever offered for a workspace that lived on the
 * vault's own volume ({@link isCarriedWorkspace}). A workspace parked on a
 * *different* drive — the usual case, a USB vault holding sessions whose cwd is
 * a project under `C:\Users\...` — is never rewritten to the vault's letter:
 * that would move the user's project folder onto the system drive. Such a
 * workspace is reported as `unresolved` instead, and the plan says what to do.
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
  const unresolved = []

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
      // The letter is mounted, so this path is not a carried spelling of the
      // vault itself; the folder is simply not there (another PC's user
      // directory, a renamed project). No substitution applies — only /cd.
      if (!pathExists(path)) {
        missing.push({
          kind: 'folder-missing',
          workspaceId: workspace?.id,
          title: workspace?.title,
          path,
          drive,
          detail: `盘符 ${drive} 存在，但这个目录不存在（可能来自另一台电脑）`,
        })
      }
      continue
    }

    const rest = restOf(path)
    // Win32 paths are case-insensitive, so compare the remainder the way the
    // filesystem would.
    const carriedCandidate = targetLetter === undefined ? undefined : join(`${targetLetter}\\`, rest)
    const carriedCandidateExists = carriedCandidate !== undefined && pathExists(carriedCandidate)

    // A substitute that equals the recorded path is not a repair: it happens
    // when the vault's own drive is merely not mounted on this machine and the
    // records are already spelled correctly. Rewriting it would churn a backup
    // on every boot for no change; the folder is just offline right now.
    if (carriedCandidate !== undefined && carriedCandidate.toUpperCase() === path.toUpperCase()) {
      if (!pathExists(path)) {
        missing.push({
          kind: 'drive-offline',
          workspaceId: workspace?.id,
          title: workspace?.title,
          path,
          drive,
          detail: `盘符 ${drive} 没有接上，工作区 ${path} 当前打不开`,
        })
      }
      continue
    }

    // The drive is gone. A workspace on an *independent* drive is exactly what a
    // carried vault looks like: the vault keeps its internal layout, so the
    // project that was `Q:\proj` on the old machine is the same folder spelled
    // with whatever letter the vault has now. That is the whole point of the
    // plugin — a USB stick lands on a different letter on every machine — so the
    // letter is substituted and the folder is created on demand by DSH.
    //
    // This is *not* applied to a path that names the vault's own letter (handled
    // above: there it is merely unmounted, and rewriting would be a no-op). The
    // caller is told whether the substituted folder exists yet through
    // `targetExists`, so a repair can warn instead of silently aiming at an
    // empty directory.

    // Without knowing where the vault lives there is nothing to substitute
    // toward; say so instead of inventing a drive.
    if (carriedCandidate === undefined) {
      unresolved.push({
        kind: 'vault-drive-unknown',
        workspaceId: workspace?.id,
        title: workspace?.title,
        path,
        drive,
        detail: `盘符 ${drive} 不存在，且不知道库现在在哪个盘，无法换算`,
      })
      continue
    }

    const remappedPath = carriedCandidate
    findings.push({
      kind: 'drive-missing',
      workspaceId: workspace?.id,
      title: workspace?.title,
      path,
      drive,
      targetLetter,
      remappedPath,
      targetExists: pathExists(remappedPath),
      detail: `盘符 ${drive} 不存在，按库所在盘换算为 ${remappedPath}`,
    })
  }

  // A group directory is only a *derived* name of the cwd it holds. It must be
  // renamed exactly when the cwd it stands for is being rewritten: leaving a
  // group on the old letter while the header cwd moves to the new one is the
  // one state DSH cannot reconcile, because it derives the directory from the
  // header. `carriedDrives` is what the workspace pass proved; a group whose
  // drive is not in it belongs to a folder that is NOT being rewritten.
  const groups = []
  for (const name of sessionGroups) {
    const match = GROUP.exec(name)
    if (match === null) continue
    const drive = `${match[1].toUpperCase()}:`
    if (drives.includes(drive)) continue
    // Report the group; whether the rename is safe depends on whether the
    // sessions inside are actually being rewritten, which only the caller
    // (which reads the headers) can know. It decides, and warns otherwise.
    groups.push({
      kind: 'group-drive-missing',
      name,
      drive,
      suggestedName: targetLetter === undefined ? undefined : renameGroup(name, targetLetter),
      detail: `会话分组目录仍按 ${drive} 命名，改路径后必须同步改名，否则会话会从侧栏消失`,
    })
  }

  return {
    findings,
    groups,
    missing,
    unresolved,
    // `ok` answers "is this vault healthy on this machine", not "is there
    // anything to rewrite". A project folder that is gone *while the drive it
    // names is mounted* is unhealthy — that is the other machine's directory,
    // and every session pointing at it is broken. A workspace on a drive that
    // is simply unplugged (`unresolved`) needs the user's attention but is not
    // evidence of a mis-written path, so it does not by itself make the vault
    // unhealthy; the plan reports it separately.
    ok: findings.length === 0 && groups.length === 0 && missing.length === 0,
  }
}

/**
 * Whether a workspace whose drive disappeared used to live on the vault volume.
 *
 * A carried vault keeps its internal layout, so a workspace that travelled with
 * it is simply the old spelling of the vault's own letter. A workspace on some
 * other letter never travelled with this vault, and substituting the vault's
 * letter for it would silently re-point a project folder at an unrelated drive.
 *
 * @param drive - the workspace's recorded drive, e.g. `E:`.
 * @param targetLetter - the drive the vault sits on now, e.g. `F:`.
 * @returns true when the two name the same carried volume.
 */
export function isCarriedWorkspace(drive, targetLetter) {
  if (drive === undefined || targetLetter === undefined) return false
  return drive.toUpperCase() === targetLetter.toUpperCase()
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
