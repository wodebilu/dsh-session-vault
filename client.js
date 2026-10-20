/**
 * Session Vault — Client half.
 *
 * A status row in `sidebar.footer.action` (the strip above the account/settings
 * control), plus a dialog for switching and copying.
 *
 * Why the footer and not a floating pill: the first version used
 * `position:fixed; left:14px; bottom:16px`, which is exactly the account button
 * seat, so it covered that button. The footer slot allocates real space.
 *
 * Why every action has a no-Session path: `/vault` commands ride a Session id.
 * If a custom library has no Session at all, the host half leaves a recovery
 * script in `%USERPROFILE%\.dsh`; this panel names it instead of pretending the
 * button works. The Loader patch independently refuses an unusable library, so
 * the common deadlock cannot be reached.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Services this Client module cannot work without. */
    const inject = ['slots', 'remote', 'remote.commands', 'uiWorkspace']

    /** Set to false to hide the copy section and keep the two libraries apart. */
    const ENABLE_COPY = true

    /** Last-known status, so a Session-less panel can still explain the state. */
    const CACHE_KEY = 'dsh.session-vault.status'

    /** A stable empty snapshot: useSyncExternalStore requires identity stability. */
    const EMPTY_SESSIONS = { ids: [], byId: {} }

    const ZH = {
      pill: '会话位置',
      title: '会话位置',
      local: '本机默认',
      current: '当前使用',
      badgeDefault: '本机默认',
      badgeCustom: '指定文件夹',
      restartHint: '切换位置后，需要完全退出 DeepSeek Harness（关掉整个窗口）再打开，才会生效。',
      useDefault: '用回本机默认',
      pick: '选择文件夹…',
      switchToChosen: '切换到指定文件夹',
      refresh: '刷新',
      repair: '修复索引',
      close: '×',
      noSession: '现在没有可用的会话，命令发不出去。',
      unavailable: '命令通道没有就绪，请完全关闭 DSH 再打开一次。',
      doneTitle: '已记录，等待重启',
      doneBody:
        '现在还不会生效。请完全退出 DeepSeek Harness（整个窗口关掉），再重新打开。\n\n如果新的位置里还没有对话，列表会是空的——那不是丢失。点「用回本机默认」再重启一次就回来了。',
      doneOk: '知道了',
      pending: '已记录，重启后生效',
      degraded: '指定文件夹这次不可用，已自动回退到本机默认。',
      degradedHelp:
        '对话没有丢：文件还在那个文件夹里。修好它、或点「用回本机默认」把选择固定下来，再重启。',
      panic: '检测到急救标记 session-vault.panic，本次强制使用本机默认。',
      panicHelp: '确认 DSH 能正常打开后，点「用回本机默认」清除这个标记。',
      needsRepairHint: '这个库的工作区索引不完整，或存在没有归属的会话，可能导致侧栏里看不到部分对话。点「修复索引」即可，不会动任何会话文件。',
      requestedBroken: '已选的文件夹现在不可用（没有可用的工作区索引）。',
      requestedBrokenHelp: '它不会被用于启动；修好索引后可以再切过去。会话文件还在那里。',
      noSessionHelp:
        '面板还能打开，但命令必须挂在一个会话上。请双击下面这个文件，然后完全关闭 DSH 再打开：',
      recoveryMissing: '恢复脚本还没有生成过。请先正常启动一次 DSH。',
      copyOut: '复制到指定文件夹 →',
      copyIn: '← 复制回本机',
      copySection: '按需复制（只增不删，不覆盖）',
      copyOutTitle: '把本机的会话复制到指定文件夹',
      copyInTitle: '把指定文件夹的会话复制回本机',
      copyConfirmBody:
        '会把这些会话复制一份到另一边。\n\n· 不会删除、不会移动任何东西，来源只读；\n· 目标已存在同名会话就跳过，绝不覆盖；\n· 复制时如果那个文件还在变长，这一次就跳过它；\n· 复制完要重启一次，列表里才会出现。',
      copyGo: '继续',
      cancel: '取消',
      copyDoneTitle: '复制完成',
      nothingToCopy: '没有新的会话需要复制。已存在的都跳过了。',
      noTarget: '还没有选择指定的文件夹，先在上面选一个。',
      repairDoneTitle: '索引已修复',
      repairBody: (r) =>
        `工作区 ${r.workspaces} 个，合并重复路径 ${r.merged} 个，补登记 ${r.addedToList} 个，收养无归属会话 ${r.adopted ?? 0} 个。\n\n会话文件一个都没动。完全关闭再打开 DSH，侧栏就会按修复后的索引显示。`,
      vaultId: '库标识',
      path: '路径',
      requested: '已选文件夹',
      copyDoneBody: (r) => {
        if (r.sessions === 0 && (r.workspaces?.repaired ?? 0) === 0 && (r.adopted ?? 0) === 0) return ZH.nothingToCopy
        const skipped = r.skipped ?? {}
        const parts = []
        if (skipped.exists) parts.push(`已存在 ${skipped.exists}`)
        if (skipped.empty) parts.push(`空文件 ${skipped.empty}`)
        if (skipped.unstable) parts.push(`复制时仍在变化 ${skipped.unstable}`)
        const tail = parts.length > 0 ? `\n跳过：${parts.join('，')}。` : ''
        const ws = r.workspaces ?? {}
        const work = `工作区：新增 ${ws.added ?? 0}，合并 ${ws.merged ?? 0}，修复 ${ws.repaired ?? 0}；收养无归属会话 ${r.adopted ?? 0} 个。`
        return `新增 ${r.sessions} 个会话，登记 ${r.registered} 个。\n${work}${tail}\n\n重启一次 DeepSeek Harness 后，新复制的会话才会出现在列表里。`
      },
    }

    const EN = {
      pill: 'Session location',
      title: 'Session location',
      local: 'Local default',
      current: 'In use',
      badgeDefault: 'Local default',
      badgeCustom: 'Chosen folder',
      restartHint: 'Fully quit DeepSeek Harness (close the whole window) and open it again for the change to take effect.',
      useDefault: 'Use local default',
      pick: 'Choose folder…',
      switchToChosen: 'Switch to chosen folder',
      refresh: 'Refresh',
      repair: 'Repair index',
      close: '×',
      noSession: 'There is no usable session, so commands cannot be sent.',
      unavailable: 'The command channel is not ready. Fully quit DSH and open it again.',
      doneTitle: 'Saved, restart required',
      doneBody:
        'This is not active yet. Fully quit DeepSeek Harness (close the whole window), then open it again.\n\nIf the new location has no conversations, the list will be empty — nothing was deleted. Choose "Use local default" and restart to come back.',
      doneOk: 'Got it',
      pending: 'Saved; active after restart',
      degraded: 'The chosen folder was unusable, so this start used the local default.',
      degradedHelp:
        'Nothing was lost: the files are still in that folder. Fix it, or press "Use local default" to make the fallback permanent, then restart.',
      panic: 'A recovery marker (session-vault.panic) forces the local default for this start.',
      panicHelp: 'Once DSH opens correctly, press "Use local default" to clear the marker.',
      needsRepairHint: 'This library has an incomplete Workspace index, or Sessions with no home, which can hide conversations. "Repair index" fixes it without touching any session file.',
      requestedBroken: 'The chosen folder is not usable right now (no usable Workspace index).',
      requestedBrokenHelp: 'It is not used for this start. Repair the index before switching to it; the session files are still there.',
      noSessionHelp:
        'The panel opens, but a command needs a session. Double-click this file, then fully quit DSH and open it again:',
      recoveryMissing: 'The recovery script has not been written yet. Start DSH once normally.',
      copyOut: 'Copy to chosen folder →',
      copyIn: '← Copy back home',
      copySection: 'Copy on demand (add only, never overwrite)',
      copyOutTitle: 'Copy local sessions to the chosen folder',
      copyInTitle: 'Copy the chosen folder\'s sessions back home',
      copyConfirmBody:
        'This copies sessions to the other side.\n\n· Nothing is deleted or moved; the source is read-only.\n· An existing target session is skipped, never overwritten.\n· A file that is still growing is skipped this time.\n· Restart once after copying for the list to show them.',
      copyGo: 'Continue',
      cancel: 'Cancel',
      copyDoneTitle: 'Copy finished',
      nothingToCopy: 'No new sessions to copy. Existing ones were skipped.',
      noTarget: 'No folder has been chosen yet. Pick one above.',
      repairDoneTitle: 'Index repaired',
      repairBody: (r) =>
        `${r.workspaces} workspaces, ${r.merged} duplicate paths merged, ${r.addedToList} added to the list, ${r.adopted ?? 0} orphan Session(s) adopted.\n\nNo session file was touched. Fully quit and reopen DSH to see the repaired list.`,
      vaultId: 'Vault ID',
      path: 'Path',
      requested: 'Chosen folder',
      copyDoneBody: (r) => {
        if (r.sessions === 0 && (r.workspaces?.repaired ?? 0) === 0 && (r.adopted ?? 0) === 0) return EN.nothingToCopy
        const skipped = r.skipped ?? {}
        const parts = []
        if (skipped.exists) parts.push(`${skipped.exists} already present`)
        if (skipped.empty) parts.push(`${skipped.empty} empty`)
        if (skipped.unstable) parts.push(`${skipped.unstable} still changing`)
        const tail = parts.length > 0 ? `\nSkipped: ${parts.join(', ')}.` : ''
        const ws = r.workspaces ?? {}
        const work = `Workspaces: ${ws.added ?? 0} added, ${ws.merged ?? 0} merged, ${ws.repaired ?? 0} repaired; ${r.adopted ?? 0} orphan Session(s) adopted.`
        return `Copied ${r.sessions} session(s), registered ${r.registered}.\n${work}${tail}\n\nRestart DeepSeek Harness once for the new sessions to appear.`
      },
    }

    const T =
      (typeof navigator === 'object' && String(navigator.language ?? '').toLowerCase().startsWith('zh'))
        ? ZH
        : EN

    const CSS = `
.sv-trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:32px;padding:0 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6070);font:inherit;font-size:12px;line-height:16px;cursor:pointer;text-align:left}
.sv-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f6);color:var(--dsw-alias-label-primary,#1b1d21)}
.sv-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2b6cff);outline-offset:-2px}
.sv-trigger[data-compact=true]{width:36px;height:36px;justify-content:center;padding:0}
.sv-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px}
.sv-dot{position:absolute;right:-2px;bottom:-2px;width:7px;height:7px;border-radius:50%;background:#9aa0ab;box-shadow:0 0 0 2px var(--dsw-specific-sidebar-fill,#fff)}
.sv-dot[data-tone=on]{background:#2ea05a}
.sv-dot[data-tone=warn]{background:#c9821a}
.sv-text{display:flex;flex-direction:column;min-width:0;gap:1px;flex:1}
.sv-label{font-weight:500;color:inherit}
.sv-path{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#5b6070)}
.sv-chev{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8f9c)}
.sv-backdrop{position:fixed;inset:0;z-index:80;background:rgba(15,18,24,.38);display:flex;align-items:center;justify-content:center;padding:20px}
.sv-panel{box-sizing:border-box;width:480px;max-width:100%;max-height:82vh;overflow:auto;padding:16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,#d7d9e0);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 20px 50px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary,#1b1d21)}
.sv-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sv-title{margin:0;font-size:15px;font-weight:600}
.sv-x{border:none;background:transparent;font-size:18px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5b6070);padding:0 2px}
.sv-card{padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f2f3f6);display:flex;flex-direction:column;gap:5px}
.sv-row{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:18px}
.sv-key{color:var(--dsw-alias-label-secondary,#5b6070);flex:none;min-width:64px}
.sv-val{font-family:var(--dsw-font-mono,ui-monospace,monospace);word-break:break-all}
.sv-badge{padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;background:#e8f5ec;color:#1f7a45;flex:none}
.sv-badge[data-mode=default]{background:#eceef2;color:#4b5060}
.sv-actions{display:flex;flex-wrap:wrap;gap:8px}
.sv-split{height:1px;background:var(--dsw-alias-border-l1,#e4e6ec);margin:2px 0}
.sv-section{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#5b6070)}
.sv-btn{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#d7d9e0);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.sv-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f2f3f6)}
.sv-btn:disabled{opacity:.5;cursor:default}
.sv-btn[data-kind=primary]{background:var(--dsw-alias-brand-primary,#2b6cff);border-color:transparent;color:#fff}
.sv-note{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#5b6070)}
.sv-warn{padding:7px 9px;border-radius:8px;font-size:12px;line-height:18px;background:#fff6e6;color:#8a5a12}
.sv-err{padding:7px 9px;border-radius:8px;font-size:12px;line-height:18px;border:1px solid rgba(200,60,60,.5);color:#b83a3a}
.sv-code{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:16px;word-break:break-all;background:var(--dsw-alias-bg-layer-2,#f2f3f6);padding:6px 8px;border-radius:6px}
.sv-dialog{box-sizing:border-box;width:460px;max-width:100%;padding:18px;border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 20px 50px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,#1b1d21)}
.sv-dialog h4{margin:0;font-size:15px}
.sv-dialog p{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary,#5b6070);white-space:pre-wrap}
.sv-dialog-actions{display:flex;justify-content:flex-end;gap:8px}
`

    /** Drive/USB outline. */
    function DriveIcon() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('rect', {
          x: 3,
          y: 6,
          width: 18,
          height: 12,
          rx: 2.5,
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('path', { d: 'M7 10h6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 17, cy: 14, r: 1.2, fill: 'currentColor' }),
      )
    }

    /**
     * Pick the conversation used as the command carrier.
     * Prefers the one on screen, then any known Session, so the panel also works
     * from an empty view.
     * @param list - sessions snapshot.
     * @returns {string | null} session id.
     */
    function pickRunner(list) {
      const ids = list?.ids ?? []
      for (const id of ids) {
        if ((list.byId?.[id]?.retainedBy?.mainView ?? 0) > 0) return id
      }
      return ids.length > 0 ? ids[0] : null
    }

    /**
     * Encode a path so spaces cannot split the command line.
     * @param text - folder path.
     * @returns {string} `b64:` token.
     */
    function encodePath(text) {
      const bytes = new TextEncoder().encode(text)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return `b64:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
    }

    /** @param error - thrown value. @returns {string} readable message. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** @returns {object | null} last cached status, if any. */
    function readCachedStatus() {
      try {
        const raw = localStorage.getItem(CACHE_KEY)
        if (raw === null) return null
        const value = JSON.parse(raw)
        return value !== null && typeof value === 'object' ? value : null
      } catch {
        return null
      }
    }

    /** @param value - status payload. */
    function writeCachedStatus(value) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ ...value, cachedAt: Date.now() }))
      } catch {
        // A cache is a convenience; never fail the panel over it.
      }
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-session-vault'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'session-vault: styles')

      /** Session list, read from the Workspace service without slot props. */
      function useSessionList() {
        const store = ctx.uiWorkspace?.sessions?.list
        const subscribe = React.useCallback(
          (onChange) =>
            store !== undefined && typeof store.subscribe === 'function'
              ? store.subscribe(onChange)
              : () => {},
          [store],
        )
        const getSnapshot = React.useCallback(
          () =>
            store !== undefined && typeof store.getSnapshot === 'function'
              ? store.getSnapshot()
              : EMPTY_SESSIONS,
          [store],
        )
        return React.useSyncExternalStore(subscribe, getSnapshot)
      }

      /** The footer row and its dialog. */
      function VaultBar(props) {
        const list = useSessionList()
        const runnerId = pickRunner(list)
        const [status, setStatus] = React.useState(null)
        const [open, setOpen] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [pending, setPending] = React.useState(false)
        const [noSession, setNoSession] = React.useState(false)
        const [dialog, setDialog] = React.useState(null)

        const wide = props.wide !== false

        const call = React.useCallback(
          async (line) => {
            if (runnerId === null || runnerId === undefined) {
              const error = new Error(T.noSession)
              error.code = 'no-session'
              throw error
            }
            const commands = ctx.remote?.commands
            if (commands === undefined || typeof commands.execute !== 'function') {
              throw new Error(T.unavailable)
            }
            let response = await commands.execute(runnerId, `/vault ${line}`, [])
            if (response !== null && typeof response === 'object' && 'ok' in response) {
              if (!response.ok) {
                throw new Error(
                  `${response.error?.code ?? 'remote'}: ${response.error?.message ?? ''}`,
                )
              }
              response = response.value
            }
            if (response === null || typeof response !== 'object') {
              throw new Error('命令未执行（Host 半边可能没加载）')
            }
            const result = response.result
            if (result === undefined || result === null) throw new Error('命令返回格式异常')
            if (result.kind === 'error') {
              // A stale Host process answers every newly added action this way.
              if (String(result.text).includes('未知操作')) {
                throw new Error('插件后台还是旧版本：请完全关掉 DeepSeek Harness 再打开（刷新页面不够）。')
              }
              throw new Error(result.text)
            }
            return result.text ?? ''
          },
          [runnerId],
        )

        const refresh = React.useCallback(async () => {
          try {
            const next = JSON.parse(await call('status'))
            setStatus(next)
            setNoSession(false)
            setError(null)
            writeCachedStatus(next)
          } catch (caught) {
            if (caught?.code === 'no-session') {
              setNoSession(true)
              setStatus(readCachedStatus())
              setError(null)
              return
            }
            setError(messageOf(caught))
          }
        }, [call])

        React.useEffect(() => {
          void refresh()
        }, [refresh])

        const toggle = () => {
          const next = !open
          setOpen(next)
          if (next) void refresh()
        }

        const switchTo = async (line) => {
          setBusy(true)
          setError(null)
          try {
            await call(line)
            await refresh()
            setPending(true)
            setDialog({ title: T.doneTitle, body: T.doneBody })
          } catch (caught) {
            setError(messageOf(caught))
          } finally {
            setBusy(false)
          }
        }

        const pick = async () => {
          setBusy(true)
          setError(null)
          try {
            if (typeof ctx.uiWorkspace?.pickDirectory !== 'function') {
              throw new Error(T.unavailable)
            }
            const chosen = await ctx.uiWorkspace.pickDirectory()
            if (typeof chosen !== 'string' || chosen === '') return
            await call(`custom ${encodePath(chosen)}`)
            await refresh()
            setPending(true)
            setDialog({ title: T.doneTitle, body: T.doneBody })
          } catch (caught) {
            setError(messageOf(caught))
          } finally {
            setBusy(false)
          }
        }

        const repair = async () => {
          setBusy(true)
          setError(null)
          try {
            const result = JSON.parse(await call('repair'))
            setDialog({ title: T.repairDoneTitle, body: T.repairBody(result) })
            await refresh()
          } catch (caught) {
            setError(messageOf(caught))
          } finally {
            setBusy(false)
          }
        }

        const runCopy = async (command) => {
          setDialog(null)
          setBusy(true)
          setError(null)
          try {
            const result = JSON.parse(await call(command))
            setDialog({ title: T.copyDoneTitle, body: T.copyDoneBody(result) })
            await refresh()
          } catch (caught) {
            setError(messageOf(caught))
          } finally {
            setBusy(false)
          }
        }

        const askCopy = async (direction) => {
          setBusy(true)
          setError(null)
          try {
            let known =
              status !== null &&
              status.requested !== null &&
              status.requested !== undefined
            if (!known) {
              // No folder remembered yet: ask for one, but keep the active
              // library unchanged so this conversation keeps working.
              if (typeof ctx.uiWorkspace?.pickDirectory !== 'function') {
                throw new Error(T.unavailable)
              }
              const chosen = await ctx.uiWorkspace.pickDirectory()
              if (typeof chosen !== 'string' || chosen === '') return
              await call(`target ${encodePath(chosen)}`)
              await refresh()
              known = true
            }
            if (!known) {
              setError(T.noTarget)
              return
            }
            setDialog({
              title: direction === 'push' ? T.copyOutTitle : T.copyInTitle,
              body: T.copyConfirmBody,
              confirm: { label: T.copyGo, run: () => runCopy(direction) },
            })
          } catch (caught) {
            setError(messageOf(caught))
          } finally {
            setBusy(false)
          }
        }

        const state = status
        const mode = state?.mode ?? null
        const degraded = state?.degraded === true
        const unusable = state !== null && state.mode === 'custom' && state.usable === false
        const label =
          mode === 'custom' ? (state?.requested ?? state?.root ?? '…') : T.local
        const tone = degraded || unusable ? 'warn' : mode === 'custom' ? 'on' : 'off'
        const hasTarget =
          state !== null && state.requested !== null && state.requested !== undefined
        const hasRequested =
          state !== null && typeof state.requested === 'string' && state.requested !== ''
        const requestedBroken =
          hasRequested && state.available === true && state.usable === false
        const canRepair = hasRequested && state.available === true
        const menu = []

        if (state !== null) {
          menu.push(
            h(
              'div',
              { className: 'sv-card', key: 'card' },
              h(
                'div',
                { className: 'sv-row' },
                h(
                  'span',
                  { className: 'sv-badge', 'data-mode': mode ?? 'default' },
                  mode === 'custom' ? T.badgeCustom : T.badgeDefault,
                ),
              ),
              h(
                'div',
                { className: 'sv-row' },
                h('span', { className: 'sv-key' }, T.current),
                h('span', { className: 'sv-val' }, state.root ?? '…'),
              ),
              hasTarget && mode === 'default'
                ? h(
                    'div',
                    { className: 'sv-row' },
                    h('span', { className: 'sv-key' }, T.requested),
                    h('span', { className: 'sv-val' }, state.requested),
                  )
                : null,
              state.vault?.id
                ? h(
                    'div',
                    { className: 'sv-row' },
                    h('span', { className: 'sv-key' }, T.vaultId),
                    h('span', { className: 'sv-val' }, String(state.vault.id).slice(0, 8)),
                  )
                : null,
            ),
          )
        }

        if (degraded) {
          menu.push(
            h('div', { className: 'sv-warn', key: 'degraded' }, `${T.degraded}\n${T.degradedHelp}`),
          )
        }
        if (requestedBroken && !degraded) {
          menu.push(
            h(
              'div',
              { className: 'sv-warn', key: 'requestedbroken' },
              `${T.requestedBroken}\n${T.requestedBrokenHelp}`,
            ),
          )
        }
        if (state?.panic === true) {
          menu.push(h('div', { className: 'sv-warn', key: 'panic' }, `${T.panic}\n${T.panicHelp}`))
        }
        if (state?.needsRepair === true) {
          menu.push(h('div', { className: 'sv-warn', key: 'repair' }, T.needsRepairHint))
        }
        if (noSession) {
          menu.push(
            h(
              'div',
              { className: 'sv-warn', key: 'nosession' },
              h('div', null, T.noSessionHelp),
              h(
                'div',
                { className: 'sv-code', style: { marginTop: 6 } },
                state?.home
                  ? `${state.home}\\恢复本机.cmd`
                  : T.recoveryMissing,
              ),
            ),
          )
        }

        menu.push(
          h(
            'div',
            { className: 'sv-actions', key: 'actions' },
            h(
              'button',
              {
                className: 'sv-btn',
                type: 'button',
                disabled: busy,
                onClick: () => void switchTo('default'),
              },
              T.useDefault,
            ),
            state?.mode === 'default' && hasRequested && state.usable === true
              ? h(
                  'button',
                  {
                    className: 'sv-btn',
                    type: 'button',
                    'data-kind': 'primary',
                    disabled: busy,
                    onClick: () => void switchTo(`custom ${encodePath(state.requested)}`),
                  },
                  T.switchToChosen,
                )
              : null,
            h(
              'button',
              {
                className: 'sv-btn',
                type: 'button',
                disabled: busy,
                onClick: () => void pick(),
              },
              T.pick,
            ),
            h(
              'button',
              { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void refresh() },
              T.refresh,
            ),
            canRepair
              ? h(
                  'button',
                  { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void repair() },
                  T.repair,
                )
              : null,
          ),
        )

        menu.push(h('p', { className: 'sv-note', key: 'hint' }, T.restartHint))

        if (ENABLE_COPY) {
          menu.push(h('div', { className: 'sv-split', key: 'split' }))
          menu.push(h('span', { className: 'sv-section', key: 'copysection' }, T.copySection))
          menu.push(
            h(
              'div',
              { className: 'sv-actions', key: 'copyactions' },
              h(
                'button',
                { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void askCopy('push') },
                T.copyOut,
              ),
              h(
                'button',
                { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void askCopy('pull') },
                T.copyIn,
              ),
            ),
          )
        }

        return h(
          React.Fragment,
          null,
          h(
            'button',
            {
              className: 'sv-trigger',
              type: 'button',
              'data-compact': wide ? 'false' : 'true',
              onClick: toggle,
              title: state?.root ?? T.title,
              'aria-label': T.title,
              'aria-haspopup': 'dialog',
              'aria-expanded': open ? 'true' : 'false',
            },
            h(
              'span',
              { className: 'sv-icon' },
              h(DriveIcon),
              h('span', { className: 'sv-dot', 'data-tone': tone }),
            ),
            wide
              ? h(
                  'span',
                  { className: 'sv-text' },
                  h('span', { className: 'sv-label' }, T.pill),
                  h('span', { className: 'sv-path' }, label),
                )
              : null,
            wide ? h('span', { className: 'sv-chev' }, '▾') : null,
          ),
          open
            ? h(
                'div',
                { className: 'sv-backdrop', onClick: () => setOpen(false) },
                h(
                  'div',
                  {
                    className: 'sv-panel',
                    role: 'dialog',
                    'aria-label': T.title,
                    onClick: (event) => event.stopPropagation(),
                  },
                  h(
                    'div',
                    { className: 'sv-head' },
                    h('h3', { className: 'sv-title' }, T.title),
                    h(
                      'button',
                      { className: 'sv-x', type: 'button', onClick: () => setOpen(false) },
                      T.close,
                    ),
                  ),
                  error === null ? null : h('div', { className: 'sv-err' }, error),
                  pending ? h('div', { className: 'sv-warn' }, T.pending) : null,
                  ...menu,
                ),
              )
            : null,
          dialog === null
            ? null
            : h(
                'div',
                { className: 'sv-backdrop', onClick: () => setDialog(null) },
                h(
                  'div',
                  { className: 'sv-dialog', onClick: (event) => event.stopPropagation() },
                  h('h4', null, dialog.title),
                  h('p', null, dialog.body),
                  h(
                    'div',
                    { className: 'sv-dialog-actions' },
                    dialog.confirm === undefined
                      ? h(
                          'button',
                          {
                            className: 'sv-btn',
                            type: 'button',
                            'data-kind': 'primary',
                            onClick: () => setDialog(null),
                          },
                          T.doneOk,
                        )
                      : h(
                          React.Fragment,
                          null,
                          h(
                            'button',
                            { className: 'sv-btn', type: 'button', onClick: () => setDialog(null) },
                            T.cancel,
                          ),
                          h(
                            'button',
                            {
                              className: 'sv-btn',
                              type: 'button',
                              'data-kind': 'primary',
                              onClick: () => void dialog.confirm.run(),
                            },
                            dialog.confirm.label,
                          ),
                        ),
                  ),
                ),
              ),
        )
      }

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'session-vault-bar', order: 60 },
          VaultBar,
        ),
      )
    }

    return { inject, apply }
  },
})
