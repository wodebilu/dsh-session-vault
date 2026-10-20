/**
 * Session Vault — browser half.
 *
 * One seat only: `shell.overlay`. A small bar sits at the bottom-left of every
 * page with its own expandable panel, so nothing hides inside settings.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'sessionVault'
    const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.commands', 'uiWorkspace']

    const CSS = `
.sv-bar{position:fixed;left:14px;bottom:72px;z-index:61;display:flex;flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none}
.sv-pill{pointer-events:auto;display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 4px 14px rgba(0,0,0,.14);font-size:12px;line-height:16px;cursor:pointer;user-select:none}
.sv-pill:hover{background:var(--dsw-alias-bg-layer-2)}
.sv-dot{width:8px;height:8px;border-radius:50%;background:#b07a12;flex:none}
.sv-dot[data-on=true]{background:#2ea05a}
.sv-path{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,monospace);color:var(--dsw-alias-label-secondary)}
.sv-panel{pointer-events:auto;width:360px;max-width:calc(100vw - 28px);padding:14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 30px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:10px}
.sv-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sv-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sv-hero{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sv-hero[data-on=true]{color:#2ea05a}
.sv-rows{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.sv-row{display:flex;align-items:center;justify-content:space-between;font-size:12px;line-height:18px}
.sv-name{font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.sv-badge{padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.sv-actions{display:flex;flex-wrap:wrap;gap:6px}
.sv-btn{height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.sv-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sv-btn:disabled{opacity:.5;cursor:default}
.sv-btn[data-kind=primary]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.sv-btn[data-kind=danger]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.sv-input{height:28px;flex:1;min-width:0;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.sv-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.sv-err{padding:6px 8px;border-radius:8px;font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.sv-ok{padding:6px 8px;border-radius:8px;font-size:12px;line-height:18px;border:1px solid rgba(46,160,90,.5);color:#2ea05a}
`

    const zh = {
      'bar.on': '随身盘',
      'bar.off': '未连接',
      'bar.none': '未设置',
      'on': '对话记录在 U 盘上。',
      'local': '对话记录在本机。点「搬到 U 盘」放过去。',
      'off': '没有设置随身盘。选一个 U 盘上的文件夹并保存。',
      'in.usb': 'U 盘',
      'in.pc': '本机',
      'in.none': '无',
      'folder': '随身盘文件夹',
      'folder.hint': '例如 F:\\我的随身盘',
      'pick': '选择…',
      'save': '保存',
      'move': '搬到 U 盘',
      'restore': '搬回本机',
      'eject': '安全拔出',
      'refresh': '刷新',
      'saved': '已保存。点「搬到 U 盘」把本机数据放进去。',
      'noSession': '请先打开一个对话。',
      'uninstall': '卸载插件时会自动把数据复制回本机并恢复普通目录；若当时 U 盘未插，本机目录会变空，数据仍在 U 盘。',
    }

    const en = {
      'bar.on': 'vault',
      'bar.off': 'not connected',
      'bar.none': 'not set',
      'on': 'Conversation data is on the USB drive.',
      'local': 'Data is on this PC. Use “Move to USB”.',
      'off': 'No vault set. Pick a folder on the drive and save.',
      'in.usb': 'USB',
      'in.pc': 'this PC',
      'in.none': 'none',
      'folder': 'Vault folder',
      'folder.hint': 'e.g. F:\\my-vault',
      'pick': 'Choose…',
      'save': 'Save',
      'move': 'Move to USB',
      'restore': 'Move back',
      'eject': 'Eject',
      'refresh': 'Refresh',
      'saved': 'Saved. Use “Move to USB” to copy local data in.',
      'noSession': 'Open a conversation first.',
      'uninstall': 'Uninstalling copies the data back to this PC and restores ordinary directories. If the drive is unplugged then, local directories come back empty and the data stays on the drive.',
    }

    /**
     * Encode a Windows path so spaces cannot split the command line.
     * @param text - path.
     * @returns {string} `b64:` token.
     */
    function encodePath(text) {
      const bytes = new TextEncoder().encode(text)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return `b64:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
    }

    /**
     * Call the Host `/vault` command.
     * @param ctx - client context.
     * @param runnerId - session used as the carrier.
     * @returns {(line: string) => Promise<string>} caller.
     */
    function createCaller(ctx, runnerId) {
      return async (line) => {
        const response = await ctx.remote.commands.execute(runnerId, `/vault ${line}`, [])
        if (response === undefined) throw new Error('没有收到回复 / no response')
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
        const execution = response.value
        if (execution === undefined) throw new Error('命令未执行 / not executed')
        const result = execution.result
        if (result === undefined) throw new Error('命令返回格式异常 / bad result')
        if (result.kind === 'error') throw new Error(result.text)
        return result.text ?? ''
      }
    }

    /**
     * The session currently on screen, used as the command carrier.
     * @param state - sessions snapshot.
     * @returns {string | null} session id.
     */
    function pickRunner(state) {
      const ids = state?.ids ?? []
      for (const id of ids) {
        if (state.byId?.[id]?.retainedBy?.mainView ?? 0) return id
      }
      return null
    }

    /**
     * Client plugin body.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-vault: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-session-vault'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'session-vault: styles')

      /** The bar and its panel. */
      function Bar(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const runnerId = props.useSessions(pickRunner)
        const [status, setStatus] = React.useState(null)
        const [open, setOpen] = React.useState(false)
        const [path, setPath] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [notice, setNotice] = React.useState(null)

        const call = React.useMemo(() => (runnerId === null ? null : createCaller(ctx, runnerId)), [runnerId])

        const refresh = React.useCallback(async () => {
          if (call === null) return
          try {
            const next = JSON.parse(await call('status'))
            setStatus(next)
            setPath((current) => (current === '' ? (next.vault ?? '') : current))
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
          }
        }, [call])

        React.useEffect(() => {
          if (runnerId === null) return undefined
          void refresh()
          const timer = setInterval(() => void refresh(), 15000)
          return () => clearInterval(timer)
        }, [runnerId, refresh])

        const run = async (line) => {
          if (call === null) {
            setError(t('noSession'))
            return
          }
          setBusy(true)
          setError(null)
          setNotice(null)
          try {
            setNotice(await call(line))
            await refresh()
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
          } finally {
            setBusy(false)
          }
        }

        const pick = async () => {
          try {
            const chosen = await ctx.uiWorkspace.pickDirectory()
            if (typeof chosen === 'string' && chosen !== '') setPath(chosen)
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
          }
        }

        if (runnerId === null) return null

        const vault = status?.vault ?? null
        const items = status?.items ?? []
        const sessions = items.find((item) => item.name === 'sessions')
        const onUsb = sessions?.kind === 'linked'
        const localData = items.some((item) => item.kind === 'real' && (item.entries ?? 0) > 0)
        const label = vault === null ? t('bar.none') : onUsb ? t('bar.on') : t('bar.off')
        const hero = onUsb ? t('on') : localData ? t('local') : t('off')

        return h(
          'div',
          { className: 'sv-bar' },
          open
            ? h(
                'div',
                { className: 'sv-panel' },
                h(
                  'div',
                  { className: 'sv-head' },
                  h('span', { className: 'sv-title' }, '随身盘'),
                  h('button', { className: 'sv-btn', type: 'button', onClick: () => setOpen(false) }, '×'),
                ),
                h('div', { className: 'sv-hero', 'data-on': onUsb ? 'true' : 'false' }, hero),
                error === null ? null : h('div', { className: 'sv-err' }, error),
                notice === null ? null : h('div', { className: 'sv-ok' }, notice),
                h(
                  'div',
                  { className: 'sv-rows' },
                  items.map((item) =>
                    h(
                      'div',
                      { className: 'sv-row', key: item.name },
                      h('span', { className: 'sv-name' }, item.name),
                      h('span', { className: 'sv-badge' }, item.kind === 'linked' ? t('in.usb') : item.kind === 'real' ? t('in.pc') : t('in.none')),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'sv-actions' },
                  h('input', {
                    className: 'sv-input',
                    value: path,
                    placeholder: t('folder.hint'),
                    disabled: busy,
                    onChange: (event) => setPath(event.target.value),
                  }),
                  h('button', { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void pick() }, t('pick')),
                  h(
                    'button',
                    {
                      className: 'sv-btn',
                      type: 'button',
                      'data-kind': 'primary',
                      disabled: busy || path.trim() === '',
                      onClick: () => void run(`prepare ${encodePath(path.trim())}`),
                    },
                    t('save'),
                  ),
                ),
                h(
                  'div',
                  { className: 'sv-actions' },
                  localData
                    ? h('button', { className: 'sv-btn', type: 'button', 'data-kind': 'primary', disabled: busy, onClick: () => void run('move') }, t('move'))
                    : null,
                  onUsb
                    ? h('button', { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void run('restore') }, t('restore'))
                    : null,
                  h(
                    'button',
                    { className: 'sv-btn', type: 'button', 'data-kind': 'danger', disabled: busy || !onUsb, onClick: () => void run('eject') },
                    t('eject'),
                  ),
                  h('button', { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void refresh() }, t('refresh')),
                ),
                h('p', { className: 'sv-note' }, t('uninstall')),
              )
            : null,
          h(
            'div',
            { className: 'sv-pill', onClick: () => setOpen((value) => !value), title: vault ?? '' },
            h('span', { className: 'sv-dot', 'data-on': onUsb ? 'true' : 'false' }),
            h('span', null, label),
            vault === null ? null : h('span', { className: 'sv-path' }, vault),
          ),
        )
      }

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'session-vault-bar', order: 60, locale: NS }, Bar),
      )
    }

    return { inject, apply }
  },
})
