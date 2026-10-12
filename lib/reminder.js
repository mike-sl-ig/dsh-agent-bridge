/**
 * Advisory delegation reminders — the pure half.
 *
 * The 0.2.0 features were invisible: verify/bulk/second only did anything once
 * `agent_run` was called, so the user had to name an agent in every prompt.
 * DSH gives a plugin a waterfall hook before every agent step; this module
 * decides what, if anything, to say there.
 *
 * ADVISORY. Nothing here forces a call, and "DSH handles everything" means the
 * bridge says nothing at all.
 */

const FEATURES = [
  ['verify', '跨模型交叉验证'],
  ['bulk', '廉价批量执行'],
  ['second', '第二意见'],
]

/**
 * Escape the plugin-owned frame.
 *
 * Recipe ids and model names are EXTERNAL data — a community recipe can be
 * imported — so they must never be able to close `</system-reminder>` and
 * escape into the surrounding conversation.
 */
export function escapeReminderText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Enabled feature keys, in a stable order (never Object.keys order). */
export function enabledFeatures(state) {
  const enabled = (state && state.enabled) || {}
  return FEATURES.filter(([key]) => enabled[key] === true).map(([key]) => key)
}

/**
 * The reminder text, or null when the bridge should stay silent.
 * @param state agent-bridge state
 * @param info { agent, model } — the resolved default target, for a concrete ask.
 */
export function buildDelegationReminder(state, info = {}) {
  if (!state || state.auto === true) return null
  // The panel's advisory switch. Checked explicitly, not for truthiness: an
  // older state file carries no `remind` field at all and must still speak.
  if (state.remind === false) return null
  const features = enabledFeatures(state)
  if (!features.length) return null

  const labels = FEATURES.filter(([key]) => features.includes(key)).map(([, label]) => label)
  const agent = escapeReminderText(info.agent || state.defaultAgent || '')
  const model = escapeReminderText(info.model || '')
  const target = agent ? `${agent}${model ? ` (${model})` : ''}` : '已配置的外部 agent'
  const mode = features.includes(state.defaultMode) ? state.defaultMode : features[0]

  return [
    '<system-reminder>',
    `Agent 桥接（建议型）：已开启 ${labels.join(' / ')}。`,
    `当任务适合时，可先用 agent_run(mode="${escapeReminderText(mode)}") 调用 ${target}；`,
    '这是建议，不是必须——但你不需要等待用户点名。未开启的能力不要调用。',
    '</system-reminder>',
  ].join('\n')
}

/** A stable per-turn identity, or null when the payload does not carry one. */
export function turnKey(payload) {
  const p = payload || {}
  if (p.turn !== undefined && p.turn !== null) return `turn:${p.turn}`
  if (p.step !== undefined && p.step !== null) return `step:${p.step}`
  return null
}

const containsUserMessage = (messages) =>
  Array.isArray(messages) && messages.some((m) => m && (m.role === 'user' || m.type === 'user'))

/**
 * Decide one step: inject, stay silent, and what the new dedupe key is.
 *
 * Two dedupe paths on purpose. The real payload shape of `agent/pre-step` was
 * not measured when this was written, so an explicit turn/step key is used when
 * present and the batch's own user message is the fallback signal when it is
 * not. Both are unit-tested; neither can repeat the reminder inside one turn.
 */
export function planInjection(state, payload, lastKey) {
  /* Name the model the user actually configured for that agent, not just the
   * agent: "调用 opencode" tells the model far less than
   * "调用 opencode (opencode/mimo-v2.6-flash-free)". */
  const agentId = (state && state.defaultAgent) || ''
  const configured = (state && state.agents && state.agents[agentId]) || {}
  const info = { agent: agentId, model: configured.model || '' }
  const text = buildDelegationReminder(state, info)
  if (text === null) return { inject: false, key: lastKey ?? null, text: null }

  const key = turnKey(payload)
  if (key !== null) {
    if (key === lastKey) return { inject: false, key, text: null }
    return { inject: true, key, text }
  }
  if (!containsUserMessage(payload && payload.messages)) return { inject: false, key: lastKey ?? null, text: null }
  return { inject: true, key: lastKey ?? null, text }
}
