# Session Vault for DSH

**Unofficial** plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Keeps conversation data on a USB drive, with **no local copy**, without changing
any DSH setting.

## The whole idea

DSH always reads `$DSH_HOME/sessions`, `storages`, and `attachments`. The plugin
replaces those directories with directory junctions into a vault on the
removable drive:

```
C:\Users\ASUS\.dsh\sessions  ──junction──▶  F:\dsh-vault\sessions
```

The bytes exist once, on the drive. The local path is only a pointer.

## What happens

At every start the plugin looks for `dsh-vault\session-vault.json` on each drive
letter (no OS query, no configuration):

| What it finds | What it does |
|---|---|
| A vault | points the three directories at it — **but never moves local data**; a directory that still holds data stays local until you press the button |
| No vault | leaves the three directories **dangling**: reads see nothing, writes fail, and no local file can be created |

Data movement is always explicit, from the settings page:

- **搬到 U 盘** — copy the local directories into the vault, then link them.
- **搬回本机** — copy the vault back into real local directories.
- **安全拔出** — make the paths dangling before unplugging.

## Uninstall

Disabling/removing the plugin restores ordinary local directories (the vault
copy is kept). This runs only when the bundle is gone from the profile
manifest, so an ordinary application quit never triggers a copy.

## Use

1. Install the plugin, restart DSH once.
2. Settings → **随身盘（U 盘）** → type the drive letter (e.g. `F:`) → create a vault.
3. Restart DSH once so the data moves onto the drive.
4. From then on: plug the drive in, open DSH, the conversations are there.

Before unplugging, press **安全拔出** (or close DSH). The workspace itself may
live on the same drive.

## On another computer

Install the same plugin there and plug the drive in. The plugin finds the vault
and points at it. If the drive gets a different letter, the vault marker is
still found, but the `cwd` recorded inside old sessions may not exist on that
machine.

## Safety

- Migration copies first, then swaps the directory for a link. A failure leaves
  the local directory untouched, so data is never split.
- A directory that already exists in both places is reported as a conflict and
  the local copy is kept, never overwritten.
- A hard unplug is not handled: use **安全拔出** or close DSH first.
- No third-party runtime dependencies.

## Development

```bash
npm test
```

Tests build a throwaway home and vault under the temp directory: migrate,
detach, write-blocked, re-attach, conflict, status.

## License

MIT. See [LICENSE](LICENSE).
