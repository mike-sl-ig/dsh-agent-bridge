/**
 * dsh-agent-bridge — CLIENT half.
 *
 * One button in the Session-header utilities that opens the agent picker:
 * which external agents were found, which one is the default, which role
 * features are enabled, and what the last run did.
 *
 * Plain script, no build step: it only registers a factory with the shell's
 * module loader. Styles are inline, and the bundled dependencies it may require
 * come from the shell's frozen module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-bridge',
  factory: (require) => {
    const React = require('react')

    const FEATURES = [
      { key: 'verify', label: '跨模型交叉验证', hint: '用另一个模型族独立复核；已禁止调用工具，单趟出答案' },
      { key: 'bulk', label: '廉价批量执行', hint: '把机械性批量文本工作外包给便宜模型' },
      { key: 'second', label: '第二意见', hint: '对同一问题并行取一份独立答案；已禁止调用工具' },
    ]

    const MODE_CHOICES = [{ value: 'default', label: '默认（不附加角色设定）' }].concat(
      FEATURES.map((f) => ({ value: f.key, label: f.label })),
    )

    const s = {
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      btn: {
        display: 'inline-flex', alignItems: 'center', gap: '6px', height: '24px',
        padding: '0 9px', borderRadius: '7px', cursor: 'pointer', background: 'transparent',
        color: 'inherit', fontSize: '12px', lineHeight: 1, whiteSpace: 'nowrap', font: 'inherit',
      },
      dot: (color) => ({ width: '7px', height: '7px', borderRadius: '50%', background: color, flex: '0 0 auto' }),
      panel: {
        position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 80, width: '322px',
        maxHeight: '76vh', overflow: 'auto', padding: '10px 11px', borderRadius: '10px',
        background: '#1f1f1f', color: '#eaeaea', border: '1px solid rgba(255,255,255,.16)',
        boxShadow: '0 10px 30px rgba(0,0,0,.45)', fontSize: '12px', lineHeight: 1.5, textAlign: 'left',
      },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' },
      hTitle: { fontWeight: 600, fontSize: '12px' },
      hSub: { opacity: 0.6, fontSize: '11px' },
      section: { marginTop: '9px', paddingTop: '7px', borderTop: '1px solid rgba(255,255,255,.12)' },
      sectionTitle: { fontSize: '11px', opacity: 0.6, marginBottom: '4px' },
      agentRow: (disabled) => ({
        display: 'flex', alignItems: 'flex-start', gap: '7px', padding: '6px 7px', borderRadius: '7px',
        background: 'rgba(255,255,255,.03)', marginBottom: '4px', opacity: disabled ? 0.45 : 1,
      }),
      badge: (tone) => ({
        fontSize: '10px', lineHeight: 1.6, padding: '0 5px', borderRadius: '999px', marginLeft: '4px',
        background: tone === 'ok' ? 'rgba(62,207,142,.18)' : tone === 'warn' ? 'rgba(224,179,65,.18)' : 'rgba(255,120,120,.18)',
        color: tone === 'ok' ? '#3ecf8e' : tone === 'warn' ? '#e0b341' : '#ff8f8f',
      }),
      row: (disabled) => ({
        display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '6px 7px', borderRadius: '7px',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.42 : 1,
        background: 'rgba(255,255,255,.03)', marginBottom: '4px',
      }),
      rowTitle: { display: 'block', fontWeight: 500 },
      rowHint: { display: 'block', opacity: 0.6, fontSize: '11px', marginTop: '1px' },
      box: { marginTop: '2px', accentColor: '#5b9dff', flex: '0 0 auto' },
      radio: { marginTop: '3px', accentColor: '#5b9dff', flex: '0 0 auto' },
      field: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '8px' },
      sel: {
        flex: '1 1 auto', minWidth: 0, background: '#2a2a2a', color: '#eaeaea', font: 'inherit', fontSize: '11px',
        border: '1px solid rgba(255,255,255,.18)', borderRadius: '6px', padding: '3px 5px',
      },
      foot: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.14)',
      },
      mini: {
        background: 'transparent', color: '#cfcfcf', font: 'inherit', fontSize: '11px', cursor: 'pointer',
        border: '1px solid rgba(255,255,255,.22)', borderRadius: '6px', padding: '3px 8px',
      },
      note: { marginTop: '6px', fontSize: '11px', opacity: 0.72, wordBreak: 'break-word' },
      last: {
        marginTop: '9px', padding: '7px 8px', borderRadius: '7px',
        background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.10)',
      },
      lastHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '3px' },
      lastMeta: { fontSize: '11px', opacity: 0.65, marginBottom: '4px', wordBreak: 'break-word' },
      lastAnswer: {
        fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '112px',
        overflow: 'auto', background: 'rgba(0,0,0,.18)', borderRadius: '5px', padding: '5px 6px',
      },
      lastPath: { marginTop: '4px', fontSize: '10px', opacity: 0.45, wordBreak: 'break-all' },
    }

    const EMPTY = {
      auto: true,
      defaultAgent: '',
      defaultMode: 'default',
      enabled: { verify: false, bulk: false, second: false },
      agents: {},
    }

    function AgentBridgeButton() {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [agents, setAgents] = React.useState([])
      const [last, setLast] = React.useState(null)
      const [selftest, setSelftest] = React.useState(null)
      const [probe, setProbe] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const ref = React.useRef(null)

      /** Local HH:MM:SS — the panel is read by a human, not a machine. */
      const clock = (stamp) => {
        const d = new Date(stamp)
        const pad = (v) => String(v).padStart(2, '0')
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      }

      /**
       * Turn whatever the route just returned into ONE line the user can read.
       * Before this existed, 「刷新 / 连通检查」 ran a real `--version` probe for
       * every agent and showed nothing at all, so success and failure looked
       * identical — which is exactly the complaint.
       */
      function describeResult(j) {
        const at = Date.now()
        if (Array.isArray(j.probed) && j.probed.length) {
          const ok = j.probed.filter((p) => p.ok).length
          const detail = j.probed
            .map((p) => (p.ok ? `${p.id} ${p.version || '可用'}` : `${p.id} 失败${p.note ? '：' + p.note : ''}`))
            .join(' · ')
          return { ok: ok === j.probed.length, at, text: `连通检查 ${ok}/${j.probed.length} 可用 — ${detail}` }
        }
        if (Array.isArray(j.selftest) && j.selftest.length) {
          const ok = j.selftest.filter((r) => r.ok).length
          return { ok: ok === j.selftest.length, at, text: `自检 ${ok}/${j.selftest.length} 通过` }
        }
        const count = Array.isArray(j.agents) ? j.agents.length : 0
        return { ok: true, at, text: `已刷新：${count} 个配方` }
      }

      const load = React.useCallback((query, options) => {
        const quiet = Boolean(options && options.quiet)
        setBusy(true)
        if (!quiet) setStatus({ pending: true, ok: true, text: '正在检查…' })
        return fetch('api/agent.bridge' + (query || ''), { method: 'GET' })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then((j) => {
            setState(j.state || EMPTY)
            setAgents(Array.isArray(j.agents) ? j.agents : [])
            if (j.last !== undefined) setLast(j.last || null)
            if (j.selftest !== undefined) setSelftest(j.selftest || null)
            if (j.probed !== undefined) setProbe(Array.isArray(j.probed) ? j.probed : null)
            setNote('')
            if (!quiet) setStatus(describeResult(j))
          })
          .catch((e) => {
            const message = (e && e.message ? e.message : String(e))
            setNote('读取失败: ' + message)
            if (!quiet) setStatus({ ok: false, text: '检查失败：' + message, at: Date.now() })
          })
          .then(() => setBusy(false))
      }, [])

      React.useEffect(() => { void load('?last=1', { quiet: true }) }, [load])

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (ev) => { if (ref.current && !ref.current.contains(ev.target)) setOpen(false) }
        const onKey = (ev) => { if (ev.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const cfg = state || EMPTY
      const enabled = cfg.enabled || {}
      const installed = agents.filter((a) => a.installed)
      const defaultAgent = agents.find((a) => a.id === cfg.defaultAgent) || installed[0] || null
      const activeCount = FEATURES.filter((f) => enabled[f.key]).length
      const ready = installed.length > 0
      const paid = installed.filter((a) => a.cost === 'paid')
      const probeById = {}
      for (const entry of probe || []) probeById[entry.id] = entry

      const put = (mutate) => {
        const next = {
          auto: Boolean(cfg.auto),
          defaultAgent: cfg.defaultAgent || '',
          defaultMode: cfg.defaultMode || 'default',
          enabled: {
            verify: Boolean(enabled.verify),
            bulk: Boolean(enabled.bulk),
            second: Boolean(enabled.second),
          },
        }
        let agentModel = null
        mutate(next, (agentId, model) => { agentModel = { agentId, model } })
        const q = new URLSearchParams({
          save: '1',
          auto: next.auto ? '1' : '0',
          defaultAgent: next.defaultAgent,
          defaultMode: next.defaultMode,
          verify: next.enabled.verify ? '1' : '0',
          bulk: next.enabled.bulk ? '1' : '0',
          second: next.enabled.second ? '1' : '0',
        })
        if (agentModel) {
          q.set('agent', agentModel.agentId)
          q.set('model', agentModel.model)
        }
        load('?' + q.toString())
      }

      const modeLabel = cfg.auto
        ? 'DSH 全权'
        : !ready
          ? '未发现 agent'
          : (defaultAgent ? defaultAgent.label : 'Agent') + (activeCount ? ' ×' + activeCount : '')
      const dotColor = cfg.auto ? '#8a8a8a' : (!ready ? '#ff8f8f' : (activeCount ? '#3ecf8e' : '#e0b341'))

      const agentRows = agents.map((agent) => {
        const selected = defaultAgent && defaultAgent.id === agent.id
        return React.createElement('div', { key: agent.id, style: s.agentRow(!agent.installed) },
          React.createElement('input', {
            type: 'radio', name: 'agent-bridge-default', style: s.radio,
            checked: Boolean(selected), disabled: !agent.installed || cfg.auto,
            onChange: () => put((n) => { n.defaultAgent = agent.id }),
          }),
          React.createElement('span', { style: { flex: '1 1 auto', minWidth: 0 } },
            React.createElement('span', { style: s.rowTitle },
              agent.label,
              React.createElement('span', { style: s.badge(agent.installed ? 'ok' : 'bad') },
                agent.installed ? '已安装' : '未安装'),
              agent.cost === 'paid'
                ? React.createElement('span', { style: s.badge('warn') }, '付费')
                : null,
            ),
            React.createElement('span', { style: s.lastPath },
              agent.installed ? agent.path : ('找不到：' + ((agent.caps && agent.caps.bin) || agent.id))),
            // The connectivity answer, right where the agent lives.
            (probeById[agent.id])
              ? React.createElement('span', { style: { ...s.lastPath, color: probeById[agent.id].ok ? '#3ecf8e' : '#ff8f8f' } },
                  probeById[agent.id].ok
                    ? '连通 ✓ ' + (probeById[agent.id].version || '可用')
                    : '连通 ✗ ' + (probeById[agent.id].note || '探测失败'))
              : null,
            selected && agent.models && agent.models.length
              ? React.createElement('select', {
                  style: { ...s.sel, marginTop: '4px', width: '100%' },
                  value: agent.model || '',
                  disabled: cfg.auto,
                  onChange: (ev) => put((n, setModel) => { n.defaultAgent = agent.id; setModel(agent.id, ev.target.value) }),
                }, [React.createElement('option', { key: '', value: '' }, 'CLI 默认')].concat(
                  agent.models.map((m) => React.createElement('option', { key: m, value: m }, m.replace(/^[^/]+\//, ''))),
                ))
              : null,
          ),
        )
      })

      const featureRows = FEATURES.map((f) =>
        React.createElement('label', { key: f.key, style: s.row(cfg.auto) },
          React.createElement('input', {
            type: 'checkbox', style: s.box, checked: Boolean(enabled[f.key]), disabled: cfg.auto,
            onChange: (ev) => {
              const on = ev.target.checked
              put((n) => {
                n.enabled[f.key] = on
                if (on && n.defaultMode === 'default') n.defaultMode = f.key
                if (!on && n.defaultMode === f.key) {
                  const firstOn = FEATURES.find((x) => n.enabled[x.key])
                  n.defaultMode = firstOn ? firstOn.key : 'default'
                }
              })
            },
          }),
          React.createElement('span', null,
            React.createElement('span', { style: s.rowTitle }, f.label),
            React.createElement('span', { style: s.rowHint }, f.hint),
          ),
        ),
      )

      const panel = React.createElement('div', { style: s.panel },
        React.createElement('div', { style: s.head },
          React.createElement('span', { style: s.hTitle }, 'Agent 桥接'),
          React.createElement('span', { style: s.hSub },
            (busy ? '同步中… ' : '') + (agents.length ? `${installed.length}/${agents.length} 已装` : '—')),
        ),

        // The outcome of the last action, in words. Without this line a probe
        // that ran for seconds and a probe that failed looked identical.
        status ? React.createElement('div', {
          style: {
            ...s.lastMeta,
            padding: '4px 10px',
            color: status.pending ? '#e0b341' : (status.ok ? '#3ecf8e' : '#ff8f8f'),
            wordBreak: 'break-word',
          },
        }, (status.pending ? '… ' : (status.ok ? '✓ ' : '✗ ')) + status.text
          + (status.at ? '（' + clock(status.at) + '）' : '')) : null,

        React.createElement('label', { style: s.row(false) },
          React.createElement('input', {
            type: 'checkbox', style: s.box, checked: Boolean(cfg.auto),
            onChange: (ev) => put((n) => { n.auto = ev.target.checked }),
          }),
          React.createElement('span', null,
            React.createElement('span', { style: s.rowTitle }, '全权交给 DeepSeek Harness'),
            React.createElement('span', { style: s.rowHint }, '外部 agent 不介入；下面三个功能全部停用'),
          ),
        ),

        React.createElement('div', { style: s.section },
          React.createElement('div', { style: s.sectionTitle }, '默认 agent'),
          agents.length ? agentRows : React.createElement('div', { style: s.lastMeta }, '没有找到任何配方（lib/recipes/*.json）'),
          paid.length ? React.createElement('div', { style: s.lastMeta }, '注意：选中付费 agent 会消耗你的额度。') : null,
        ),

        React.createElement('div', { style: s.section },
          React.createElement('div', { style: s.sectionTitle }, '能力开关'),
          featureRows,
        ),

        React.createElement('label', { style: s.field },
          React.createElement('span', { style: { opacity: 0.7 } }, '默认模式'),
          React.createElement('select', {
            style: s.sel, value: cfg.defaultMode || 'default',
            onChange: (ev) => put((n) => { n.defaultMode = ev.target.value }),
          }, MODE_CHOICES.map((m) =>
            React.createElement('option', {
              key: m.value, value: m.value,
              disabled: m.value !== 'default' && !enabled[m.value],
            }, m.label),
          )),
        ),

        last ? React.createElement('div', { style: s.last },
          React.createElement('div', { style: s.lastHead },
            React.createElement('span', { style: s.hTitle }, '最近一次运行'),
            React.createElement('span', { style: s.badge(last.Ok ? 'ok' : 'bad') }, last.Ok ? 'Ok' : '失败'),
          ),
          React.createElement('div', { style: s.lastMeta },
            [last.Agent, last.Mode, (last.TimeLocal || last.Time), (last.Seconds + 's'),
              ((last.ToolCalls || 0) + ' 次工具调用'), (last.Model || 'CLI 默认')].filter(Boolean).join(' · '),
          ),
          last.Answer
            ? React.createElement('div', { style: s.lastAnswer },
                String(last.Answer).slice(0, 320) + (String(last.Answer).length > 320 ? '…' : ''))
            : React.createElement('div', { style: s.lastMeta }, '(没有产出最终答案)'),
          last.Report
            ? React.createElement('div', { style: s.lastPath }, '报告: ' + last.Report)
            : null,
        ) : null,

        selftest ? React.createElement('div', { style: s.last },
          React.createElement('div', { style: s.lastHead },
            React.createElement('span', { style: s.hTitle }, '自检'),
            React.createElement('span', { style: s.lastMeta },
              selftest.filter((r) => r.ok).length + '/' + selftest.length + ' 通过'),
          ),
          selftest.map((r) => React.createElement('div', { key: r.id, style: s.lastMeta },
            (r.ok ? 'OK  ' : 'FAIL  ') + r.label + ' · ' + [
              '配方' + (r.recipeValid ? '✓' : '✗'),
              r.installed ? '已安装' : '未安装',
              r.probe ? ('版本' + (r.probe.ok ? '✓' : '✗')) : '未探测',
              r.fixture ? ('样本' + (r.fixture.ok ? '✓' : '✗')) : '无样本',
            ].join(' · ') + (r.problems && r.problems.length ? ' — ' + r.problems[0] : ''),
          )),
        ) : null,

        React.createElement('div', { style: s.foot },
          React.createElement('button', {
            type: 'button', style: s.mini, disabled: busy,
            onClick: () => load('?probe=1&last=1'),
          }, busy ? '检查中…' : '刷新 / 连通检查'),
          React.createElement('button', {
            type: 'button', style: s.mini, disabled: busy,
            onClick: () => load('?selftest=1&last=1'),
          }, busy ? '检查中…' : '自检'),
          React.createElement('button', {
            type: 'button', style: s.mini,
            onClick: () => setOpen(false),
          }, '关闭'),
        ),

        note ? React.createElement('div', { style: s.note }, note) : null,
        React.createElement('div', { style: { ...s.lastPath, marginTop: '6px' } }, '配方目录: lib/recipes/*.json'),
      )

      return React.createElement('span', { style: s.wrap, ref },
        React.createElement('button', {
          type: 'button',
          style: { ...s.btn, border: '1px solid ' + (cfg.auto ? 'rgba(255,255,255,.22)' : 'rgba(120,180,255,.75)') },
          title: 'Agent 桥接：选择外部 agent、切换模式（跨模型交叉验证 / 廉价批量执行 / 第二意见 / 全权交给 DSH）',
          'aria-label': 'Agent 桥接',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((v) => { if (!v) void load('?last=1'); return !v }),
        },
          React.createElement('span', { style: s.dot(dotColor) }),
          React.createElement('span', null, modeLabel),
        ),
        open ? panel : null,
      )
    }

    const inject = ['slots']

    /**
     * Contribute the agent picker to the Session-header utilities slot.
     *
     * MUST go through ctx.slots.inject: SlotCore.register throws for a slot that
     * is not declared yet, and on a fresh web boot this bundle can activate
     * before the conversation UI declares `conversation.session.header.utilities`.
     * That throw fails the entry's fiber and the boot audit then refuses the
     * whole web boot. The try/catch is boot insurance: a UI-only contribution
     * must never be able to block startup.
     */
    function apply(ctx) {
      try {
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'agent-bridge-mode',
        }, AgentBridgeButton))
      } catch (error) {
        console.error('[agent-bridge] header button registration failed', error)
      }
    }

    return { name: 'agent-bridge', inject, apply }
  },
})
