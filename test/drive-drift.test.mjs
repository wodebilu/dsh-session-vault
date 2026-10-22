import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectDrift, driveOf, listDrives, renameGroup, restOf } from '../lib/drive-drift.mjs'

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

  it('finds the single drive that holds the same folder', () => {
    const result = detectDrift({
      workspaces,
      sessionGroups: [],
      drives: ['C:', 'D:', 'E:'],
      pathExists: (path) => path === 'E:\\About DSH\\Work place\\QQ little tools',
    })
    assert.equal(result.ok, false)
    assert.equal(result.findings.length, 1)
    const [finding] = result.findings
    assert.equal(finding.kind, 'drive-missing')
    assert.equal(finding.drive, 'F:')
    assert.equal(finding.confident, true)
    assert.equal(finding.remappedPath, 'E:\\About DSH\\Work place\\QQ little tools')
  })

  it('refuses to guess when two drives carry the same folder', () => {
    const result = detectDrift({
      workspaces,
      sessionGroups: [],
      drives: ['C:', 'D:', 'E:'],
      pathExists: () => true,
    })
    const [finding] = result.findings
    assert.equal(finding.confident, false)
    assert.equal(finding.remappedPath, undefined)
    assert.deepEqual(finding.candidates, ['C:', 'D:', 'E:'])
  })

  it('reports a genuinely missing folder separately', () => {
    const result = detectDrift({
      workspaces,
      sessionGroups: [],
      drives: ['C:', 'D:'],
      pathExists: () => false,
    })
    const [finding] = result.findings
    assert.equal(finding.candidates.length, 0)
    assert.equal(finding.remappedPath, undefined)
    assert.match(finding.detail, /也没有同名目录/)
  })

  it('flags session groups built from a missing drive', () => {
    const result = detectDrift({
      workspaces: [],
      sessionGroups: ['--F-About~0020DSH-Work~0020place--', '--C-Users-ASUS-Documents--'],
      drives: ['C:', 'E:'],
      pathExists: () => true,
    })
    assert.equal(result.findings.length, 0)
    assert.equal(result.groups.length, 1)
    assert.equal(result.groups[0].drive, 'F:')
    assert.equal(result.ok, false)
  })

  it('reports a folder that is absent on a mounted drive', () => {
    const result = detectDrift({
      workspaces: [{ id: 'w', path: 'C:\\Users\\ASUS\\Documents\\x' }],
      sessionGroups: [],
      drives: ['C:'],
      pathExists: () => false,
    })
    assert.equal(result.findings.length, 0)
    assert.equal(result.missing.length, 1)
    assert.match(result.missing[0].detail, /另一台电脑/)
  })

  it('suggests a rename toward the letter the vault now lives on', () => {
    const result = detectDrift({
      workspaces: [],
      sessionGroups: ['--F-About~0020DSH--'],
      drives: ['C:', 'E:'],
      targetLetter: 'E:',
    })
    assert.equal(result.groups[0].suggestedName, '--E-About~0020DSH--')
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

describe('platform guard', () => {
  it('is meaningful on Windows only', () => {
    if (process.platform !== WIN) {
      assert.ok(true)
      return
    }
    assert.ok(listDrives().includes(`${process.env.SystemDrive?.[0] ?? 'C'}:`))
  })
})
