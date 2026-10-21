# Security

## What this plugin can do

It runs inside DSH as a plugin, with the same filesystem permissions DSH itself has:
it can read and write any folder your user account can reach. That is deliberate —
its job is to point DSH at another folder and, when you ask, to copy, move or delete
session files there.

It does **not**:

- open a network connection;
- collect telemetry or send anything anywhere;
- store credentials, tokens or passwords;
- run anything outside the library you picked and the harness home (`.dsh`).

## Paths it writes

| Path | Why |
|---|---|
| `<library>/sessions`, `<library>/storages`, `<library>/attachments` | the conversation data it redirects |
| `<library>/_deleted/<time>-<session-id>/` | the backup taken before a delete or a move |
| `<library>/.dsh-session-vault.lock` | tells a second DSH process who holds the library |
| `<library>/vault.json` | the library manifest |
| `.dsh/session-vault.json` | the mode record |
| `.dsh/session-vault-*.log` | startup and fallback traces |
| `.dsh/恢复本机.cmd`, `.dsh/session-vault-recover.*` | the no-UI recovery kit |
| `.dsh/session-vault.panic` | the force-local marker, when it is set |

`/vault cleanup` removes the three `session-vault-*.log` files and nothing else.
`/vault export` writes one transcript file wherever you point it, never inside the
library.

## Risks you accept by using it

- **No encryption.** Anyone holding the drive can read every conversation.
- **No authentication.** Anyone at the keyboard can do everything the panel can.
- **Not a backup.** Copying is one-way and on demand; deletions are not mirrored.
- **Advisory lock only.** Two DSH windows are detected, not prevented; DSH still
  starts, and the second window is refused the write operations rather than blocked.
- **Private formats.** It depends on DSH's internal session and Workspace schemas. A
  DSH upgrade can break it, and the version gate only covers the data formats it
  knows how to probe.

## Reporting a problem

Open an issue at <https://github.com/wodebilu/dsh-session-vault/issues>. If it is a
data-loss bug, put "data loss" in the title — that is the only class that gets
attention out of band.
