/**
 * Session Vault — browser half.
 *
 * Two seats:
 *  - `shell.overlay`: a small always-visible pill so the state is not buried
 *    in settings ("随身盘：已连接 / 未连接").
 *  - `settings.section`: the full page — state, folder picker, move/restore,
 *    eject, and the removal instructions.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'sessionVault'
    const inject = ['slots', 'locale', 'remote.commands', 'uiWorkspace']

    const CSS = `
.sv-page{display:flex;flex-direction:column;gap:14px;max-width:760px}
.sv-title{margin:0;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}
.sv-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sv-hero{padding:14px 16px;border-radius:12px;font-size:14px;line-height:22px;border:1px solid var(--dsw-alias-border-l1)}
.sv-hero[data-state=on]{border-color:rgba(46,160,90,.55);color:#2ea05a}
.sv-hero[data-state=off]{border-color:rgba(212,150,30,.55);color:#b07a12}
.sv-card{padding:10px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px}
.sv-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;font-size:13px;line-height:20px}
.sv-row + .sv-row{border-top:1px solid var(--dsw-alias-border-l1)}
.sv-name{font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.sv-badge{flex:none;padding:1px 8px;border-radius:999px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.sv-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.sv-btn{height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.sv-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sv-btn:disabled{opacity:.5;cursor:default}
.sv-btn[data-kind=primary]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.sv-btn[data-kind=danger]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.sv-input{height:32px;flex:1;min-width:220px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.sv-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sv-warn{padding:10px 12px;border-radius:10px;font-size:13px;line-height:20px;border:1px solid rgba(212,150,30,.55);color:#b07a12}
.sv-err{padding:10px 12px;border-radius:10px;font-size:13px;line-height:20px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.sv-pill{position:fixed;left:14px;bottom:64px;z-index:60;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 4px 14px rgba(0,0,0,.12);font-size:12px;line-height:16px;cursor:default;pointer-events:auto}
.sv-dot{width:8px;height:8px;border-radius:50%;background:#b07a12}
.sv-dot[data-on=true]{background:#2ea05a}
.sv-pill-path{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,monospace);color:var(--dsw-alias-label-secondary)}
`

    const zh = {
      'title': '随身盘（U 盘）',
      'desc': '对话记录放在 U 盘里，本机不留副本。',
      'on': '对话记录在 U 盘上。',
      'off': '没有检测到随身盘。本机不会保存新的对话。',
      'local': '对话记录还在本机。点「搬到 U 盘」把它放过去。',
      'in.usb': 'U 盘',
      'in.pc': '本机',
      'in.none': '无',
      'eject': '安全拔出',
      'move': '搬到 U 盘',
      'restore': '搬回本机',
      'refresh': '刷新',
      'location': '随身盘文件夹：',
      'location.hint': '例如 F:\\我的随身盘',
      'pick': '选择文件夹…',
      'apply': '设为随身盘',
      'apply.ok': '已设置。点「搬到 U 盘」把本机数据放进去。',
      'restart': '请重启 DSH 生效。',
      'ejected': '已断开。现在可以安全拔出 U 盘。',
      'noSession': '请先打开任意一个对话。',
      'badPath': '请选择或填写一个文件夹路径。',
      'perm.title': '按会话读取需要一项一次性 Windows 权限，当前不可用。',
      'perm.probe': '检测结果',
      'perm.why': '原因：Windows 默认只允许管理员创建文件链接。开启开发者模式后普通程序即可创建。',
      'perm.enable': '开启（会弹出一次管理员确认）',
      'perm.after': '点“是”后永久生效；若仍不可用，注销一次 Windows。',
      'uninstall.title': '卸载前请注意',
      'uninstall.body': '卸载插件时，插件会自动把数据从随身盘复制回本机，并恢复普通目录，不会丢数据。但如果 U 盘此刻没插着，本机会恢复成空目录——对话仍然安全地留在 U 盘里，重新安装插件并插上 U 盘即可再看到。',
      'pill.on': '随身盘',
      'pill.off': '未连接',
      'pill.none': '未设置',
    }

    const en = {
      'title': 'Portable drive (USB)',
      'desc': 'Conversation data lives on the USB drive with no local copy.',
      'on': 'Conversation data is on the USB drive.',
      'off': 'No vault detected. Nothing new is stored on this PC.',
      'local': 'The data is still on this PC. Use “Move to USB”.',
      'in.usb': 'USB',
      'in.pc': 'this PC',
      'in.none': 'none',
      'eject': 'Eject safely',
      'move': 'Move to USB',
      'restore': 'Move back to PC',
      'refresh': 'Refresh',
      'location': 'Vault folder:',
      'location.hint': 'e.g. F:\\my-vault',
      'pick': 'Choose folder…',
      'apply': 'Use this folder',
      'apply.ok': 'Saved. Use “Move to USB” to copy local data in.',
      'restart': 'Restart DSH to apply.',
      'ejected': 'Detached. It is now safe to unplug the drive.',
      'noSession': 'Open any conversation first.',
      'badPath': 'Choose or type a folder path.',
      'perm.title': 'Per-session reading needs a one-time Windows permission and is unavailable.',
      'perm.probe': 'Probe',
      'perm.why': 'Windows only lets administrators create file links; enabling Developer Mode grants it to normal programs.',
      'perm.enable': 'Enable (one admin confirmation)',
      'perm.after': 'Takes effect permanently; if not, sign out of Windows once.',
      'uninstall.title': 'Before uninstalling',
      'uninstall.body': 'On uninstall the plugin copies the vault back to this PC and restores ordinary directories, so nothing is lost. If the drive is unplugged at that moment, the local directories come back empty — the data stays safe on the drive and reappears once the plugin is reinstalled and the drive is connected.',
      'pill.on': 'vault',
      'pill.off': 'not connected',
      'pill.none': 'not set',
    }

    /**
     * Call the Host `/vault` command.
     * @param ctx - client context.
     * @param runnerId - session used as the command carrier.
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
     * Find the session currently shown, used as the command carrier.
     * @param state - sessions snapshot.
     * @returns {string | null} session id.
     */
    function pickRunner(state) {
      const ids = state?.ids ?? []
      for (const id of ids) {
        if ((state.byId?.[id]?.retainedBy?.mainView ?? 0) > 0) return id
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

      /** Always-visible state pill. */
      function Pill(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const runnerId = props.useSessions(pickRunner)
        const [status, setStatus] = React.useState(null)

        React.useEffect(() => {
          if (runnerId === null) return undefined
          const call = createCaller(ctx, runnerId)
          let alive = true
          const tick = async () => {
            try {
              const next = JSON.parse(await call('status'))
              if (alive) setStatus(next)
            } catch {
              // Keep the last state rather than flashing an error in the pill.
            }
          }
          void tick()
          const timer = setInterval(() => void tick(), 20000)
          return () => {
            alive = false
            clearInterval(timer)
          }
        }, [runnerId])

        if (runnerId === null) return null
        const sessions = status?.items?.find((item) => item.name === 'sessions')
        const onUsb = sessions?.kind === 'linked'
        const vault = status?.vault ?? null
        const label = vault === null ? t('pill.none') : onUsb ? t('pill.on') : t('pill.off')
        return h(
          'div',
          { className: 'sv-pill', title: vault ?? '' },
          h('span', { className: 'sv-dot', 'data-on': onUsb ? 'true' : 'false' }),
          h('span', null, label),
          vault === null ? null : h('span', { className: 'sv-pill-path' }, vault),
        )
      }

      /** The settings page. */
      function Section(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const runnerId = props.useSessions(pickRunner)
        const [status, setStatus] = React.useState(null)
        const [path, setPath] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [notice, setNotice] = React.useState(null)
        const [perm, setPerm] = React.useState(null)

        const call = runnerId === null ? null : createCaller(ctx, runnerId)

        const refresh = React.useCallback(async () => {
          if (call === null) return
          try {
            const next = JSON.parse(await call('status'))
            setStatus(next)
            setPath((current) => (current === '' ? (next.vault ?? '') : current))
            try {
              setPerm(JSON.parse(await call('permission')))
            } catch {
              setPerm(null)
            }
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
          }
        }, [call])

        React.useEffect(() => {
          void refresh()
        }, [refresh])

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

        if (runnerId === null) {
          return h('div', { className: 'sv-page' },
            h('h2', { className: 'sv-title' }, t('title')),
            h('p', { className: 'sv-note' }, t('noSession')),
          )
        }

        const vault = status?.vault ?? null
        const items = status?.items ?? []
        const sessions = items.find((item) => item.name === 'sessions')
        const onUsb = sessions?.kind === 'linked'
        const localData = items.some((item) => item.kind === 'real' && (item.entries ?? 0) > 0)
        const hero = vault !== null && onUsb ? t('on') : localData ? t('local') : t('off')

        return h(
          'div',
          { className: 'sv-page' },
          h('h2', { className: 'sv-title' }, t('title')),
          h('p', { className: 'sv-desc' }, t('desc')),
          h('div', { className: 'sv-hero', 'data-state': onUsb ? 'on' : 'off' }, hero),
          error === null ? null : h('div', { className: 'sv-err' }, error),
          notice === null ? null : h('p', { className: 'sv-note' }, notice),

          perm !== null && perm.ok === false
            ? h(
                'div',
                { className: 'sv-warn' },
                h('p', null, t('perm.title')),
                h('p', { className: 'sv-note' }, `${t('perm.probe')}: ${perm.code ?? '?'} · ${t('perm.why')}`),
                h(
                  'div',
                  { className: 'sv-actions', style: { marginTop: '8px' } },
                  h(
                    'button',
                    { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void run('enable') },
                    t('perm.enable'),
                  ),
                  h('span', { className: 'sv-note' }, t('perm.after')),
                ),
              )
            : null,

          h(
            'div',
            { className: 'sv-card' },
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
            { className: 'sv-card' },
            h('p', { className: 'sv-note' }, t('location')),
            h(
              'div',
              { className: 'sv-actions', style: { marginTop: '6px' } },
              h('input', {
                className: 'sv-input',
                value: path,
                placeholder: t('location.hint'),
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
                  onClick: () => void run(`prepare ${path.trim()}`),
                },
                t('apply'),
              ),
            ),
            vault === null ? null : h('p', { className: 'sv-note' }, `${t('in.usb')}: ${vault}`),
          ),

          h(
            'div',
            { className: 'sv-actions' },
            h('button', { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void refresh() }, t('refresh')),
            localData
              ? h(
                  'button',
                  { className: 'sv-btn', type: 'button', 'data-kind': 'primary', disabled: busy, onClick: () => void run('move') },
                  t('move'),
                )
              : null,
            onUsb
              ? h('button', { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void run('restore') }, t('restore'))
              : null,
            h(
              'button',
              {
                className: 'sv-btn',
                type: 'button',
                'data-kind': 'danger',
                disabled: busy || !onUsb,
                onClick: () => void run('eject'),
              },
              t('eject'),
            ),
          ),

          h(
            'div',
            { className: 'sv-card' },
            h('p', { className: 'sv-name' }, t('uninstall.title')),
            h('p', { className: 'sv-note', style: { marginTop: '6px' } }, t('uninstall.body')),
          ),
        )
      }

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'session-vault-pill', order: 60, locale: NS }, Pill),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'session-vault',
            order: 40,
            locale: NS,
            label: () => ctx.locale.bind(NS)('title'),
          },
          Section,
        ),
      )
    }

    return { inject, apply }
  },
})
