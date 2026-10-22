# Changelog

## Unreleased

### Fixed — carrying a vault to another machine

- **The drive letter is carried across machines again.** Repairing the letter is
  the plugin's core capability: a USB stick does not get the same letter on every
  machine, so the index `path`, the session group directory name and every header
  `cwd` all have to follow the vault's current drive. A workspace that names a
  drive which is now absent is substituted to the vault's drive, and the three
  places move together.
- **Group directories always move with the sessions they hold.** The rename is
  derived from the header rewrites actually being performed instead of from a
  separate rule, so the index, the group directory and the header `cwd` cannot
  disagree — a group left on the old letter while its headers moved is the one
  state DSH cannot reconcile, because it derives the directory from the header.
- **A project folder that is gone on a mounted drive is no longer ignored.**
  Every OS drive is "mounted", so a vault written under another machine's user
  directory (`C:\Users\someoneElse\…`) produced `ok` and nothing else. Such a
  workspace has an *unchanged* letter, which means the project did not travel
  with the vault: no substitution applies, and it is now reported as a blocker
  whose remedy is `/cd` or 「换单位」.
- **No more no-op rewrites.** When a path already names the vault's own letter
  and that drive is merely unmounted, nothing is rewritten and no backup is
  written on every boot.
- **No more blocking substitution when the rewritten folder does not exist yet.**
  A carried vault legitimately reaches a machine where the project folder has not
  been created; the letter is still substituted (DSH creates the folder on first
  use) and a warning asks the user to confirm the project is really there. The
  warning no longer claims DSH will create it as a convenience.
- **Workspaces whose folder is missing are reported, not silently dropped.**
  `detectDrift` used to collect them into `missing` and nothing consumed it.

### Changed — repair is a decision, not a boot side effect

- **Startup only detects.** `apply()` no longer rewrites anything: it builds the
  plan, records it in `status().drift`, and logs what needs attention. Rewriting
  the index, a group directory and every session header is a multi-file edit that
  a live, loading DSH should not perform silently. `/vault drift` previews and
  `/vault drift-fix confirm` applies, still refusing while the library is in use.
- `autoRepairVault` keeps its signature (plus an injectable `pathExists`) for
  callers that explicitly want the write, but the host half no longer calls it.
- `/vault drift` and `/vault drift-fix` now return `blocked` (workspaces a
  rewrite cannot reach) and `warnings`, so the panel can explain rather than
  silently succeed.

### Changed — one guard decision instead of three

- The three `!!js` root expressions in `cordis.patch.yml` are now **generated
  from a single decision** by `tools/write-guards.mjs`. They previously carried
  three hand-maintained copies that could disagree: `sessions` seeded and created
  the library, while `storages` and `attachments` re-implemented the predicate
  and could fall back to the local default on their own — a session tree in the
  vault with its index in `~/.dsh`. `npm run check` fails when the committed
  expressions are stale, and `test/guard-generator.test.mjs` proves the three
  roots agree end to end, including a library that cannot be seeded.

### Original drift feature (unchanged behaviour otherwise)

- **Drive-letter drift detection.** A vault carried between machines keeps
  absolute paths: the workspace index, the session group directory names and
  each session header's `cwd` all freeze the letter that was in use when the
  record was written. Plug the same drive in where it mounts elsewhere and every
  one of those paths points at a drive that no longer exists — DSH then fails
  with `failed to ensure project directory … ENOENT` when a session is created
  or resumed. `/vault drift` reports the drift and `/vault drift-fix confirm`
  repairs it.
- `/vault drift-fix confirm` repairs the three places together — index `path`,
  session group directory name, and header `cwd` — and rewrites only the first
  zstd frame of a log; every later event frame is copied byte-for-byte. Anything
  changed is backed up under `<vault>/_drift-backup/<timestamp>/` first, with a
  `repair.json` describing the run.
- The repair refuses to run while the vault is the active library: a live DSH
  may be appending to the very logs it would rewrite.
- Two modules (`lib/drive-drift.mjs`, `lib/drift-repair.mjs`) and two CLIs
  (`tools/drift-report.mjs`, `tools/drift-repair.mjs`, dry run by default).

## 1.5.0 — 2026-10-21

- `findChildren` is now a single pass: it builds a `parentSession -> children` map
  once instead of re-walking the library for every child it finds. The old code was
  quadratic, which a large library with a deep subagent tree would feel.
- Workspace paths are stored as `fs.realpath`, the form DSH itself stamps, so a
  junction, an 8.3 short name or a `..` segment can no longer produce two Workspaces
  describing one folder.
- A migration whose target is the library's current default reuses the existing
  `_default` Workspace instead of minting a second record for the same folder.
- Deleting a session removes its now-empty session directory; a directory that still
  holds other artifacts is left alone.
- Re-homing (migrate / move workspace) now refuses a log that is not v4. The rows are
  not converted, so writing them under a v4 file name would hand DSH a file it cannot
  parse; an older session can still be opened where it is. A plain copy keeps the
  source's generation instead of renaming it, and a restored backup keeps each
  session's generation too.
- **Removed: the clean-transcript export.** Reading conversations out of DSH is a
  different job from choosing where they live; keeping it here made the plugin's
  promise fuzzy and added a second set of failure modes (its injection filtering was
  wrong until 1.5.0). The implementation is preserved in the `v1.4.0` tag and can seed
  a separate `dsh-session-export` plugin. The panel is back to four entries under
  **Manage sessions** and `/vault export` is gone.
- `test/client-text.test.mjs`: the two language tables must define the same keys, and
  every `T.<key>` the panel references must exist in both. A missing label renders as
  a blank button rather than throwing, which a manual smoke test tends to miss.
- `test/client-dom.test.mjs`: loads `client.js` through a stub module loader with a real
  React, mounts the footer in jsdom and clicks through the panel — switching location
  (with a Chinese path), backup pruning, log cleanup and the lock warning — asserting
  the exact command payloads. This is the closest thing to a UI smoke test that runs
  without DSH.
- Test-only dev dependencies (`jsdom`, `react`, `react-dom`) with a committed lockfile.
  The plugin itself still has no runtime dependencies; CI installs with `npm ci`.
- `test/guard.test.mjs` runs the three real `!!js` expressions from `cordis.patch.yml`
  against a throwaway harness home: no record, a usable library, a missing folder
  (created and seeded), an empty library (seeded), a folder that cannot be used
  (falls back), the panic marker, and a record without a path. This is the guard that
  prevents the 1.0 deadlock, and it is no longer taken on faith.
- Docs: the boot-guard bullet claimed a custom folder is used only when it already has
  a usable index. Since 1.3.0 the Loader creates and seeds an empty folder instead and
  only falls back when it cannot be used; both READMEs now say so.
- `test/switch.test.mjs` covers the primary flow end to end: prepare an empty folder
  (manifest, three roots, valid index) before the mode record, adopt logs that no
  Workspace owns, refuse a missing folder without changing the mode, return to the
  local default and clear the panic marker, and carry a Chinese path through the
  `/vault custom` channel. The DOM test now uses a Chinese target with a space, so
  the client's base64url encoding is checked against the host's decoder.
- `apply()` returns the effect's disposer, so a host can tear the plugin down
  deterministically; `test/apply.test.mjs` boots the host half against a throwaway
  home and checks the trace, the recovery kit, the lock and the registered command.
- The whole suite (65 cases) also passes on the runtime DSH ships — Electron 44.7.0 /
  Node 24.21.0 / V8 15.2 — not just on a system Node, so the `node:zlib`,
  `fs.realpath` and `process.getBuiltinModule` the plugin actually gets are covered.
- CI: `.github/workflows/test.yml` runs `npm run check` and `npm test` on Node 22 and
  24, on Windows and Linux.
- `SECURITY.md` lists exactly which paths are written and which risks are not
  addressed. README states the DSH version this build was tested against.

## 1.4.0 — 2026-10-21

- **Backups can be pruned.** `dropAllBackups({root, keep})`, `/vault drop-backups`
  and a "keep the newest N" row in the backup dialog. `keep=0` removes every
  backup. Only directories directly under `_deleted` are ever removed.
- **Attachments are no longer copied into every backup.** They are shared between
  sessions and are never removed by a delete or a move, so the copy only
  multiplied bytes (N deletes cost N times the attachment store). A backup now
  holds the logs, their caches, the index and a `backup.json`. Restoring a 1.3.0
  backup that does carry attachments still works.
- **Single-instance lock.** `<library>/.dsh-session-vault.lock` records
  `{pid, startedAt, host}`. The host half takes it on load, releases it on unload,
  replaces a lock whose owner is dead, and reports it as `status.lock`. While
  another live process holds the library, `copy`, `delete`, `migrate`, `restore`,
  `drop-backup(s)` and `push`/`pull` are refused, and the panel says why.
- **Local cleanup.** `/vault cleanup` removes the three plugin logs in the harness
  home and nothing else.
- **Clean export.** `/vault export <b64-json>` with `{sessionId, format: 'md'|'json',
  target}` writes a readable transcript that keeps only user and assistant text.
  The result is explicitly not a usable session.
- `repairLibrary` now preserves unknown `global` fields, including DSH's
  `pendingMutation` crash marker, instead of rebuilding `global` from scratch.
- Backups keep the source log's own file name instead of assuming
  `session.v4.jsonl.zstd`.
- Tests: 39 cases (`npm test`), covering shared attachments, pruning, lock
  behaviour, export filtering and command routing.

## 1.3.1 — 2026-10-21

- Fix a data-loss bug: a **preview** with "move and delete source" ticked used to
  remove the source session while writing nothing to the target. `relocate()` now
  honours `dryRun` for the move path, as `copyStorage()` already did. With the
  backup checkbox also cleared, that preview was a permanent delete.
- A move or copy now *enforces* `sourceUnchanged`: a source whose log grew since
  the command started is refused, not just reported.
- Projection-cache edits go through shape-checked helpers, so a changed cache
  layout fails with a sentence before the target is touched, instead of a
  `TypeError` after the log was published.
- Add a format gate: `copy`, `delete`, `migrate` and `restore` refuse a library
  whose Workspace index version or Session log generation is newer than this
  build understands. `/vault check` reports the same result.
- Add `test/`: 17 regression tests on synthetic libraries (`npm test`).
- Docs: the file table lists `lib/` and `test/`; the status line no longer claims
  1.1.0; the "one frame per record" note now states the real constraint.

## 1.3.0 — 2026-10-21

- Replace the panel with four buttons: switch storage location, back to local
  default, manage sessions, beginner guide.
- Manage sessions has three actions: move library (keep cwd/workspace), move
  workspace (change cwd), delete session (backup first).
- Move library copies the log, projection cache, attachments and child session
  tree, and keeps the header `cwd`; the target library gets the same Workspace path.
- Move workspace carries attachments and the child session tree; the source stays
  read-only unless "move and delete source" is explicit, and it is backed up first.
- Delete backs up the log/cache/index and child sessions under
  `_deleted/<time>-<id>`, then removes the index entry.
- Host: `/vault copy <b64-json>`, `/vault delete <b64-json>`, and `/vault migrate`
  now accept `move`/`backup`/`dryRun`.
- Add a beginner guide; move repair/copy/status/paths behind **Advanced**.
- Add **Backup and restore** to Manage sessions: list backups, restore a session
  (log, cache, attachments, child tree; new id on conflict), delete a backup.
- Delete/move/workspace-move keep the source under `_deleted/<time>-<id>`; the
  result shows the backup path.
- Core verified with the DSH-bundled Node, including synthetic attachments and a
  child session, a storage move, a workspace move and delete.

## 1.2.0 — 2026-10-21

- Add **Migrate session** to the sidebar panel: source session, target library,
  target workspace (empty folder allowed), title, preview/run.
- Add `/vault migrate <b64-json>` to the host.
- Clone the full history, one zstd frame per record, adapt the projection cache
  and the ISO-8601 Workspace index; source read-only.
- Add `lib/zstd-frames.mjs`, a frame-by-frame reader that works on the Node
  bundled with DSH (24.21), which stops at the first frame with the native API.
- Add `lib/relocate-core.mjs` with the migration engine.
- Package the new `lib/` files.

## 1.1.0 — 2026-10-21

A complete rewrite. The 0.x junction/migration design is removed.

- Redirect the three DSH roots (`sessions`, `storages`, `attachments`) through
  `cordis.patch.yml`; nothing is copied, moved, renamed or deleted at boot.
- Two modes: local default and a chosen folder, with a restart hint.
- Prepare a chosen folder before switching: vault manifest, `sessions`,
  `storages`, `attachments/v1`, and a valid Workspace index.
- Boot guard: a custom library is used only when its index lists a real
  Workspace; otherwise every root falls back to the local default.
- Normalize the Workspace index: every Workspace in `global.workspaceIds`,
  duplicate paths merged, a valid `defaultWorkspaceId`.
- Adopt Session logs that no Workspace owns, by reading their `cwd`; a log with
  no readable header goes to a `Recovered sessions` Workspace.
- Add-only copy engine: `.copying` sibling, source-size stability, never
  overwrite, source read-only.
- No-Session recovery kit in `%USERPROFILE%\.dsh`: `恢复本机.cmd`,
  `session-vault-recover.cmd`, `session-vault-recover.ps1`, and the
  `session-vault.panic` marker.
- Sidebar-footer control above the account/settings button; no fixed pill over
  the avatar.
- Tests: Loader guard cases, Host behaviours, offline switch, and the recovery
  script under Windows PowerShell 5.1.

## 0.5.2 and earlier

Junction-based prototypes. Superseded; do not use. See the git history for the
old implementation.
