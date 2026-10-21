# dsh-session-vault

An unofficial DeepSeek Harness bundle that chooses **where DSH keeps its conversations**: the ordinary local folders, or any folder you pick — a USB stick, an external SSD, a network share.

Switching is a **path redirection**, not a migration: DSH reads and writes the chosen folder directly. Nothing is copied, renamed, moved or deleted while the app runs; copying is a separate, explicit button.

> 中文说明见 [README.zh.md](README.zh.md)。

## What it changes

In `custom` mode the Loader patch points these three roots at the chosen folder:

| Root | Default | Custom |
|---|---|---|
| `sessions` | `%USERPROFILE%\.dsh\sessions` | `<vault>\sessions` |
| `storages` | `%USERPROFILE%\.dsh\storages` | `<vault>\storages` |
| `attachments` | `%USERPROFILE%\.dsh\attachments` | `<vault>\attachments` |

The local `.dsh` still holds the mode record, the profile/plugins, credentials, logs and the recovery script. **Conversation bodies, projections and attachments do not stay local in custom mode.**

## Install

Install the repository as a bundle (Plugin Manager → install from folder / link), or add it to the profile's `package.json`:

```json
"dependencies": { "dsh-session-vault": "github:wodebilu/dsh-session-vault" }
```

For local development, link a checkout instead:

```json
"dependencies": { "dsh-session-vault": "link:/absolute/path/to/dsh-session-vault" }
```

Enable the bundle, then **fully quit and reopen DSH**. The control sits in the sidebar footer, in the strip **above** the account/settings button.

## Migrate a session (1.2.0)

The sidebar footer panel now has **Migrate session**. Choose a source session, a
target library (the active one or another folder), a target workspace (an empty
folder is fine), and a new title. Preview first, then run.

The migration clones the full history, writes one zstd frame per record, adapts
the projection cache and the ISO-8601 Workspace index, and leaves the source
session untouched. It reads multi-frame logs on the Node bundled with DSH
(24.21) through `lib/zstd-frames.mjs`.

Command form: `/vault migrate <b64-json>` (the panel builds the payload).
Restart DSH once after a migration for the new workspace to appear.

## Simple panel (1.3.0)

The panel now has four buttons: **Switch storage location / Back to local default /
Manage sessions / Beginner guide**.

**Manage sessions** has four entries: three actions plus **Backup and restore**.

1. **Move library (keep workspace)** — session log, projection cache, attachments
   and child sessions move to another library; the header `cwd` does not change,
   so the session still belongs to its original Workspace. The target library gets
   (or reuses) a Workspace with the same path.
2. **Move workspace (change cwd)** — the session's `cwd` changes; log, cache,
   attachments and child sessions travel with it. The library can stay or move.
3. **Delete session** — backs up to `_deleted/<time>-<id>`, then removes the index
   entry, log, cache and child sessions. Attachments are kept by default because
   another session may share them.

Copy is the default; the source is removed only when **Move and delete source** is
explicitly checked, and it is backed up first. Index repair, copying, status and
paths are under **Advanced**.

Commands: `/vault copy <b64-json>`, `/vault migrate <b64-json>`, `/vault delete <b64-json>`.

### Backup and restore (1.3.0)

Delete, move library and move workspace back up the source to
`<library>\_deleted\<time>-<session-id>\`. **Manage sessions -> Backup and restore**
lists the backup path, restores a session, or deletes a backup. Restore brings
back the log, cache, attachments and child session tree; if the original id still
exists, a new id is generated. Deleting a backup only removes the `_deleted`
copy, never a live session.

## Use

- **Session location** (sidebar footer) → shows the active root and whether the chosen folder is usable.
- **Choose folder…** → the folder is prepared (manifest + a valid Workspace index) before the mode changes. Restart to apply.
- **Use local default** → writes `{"mode":"default"}`, clears a panic marker, leave the chosen path remembered for copying. Restart to apply.
- **Copy to chosen folder / Copy back home** → explicit, add-only copies. Existing target files are skipped, growing files are retried and skipped, the source is read-only.
- **Repair index** → normalizes a vault's `workspace.json`: every Workspace is listed, duplicate paths are merged, the default Workspace is made valid. No session file is touched.

## Why the boot guard exists

Version 1.0 could switch DSH to a folder that had **no Workspace index**. DSH then had no Workspace and no Session, and the only route back — the `/vault` command — needs an open Session. That is a deadlock: the repair button required the thing it repaired. Reinstalling was the only way out.

1.1 closes it at four layers:

1. **Seed before switch.** `useCustom` creates a usable Workspace index before it writes the mode record. A failed switch cannot strand DSH.
2. **Refuse at boot.** The Loader expressions use a custom folder only when its index lists at least one real Workspace. Otherwise all three roots fall back to the local default. `session-vault-boot.log` records the decision.
3. **Recover without a Session.** The Host half leaves `%USERPROFILE%\.dsh\恢复本机.cmd` (and `session-vault-recover.cmd`) on every boot. Double-click it: it writes `{"mode":"default"}` and a `session-vault.panic` marker, which forces the local default on the next start — even if the UI never opens.
4. **No overlap in the UI.** The control lives in `sidebar.footer.action`, not in a fixed pill over the account button.

If a custom folder is unusable, DSH starts on the local default and the panel says so. Your conversations are still in that folder; repair or switch back to it.

## Recovery, in order

1. Try the sidebar panel: **Use local default**, then restart.
2. If the panel cannot open, double-click `%USERPROFILE%\.dsh\恢复本机.cmd` (or `session-vault-recover.cmd`), then fully quit and reopen DSH.
3. If DSH cannot start at all, create an empty file `%USERPROFILE%\.dsh\session-vault.panic` and start DSH. Remove it after you have recovered (choosing a mode in the panel also clears it).

## Status

`1.1.0` is a rewrite of the 0.x junction-based plugin. It redirects the three roots, seeds and repairs the Workspace index, adopts Session logs that no Workspace owns, and ships a recovery kit that works without an open Session. It never moves, renames or deletes a Session file.

> **Do not use 0.x.** 0.x replaced `.dsh` directories with junctions; that design is what this rewrite removes. Update to 1.1.0 instead of mixing versions.

Arbitrary regrouping across Workspaces (collections/tags) and per-Session transfer are deliberately out of scope for this release.

## Limits, stated honestly

- **One DSH at a time per vault.** There is no cross-process lock; two instances writing the same vault can diverge.
- **The log travels; the working directory does not.** A Workspace is bound to the Session's `cwd`. For a fully portable setup, keep the project folder and the vault on the same removable drive and assign the same drive letter on every machine (for example `F:`). If the `cwd` is a local path that is absent on the second machine, the history is still readable but tools cannot run there, and new work in that Workspace fails. A fixed drive letter or a mount point is a per-machine setup; rewriting `cwd` is not supported.
- **Not encrypted.** A stolen USB stick is a stolen conversation library.
- **Metadata stays local.** The mode record, boot logs, recovery kit, profile and credentials live in `.dsh`.
- **Not a backup.** Copying is one-way and on demand; it is not a sync engine and does not mirror deletions.

## Files

| File | Role |
|---|---|
| `cordis.patch.yml` | Loader guard + the three root overrides |
| `index.js` | Host half: mode record, seeding, repairs, safe copy, recovery kit |
| `client.js` | Client half: footer control and dialog |
| `locale/*.json` | Plugin title/description |
| `icon.svg` | Plugin icon |

## License

MIT.
