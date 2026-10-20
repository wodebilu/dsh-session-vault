# Changelog

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
