# Changelog

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
