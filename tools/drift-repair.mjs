/**
 * Repair drive-letter drift in one vault.
 *
 *   node tools/drift-repair.mjs "E:\...\My friend's memory"           # dry run
 *   node tools/drift-repair.mjs "E:\...\My friend's memory" --apply   # write
 *
 * Everything is backed up under `<vault>/_drift-backup/<timestamp>/` first.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { listDrives } from '../lib/drive-drift.mjs'
import { applyRepairPlan, buildRepairPlan } from '../lib/drift-repair.mjs'

const args = process.argv.slice(2)
const target = args.find((arg) => !arg.startsWith('--'))
const apply = args.includes('--apply')

if (target === undefined) {
  console.error('用法：node tools/drift-repair.mjs <库目录> [--apply]')
  process.exit(2)
}
const root = resolve(target)
if (!existsSync(root)) {
  console.error(`目录不存在：${root}`)
  process.exit(2)
}

const plan = buildRepairPlan({ vaultRoot: root, drives: listDrives() })
if (plan.error !== undefined) {
  console.error(`✗ ${plan.error}`)
  process.exit(1)
}

console.log(`库目录 ${root}`)
console.log(`目标盘符 ${plan.target}`)
console.log('')

if (plan.ok === true) {
  console.log('✓ 没有需要修正的内容。')
  process.exit(0)
}

for (const remap of plan.remaps) {
  console.log(`工作区 ${remap.from}`)
  console.log(`    -> ${remap.to}`)
}
for (const rename of plan.groupRenames) {
  console.log(`会话分组 ${rename.from}`)
  console.log(`    -> ${rename.to}`)
}
for (const rewrite of plan.headerRewrites) {
  console.log(`会话头 ${rewrite.file.replace(root, '.')}`)
  console.log(`    ${rewrite.from} -> ${rewrite.to}`)
}
if (plan.warnings.length > 0) {
  console.log('')
  for (const warning of plan.warnings) console.log(`! ${warning}`)
}

console.log('')
if (!apply) {
  console.log('以上是预演，没有修改任何文件。确认无误后加 --apply 执行。')
  process.exit(0)
}

const result = applyRepairPlan(plan)
for (const action of result.actions) console.log(`+ ${action}`)
console.log('')
console.log(`完成，共 ${result.changes} 项。备份在 ${result.backup}`)

const after = buildRepairPlan({ vaultRoot: root, drives: listDrives() })
console.log(after.ok === true ? '✓ 复查通过：不再有漂移。' : '! 复查仍有残留，见上面输出。')
