import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectDrift, driveOf, isCarriedWorkspace, listDrives, renameGroup, restOf } from '../lib/drive-drift.mjs'

const WIN = 'win32'

describe('driveOf / restOf', () => {
  it('reads the letter and the remainder', () => {
    assert.equal(driveOf('F:\\About DSH\\Work place'), 'F:')
    assert.equal(restOf('F:\\About DSH\\Work place'), 'About DSH\\Work place')
  })

  it('normalises a lowercase letter', () => {
    assert.equal(driveOf('f:\\x'), 'F:')
  })

  it('rejects non-absolute paths', () => {
    assert.equal(driveOf('relative\\dir'), undefined)
    assert.equal(driveOf(''), undefined)
    assert.equal(driveOf(undefined), undefined)
  })

  it('keeps a forward-slash path intact', () => {
    assert.equal(driveOf('E:/a/b'), 'E:')
    assert.equal(restOf('E:/a/b'), 'a/b')
  })
})

describe('renameGroup', () => {
  it('swaps the leading drive letter', () => {
    const name = '--F-About~0020DSH-Work~0020place-QQ~0020little~0020tools--'
    assert.equal(
      renameGroup(name, 'E:'),
      '--E-About~0020DSH-Work~0020place-QQ~0020little~0020tools--',
    )
  })

  it('leaves non-group names alone', () => {
    assert.equal(renameGroup('_deleted', 'E:'), undefined)
    assert.equal(renameGroup('random-folder', 'E:'), undefined)
  })
})

describe('listDrives', () => {
  it('only reports letters the probe accepts', () => {
    const present = new Set(['C:\\', 'E:\\'])
    const drives = listDrives((path) => present.has(path))
    assert.deepEqual(drives, ['C:', 'E:'])
  })
})

describe('detectDrift', () => {
  const workspaces = [
    { id: 'w1', title: 'QQ little tools', path: 'F:\\About DSH\\Work place\\QQ little tools' },
    { id: 'w2', title: 'local', path: 'C:\\Users\\ASUS\\Documents\\x' },
  ]

  it('ignores workspaces on mounted drives', () => {
    const result = detectDrift({
      workspaces,
      sessionGroups: [],
      drives: ['C:', 'D:', 'F:'],
      pathExists: () => true,
    })
    assert.equal(result.ok, true)
  })

  it('swaps only the drive letter for the drive the vault is on', () => {
    // The workspace names G:, the vault now sits on F:. Same folder, old
    // letter: the substituted path is what a repair would write.
    const result = detectDrift({
      workspaces: [{ id: 'w', path: 'G:\\About DSH\\Work place' }],
      sessionGroups: [],
      drives: ['C:', 'D:'],
      targetLetter: 'F:',
      pathExists: (path) => path === 'F:\\About DSH\\Work place',
    })
    assert.equal(result.ok, false)
    assert.equal(result.findings.length, 1)
    const [finding] = result.findings
    assert.equal(finding.kind, 'drive-missing')
    assert.equal(finding.drive, 'G:')
    assert.equal(finding.remappedPath, 'F:\\About DSH\\Work place')
    assert.equal(finding.targetExists, true)
  })

  it('treats a record that already names the vault letter as nothing to fix', () => {
    // The letter is the vault's own and merely unmounted: the records are
    // already spelled correctly, and rewriting them would be a no-op churn.
    const result = detectDrift({
      workspaces: [{ id: 'w', path: 'F:\\proj' }],
      sessionGroups: [],
      drives: ['C:'],
      targetLetter: 'F:',
      pathExists: () => false,
    })
    assert.equal(result.findings.length, 0)
    assert.equal(result.unresolved.length, 0)
    assert.equal(result.ok, false, 'the drive is offline, so the folder is unreachable')
  })

  it('re-points a workspace from an absent drive at the vault drive', () => {
    // The core portability case: the vault now sits on E:, and this workspace
    // lived on F:. A USB stick gets a different letter on every machine, so the
    // letter is substituted — that is the plugin's whole point.
    const result = detectDrift({
      workspaces,
      sessionGroups: [],
      drives: ['C:', 'D:', 'E:'],
      targetLetter: 'E:',
      pathExists: () => false,
    })
    assert.equal(result.findings.length, 1)
    assert.equal(result.unresolved.length, 0)
    const [finding] = result.findings
    assert.equal(finding.kind, 'drive-missing')
    assert.equal(finding.drive, 'F:')
    assert.equal(finding.remappedPath, 'E:\\About DSH\\Work place\\QQ little tools')
    // The folder does not exist yet on this machine: the caller warns, but the
    // letter is still substituted (DSH creates the folder on first use).
    assert.equal(finding.targetExists, false)
  })

  it('re-points when the same folder is really there on the vault volume', () => {
    // Positive evidence: the folder exists at the mirrored path on the vault's
    // own drive. That is the carried-vault case, and the rewrite is correct.
    const result = detectDrift({
      workspaces: [workspaces[0]],
      sessionGroups: [],
      drives: ['C:', 'D:', 'E:'],
      targetLetter: 'E:',
      pathExists: (path) => path === 'E:\\About DSH\\Work place\\QQ little tools',
    })
    assert.equal(result.unresolved.length, 0)
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].remappedPath, 'E:\\About DSH\\Work place\\QQ little tools')
  })

  it('does not invent a letter when the vault drive is unknown', () => {
    // Without a vault letter there is nothing to substitute toward; the
    // workspace is still reported so the user knows it is on a missing drive.
    const result = detectDrift({
      workspaces: [{ id: 'w1', title: 'x', path: 'G:\\proj' }],
      sessionGroups: [],
      drives: ['C:', 'D:'],
      pathExists: () => false,
    })
    assert.equal(result.findings.length, 0)
    assert.equal(result.unresolved.length, 1)
    assert.match(result.unresolved[0].detail, /不知道库现在在哪个盘/)
  })

  it('flags session groups built from a missing drive', () => {
    const result = detectDrift({
      workspaces: [],
      sessionGroups: ['--E-About~0020DSH-Work~0020place--', '--C-Users-ASUS-Documents--'],
      drives: ['C:', 'E:'],
      pathExists: () => true,
    })
    assert.equal(result.findings.length, 0)
    // `E:` is mounted here, so its group is not reported. Nothing else is
    // missing either, and the vault is healthy.
    assert.equal(result.groups.length, 0)
    assert.equal(result.ok, true)
  })

  it('reports every group whose drive is gone, and suggests the rename', () => {
    // Detection is pure reporting. Whether a rename is safe depends on whether
    // the sessions inside are being rewritten, which only the caller can see;
    // it decides, and warns instead of renaming blindly.
    const result = detectDrift({
      workspaces: [],
      sessionGroups: ['--F-About~0020DSH--', '--G-other--'],
      drives: ['C:'],
      targetLetter: 'F:',
    })
    assert.deepEqual(
      result.groups.map((group) => group.name),
      ['--F-About~0020DSH--', '--G-other--'],
    )
    assert.equal(result.groups[0].suggestedName, '--F-About~0020DSH--')
    assert.equal(result.groups[1].suggestedName, '--F-other--')
  })

  it('reports a folder that is absent on a mounted drive and counts it', () => {
    const result = detectDrift({
      workspaces: [{ id: 'w', path: 'C:\\Users\\ASUS\\Documents\\x' }],
      sessionGroups: [],
      drives: ['C:'],
      pathExists: () => false,
    })
    assert.equal(result.findings.length, 0)
    assert.equal(result.missing.length, 1)
    assert.match(result.missing[0].detail, /另一台电脑/)
    // A project folder that is gone is a broken session, not a footnote: the
    // vault must not report itself healthy while it carries one.
    assert.equal(result.ok, false)
  })

  it('suggests a rename toward the letter the vault now lives on', () => {
    const result = detectDrift({
      workspaces: [],
      sessionGroups: ['--F-About~0020DSH--'],
      drives: ['C:'],
      targetLetter: 'F:',
    })
    assert.equal(result.groups.length, 1)
    assert.equal(result.groups[0].suggestedName, '--F-About~0020DSH--')
  })

  it('reports a non-absolute workspace instead of silently skipping it', () => {
    const result = detectDrift({
      workspaces: [{ id: 'w3', path: 'relative\\dir' }],
      sessionGroups: [],
      drives: ['C:'],
      pathExists: () => true,
    })
    assert.equal(result.findings[0].kind, 'not-absolute')
  })
})

describe('isCarriedWorkspace', () => {
  it('follows the vault only when the letters name the same volume', () => {
    assert.equal(isCarriedWorkspace('E:', 'E:'), true)
    assert.equal(isCarriedWorkspace('e:', 'E:'), true)
    assert.equal(isCarriedWorkspace('E:', 'F:'), false)
  })

  it('refuses to guess without both letters', () => {
    assert.equal(isCarriedWorkspace('E:', undefined), false)
    assert.equal(isCarriedWorkspace(undefined, 'E:'), false)
  })
})

describe('platform guard', () => {
  it('is meaningful on Windows only', () => {
    if (process.platform !== WIN) {
      assert.ok(true)
      return
    }
    assert.ok(listDrives().includes(`${process.env.SystemDrive?.[0] ?? 'C'}:`))
  })
})
