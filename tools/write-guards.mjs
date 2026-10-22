#!/usr/bin/env node
/**
 * Regenerate the three `!!js` guard expressions in `cordis.patch.yml` from one
 * source, so the three DSH roots can never disagree about whether the vault is
 * usable.
 *
 * Why a generator instead of three hand-written strings:
 *   The Loader evaluates each expression in isolation before any Workspace or
 *   Session exists, so they cannot `import` a module. Keeping three copies of
 *   the same decision is how `sessions` once fell back to the local default
 *   while `storages` still pointed at the vault: each copy drifted on its own.
 *   Here the decision is written once — `DECISION` below — and only the root
 *   that is finally returned differs.
 *
 * Usage:
 *   node tools/write-guards.mjs           # rewrite cordis.patch.yml in place
 *   node tools/write-guards.mjs --check   # exit 1 when the file is stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PATCH = join(import.meta.dirname, '..', 'cordis.patch.yml')

/**
 * The one decision, as an immediately-invoked function returning
 * `{ home, lib, why }`:
 *   - `home`  the harness home (`.dsh`), always present;
 *   - `lib`   the library directory when it may be used, else `null`;
 *   - `why`   a one-word trace for `session-vault-boot.log`.
 *
 * `prepare` may be `undefined`; when it is a function the missing/empty library
 * is created and seeded in place. Only the sessions root passes one, because it
 * runs first and the other two must observe its result rather than duplicate it.
 * @param prepare - optional seeder.
 * @returns the expression source text.
 */
function decision(prepare) {
  return (
    '(() => {' +
    " const fs = process.getBuiltinModule('node:fs');" +
    " const p = process.getBuiltinModule('node:path');" +
    " const os = process.getBuiltinModule('node:os');" +
    " const text = (v) => typeof v === 'string' && v.trim() !== '';" +
    ' let home;' +
    " if (text(process.env.DSH_HOME)) home = p.resolve(process.env.DSH_HOME.trim());" +
    " else if (text(process.env.DSH_PROFILE_DIR)) home = p.resolve(process.env.DSH_PROFILE_DIR.trim(), '..', '..');" +
    " else home = p.join(os.homedir(), '.dsh');" +
    " const record = p.join(home, 'session-vault.json');" +
    " const panic = p.join(home, 'session-vault.panic');" +
    // A library is usable when it is a directory carrying an index that lists
    // at least one Workspace that actually exists in its table. That single
    // predicate is what every root consults.
    ' const usable = (r) => {' +
    ' if (!r) return false;' +
    ' try { if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) return false } catch (e) { return false }' +
    " let w = null; try { w = JSON.parse(fs.readFileSync(p.join(r, 'storages', 'workspace.json'), 'utf8')) } catch (e) { return false }" +
    ' const t = w && w.tables && w.tables.workspaces;' +
    ' const ids = w && w.global && w.global.workspaceIds;' +
    ' if (!t || !Array.isArray(ids) || ids.length === 0) return false;' +
    ' return ids.some((id) => Object.prototype.hasOwnProperty.call(t, id))' +
    ' };' +
    " let why = 'default';" +
    ' let lib = null;' +
    ' try {' +
    " if (fs.existsSync(panic)) { why = 'panic' }" +
    " else if (!fs.existsSync(record)) { why = 'no-record' }" +
    ' else {' +
    " const m = JSON.parse(fs.readFileSync(record, 'utf8'));" +
    " if (!m || m.mode !== 'custom' || typeof m.path !== 'string' || m.path === '') { why = 'mode' }" +
    ' else {' +
    ' const r = p.resolve(m.path);' +
    (prepare === undefined
      ? // A reader: use the library only when it is already usable. Never write.
        " if (usable(r)) { lib = r; why = 'custom' } else { why = 'unusable' }"
      : // The sessions root: it may create and seed the library before use.
        ' try { fs.mkdirSync(r, { recursive: true }) } catch (e) {}' +
        " if (usable(r)) { lib = r; why = 'custom' }" +
        " else if (prepare(r)) { lib = r; why = 'prepared' }" +
        " else { why = 'unusable' }") +
    ' }' +
    ' }' +
    " } catch (e) { why = 'error'; lib = null }" +
    // The roots are computed inside the closure, where `p` lives, so the
    // expressions below never need to reach into it.
    " return {" +
    ' home,' +
    ' lib,' +
    ' why,' +
    " sessions: lib ? p.join(lib, 'sessions') : p.join(home, 'sessions')," +
    " storages: lib ? p.join(lib, 'storages') : p.join(home, 'storages')," +
    ' attachments: lib ? lib : home' +
    ' }' +
    ' })()'
  )
}

/**
 * The seeder, defined only in the sessions expression: three roots plus a valid
 * v2 Workspace index, so DSH boots into a library that has a Workspace.
 * @returns the source of a `const prepare = (r) => boolean`.
 */
function seeder() {
  return (
    'const prepare = (r) => { try {' +
    " const fs = process.getBuiltinModule('node:fs');" +
    " const p = process.getBuiltinModule('node:path');" +
    " const crypto = process.getBuiltinModule('node:crypto');" +
    ' const id = crypto.randomUUID();' +
    ' const iso = new Date().toISOString();' +
    " const ws = p.join(r, 'workspace');" +
    " fs.mkdirSync(p.join(r, 'sessions'), { recursive: true });" +
    " fs.mkdirSync(p.join(r, 'storages'), { recursive: true });" +
    " fs.mkdirSync(p.join(r, 'attachments', 'v1'), { recursive: true });" +
    ' fs.mkdirSync(ws, { recursive: true });' +
    " fs.writeFileSync(p.join(r, 'storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: id }, tables: { workspaces: { [id]: { path: ws, title: 'Vault workspace', sessionIds: [], createdAt: iso, updatedAt: iso } } } }, null, 2), 'utf8');" +
    ' return true } catch (e) { return false } }; '
  )
}

/**
 * Compose one full expression.
 * @param options - which root to return, and whether to trace the decision.
 * @returns the expression source.
 */
function expression({ prepare, root, trace }) {
  return (
    '(() => {' +
    (prepare ? seeder() : '') +
    ` const d = ${decision(prepare ? 'prepare' : undefined)};` +
    (trace
      ? " try { process.getBuiltinModule('node:fs').appendFileSync(" +
        "process.getBuiltinModule('node:path').join(d.home, 'session-vault-boot.log'), " +
        `new Date().toISOString() + ' ' + d.why + ' ' + d.${root} + String.fromCharCode(10)) } catch (e) {}`
      : '') +
    ` return d.${root}` +
    ' })()'
  )
}

/**
 * Build the three expressions, in Loader order.
 * @returns {{sessions: string, storages: string, attachments: string}} sources.
 */
export function buildGuardExpressions() {
  return {
    // Created and seeded when missing; the only expression that writes anything
    // except its own trace line.
    sessions: expression({ prepare: true, root: 'sessions', trace: true }),
    // Same decision, read-only: the library when it is used, else the default.
    storages: expression({ prepare: false, root: 'storages', trace: false }),
    // Attachments live at the library root, or in the harness home.
    attachments: expression({ prepare: false, root: 'attachments', trace: false }),
  }
}

/**
 * Render `cordis.patch.yml` with the given guard expressions.
 * @param text - current patch file text.
 * @param guards - the three expressions, in file order.
 * @returns the new file text.
 */
export function renderPatch(text, guards) {
  const order = [guards.sessions, guards.storages, guards.attachments]
  // Preserve the file's own line endings: .gitattributes may normalise them on
  // checkout, and a generator that forces one style produces spurious diffs.
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let index = 0
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!/!!js "/.test(line)) return line
      const next = order[index]
      index += 1
      return next === undefined ? line : line.replace(/!!js ".*"\s*$/, `!!js "${next}"`.replace(/\$/g, '$$$$'))
    })
    .join(eol)
}

function main() {
  const check = process.argv.includes('--check')
  const current = readFileSync(PATCH, 'utf8')
  const next = renderPatch(current, buildGuardExpressions())
  if (check) {
    if (next !== current) {
      console.error('cordis.patch.yml guard expressions are stale: run node tools/write-guards.mjs')
      process.exit(1)
    }
    console.log('cordis.patch.yml guards are up to date')
    return
  }
  if (next === current) {
    console.log('cordis.patch.yml already up to date')
    return
  }
  writeFileSync(PATCH, next)
  console.log('cordis.patch.yml guard expressions regenerated')
}

// Run only when executed directly (`node tools/write-guards.mjs`), not when the
// tests import `buildGuardExpressions`. `pathToFileURL` normalises the drive
// letter's case and any percent-encoding, which a hand-built `file://` string
// gets wrong on Windows.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
