/**
 * Session Vault — browser half.
 *
 * One settings section, deliberately tiny: it says where the data is, and
 * offers the only two actions a person needs — create a vault on a drive, or
 * detach before unplugging. Everything else happens automatically at startup.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'sessionVault'
    const inject = ['slots', 'locale', 'remote.commands']

    const CSS = `
.sv-page{display:flex;flex-direction:column;gap:14px;max-width:720px}
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
.sv-input{height:32px;width:80px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.sv-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sv-err{padding:10px 12px;border-radius:10px;font-size:13px;line-height:20px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
`

    const zh = {
      'title': '随身盘（U 盘）',
      'desc': '对话记录放在 U 盘里，本机不留副本。插上 U 盘打开 DSH 就能接着聊。',
      'on': '对话记录在 U 盘上。',
      'off': '没有检测到随身盘。本机不会保存新的对话。',
      'local': '对话记录还在本机。点下面的按钮把它搬到 U 盘（需要重启一次）。',
      'in.usb': 'U 盘',
      'in.pc': '本机',
      'in.none': '无',
      'eject': '安全拔出',
      'create': '在这块盘上创建随身盘',
      'refresh': '刷新',
      'drive': '盘符',
      'drive.hint': '例如 F:',
      'restart': '请重启 DSH，插件会在启动时接管。',
      'ejected': '已断开。现在可以安全拔出 U 盘。',
      'noSession': '请先打开任意一个对话。',
      'badDrive': '请填写盘符，例如 F:',
    }

    const en = {
      'title': 'Portable drive (USB)',
      'desc': 'Conversation data lives on the USB drive with no local copy. Plug it in, open DSH, continue.',
      'on': 'Conversation data is on the USB drive.',
      'off': 'No vault detected. Nothing new is stored on this PC.',
      'local': 'The data is still on this PC. Move it to the USB drive below (one restart).',
      'in.usb': 'USB',
      'in.pc': 'this PC',
      'in.none': 'none',
      'eject': 'Eject safely',
      'create': 'Create a vault on this drive',
      'refresh': 'Refresh',
      'drive': 'Drive',
      'drive.hint': 'e.g. F:',
      'restart': 'Restart DSH; the plugin takes over at startup.',
      'ejected': 'Detached. It is now safe to unplug the drive.',
      'noSession': 'Open any conversation first.',
      'badDrive': 'Enter a drive letter such as F:',
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
        if (response === undefined) throw new Error('没有收到回复')
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
        const execution = response.value
        if (execution === undefined) throw new Error('命令未执行')
        const result = execution.result
        if (result === undefined) throw new Error('命令返回格式异常')
        if (result.kind === 'error') throw new Error(result.text)
        return result.text ?? ''
      }
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

      /** The whole settings page. */
      function Section(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const runnerId = props.useSessions((state) => {
          const ids = state?.ids ?? []
          for (const id of ids) {
            if ((state.byId?.[id]?.retainedBy?.mainView ?? 0) > 0) return id
          }
          return null
        })
        const [status, setStatus] = React.useState(null)
        const [drive, setDrive] = React.useState('')
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
            try {
              setPerm(JSON.parse(await call('permission')))
            } catch {
              setPerm(null)
            }
            if (drive === '' && typeof next.vault === 'string') {
              const match = /^([A-Za-z]:)/.exec(next.vault)
              if (match !== null) setDrive(match[1].toUpperCase())
            }
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
          }
        }, [call, drive])

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
          perm !== null && perm.ok === false
            ? h(
                'div',
                { className: 'sv-card' },
                h('p', { className: 'sv-desc' }, '按会话从 U 盘读取需要一项一次性 Windows 权限：允许创建“文件链接”。'),
                h('p', { className: 'sv-note' }, `检测结果：${perm.code ?? '未知'} · 开发者模式：${perm.developerMode === true ? '已开启' : '未开启'}`),
                h('p', { className: 'sv-note' }, '原因：Windows 默认只允许管理员创建文件链接。开启开发者模式后，普通程序即可创建，无需再确认。'),
                h(
                  'div',
                  { className: 'sv-actions' },
                  h(
                    'button',
                    {
                      className: 'sv-btn',
                      type: 'button',
                      'data-kind': 'primary',
                      disabled: busy,
                      onClick: () => void run('enable'),
                    },
                    '开启（会弹出一次管理员确认）',
                  ),
                  h('span', { className: 'sv-note' }, '点“是”后永久生效；若提示仍需重启，注销一次 Windows 即可。'),
                ),
              )
            : null,
          h('div', { className: 'sv-hero', 'data-state': onUsb ? 'on' : 'off' }, hero),
          error === null ? null : h('div', { className: 'sv-err' }, error),
          notice === null ? null : h('p', { className: 'sv-note' }, notice),

          h(
            'div',
            { className: 'sv-card' },
            items.map((item) =>
              h(
                'div',
                { className: 'sv-row', key: item.name },
                h('span', { className: 'sv-name' }, item.name),
                h(
                  'span',
                  { className: 'sv-badge' },
                  item.kind === 'linked' ? t('in.usb') : item.kind === 'real' ? t('in.pc') : t('in.none'),
                ),
              ),
            ),
          ),

          h(
            'div',
            { className: 'sv-actions' },
            h('button', { className: 'sv-btn', type: 'button', disabled: busy, onClick: () => void refresh() }, t('refresh')),
            vault === null
              ? h(
                  'span',
                  { className: 'sv-actions' },
                  h('span', { className: 'sv-note' }, t('drive')),
                  h('input', {
                    className: 'sv-input',
                    value: drive,
                    maxLength: 2,
                    placeholder: t('drive.hint'),
                    disabled: busy,
                    onChange: (event) => setDrive(event.target.value.toUpperCase()),
                  }),
                  h(
                    'button',
                    {
                      className: 'sv-btn',
                      type: 'button',
                      'data-kind': 'primary',
                      disabled: busy || !/^[A-Za-z]:$/.test(drive),
                      onClick: () => {
                        if (!/^[A-Za-z]:$/.test(drive)) {
                          setError(t('badDrive'))
                          return
                        }
                        void run(`prepare ${drive}`)
                      },
                    },
                    t('create'),
                  ),
                )
              : h(
                  'span',
                  { className: 'sv-actions' },
                  localData
                    ? h(
                        'button',
                        {
                          className: 'sv-btn',
                          type: 'button',
                          'data-kind': 'primary',
                          disabled: busy,
                          onClick: () => void run('move'),
                        },
                        '搬到 U 盘',
                      )
                    : null,
                  onUsb
                    ? h(
                        'button',
                        {
                          className: 'sv-btn',
                          type: 'button',
                          disabled: busy,
                          onClick: () => void run('restore'),
                        },
                        '搬回本机',
                      )
                    : null,
                  h(
                    'button',
                    {
                      className: 'sv-btn',
                      type: 'button',
                      disabled: busy || !onUsb,
                      onClick: () => void run('eject'),
                    },
                    t('eject'),
                  ),
                ),
          ),
        )
      }

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
