# Changelog

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
