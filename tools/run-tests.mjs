#!/usr/bin/env node
/**
 * Run the regression suite on any supported Node.
 *
 * Two constraints pull in opposite directions:
 *   - inside the DSH sandbox shell, the test runner cannot spawn child
 *     processes, so isolation has to be off (`--test-isolation=none`);
 *   - that flag only exists from Node 24, while `engines` still allows 22 and CI
 *     exercises both. Passing it to 22 aborts the run with
 *     `node: bad option: --test-isolation=none` before a single test starts.
 *
 * So probe for the flag instead of assuming it. When it is unavailable the run
 * falls back to `--test-concurrency=1`, which every supported version accepts and
 * which keeps the suite out of the process pool's way as far as it can.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = join(import.meta.dirname, '..', 'test')

/** Whether this Node accepts `--test-isolation=none`. */
function supportsIsolationFlag() {
  const probe = spawnSync(process.execPath, ['--test-isolation=none', '--eval', ''], {
    stdio: 'ignore',
  })
  return probe.status === 0
}

const files = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(TEST_DIR, name))

if (files.length === 0) {
  console.error('no test files found in', TEST_DIR)
  process.exit(1)
}

const args = ['--test']
if (supportsIsolationFlag()) args.push('--test-isolation=none')
else args.push('--test-concurrency=1')
args.push(...files)

const run = spawnSync(process.execPath, args, { stdio: 'inherit' })
process.exit(run.status ?? 1)
