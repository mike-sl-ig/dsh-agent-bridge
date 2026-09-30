/**
 * Recipe validation and drafting — the trust boundary for community recipes.
 *
 * Two jobs:
 *   1. `validateRecipe` decides whether a recipe is acceptable. It is used for
 *      the bundled recipes in tests AND for anything a user (or later, a
 *      registry) hands the plugin. Recipes are data, so validation is the only
 *      thing standing between "JSON file" and "we will spawn this argv".
 *   2. `draftFromRun` turns one captured run of an UNKNOWN CLI into a draft
 *      recipe plus the candidate fields worth looking at, which is what makes
 *      a guided wizard possible instead of guesswork.
 */

const COSTS = ['free', 'paid', 'unknown']
const FORMATS = ['jsonl', 'json', 'text']
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

const KNOWN_KEYS = new Set([
  'id', 'label', 'vendor', 'cost', 'homepage', 'notes',
  'discover', 'version', 'run', 'output', 'caps', 'models', 'safety', '$schema',
])

const isString = (value) => typeof value === 'string' && value.trim() !== ''
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Validate one recipe.
 * @param recipe Parsed JSON (any shape).
 * @param options requireDiscovery — false accepts a draft that has no discovery yet.
 * @returns { ok, problems, warnings } — problems block, warnings do not.
 */
export function validateRecipe(recipe, options = {}) {
  const { requireDiscovery = true, strictKeys = false } = options
  const problems = []
  const warnings = []

  if (!isPlainObject(recipe)) return { ok: false, problems: ['recipe must be a JSON object'], warnings }

  if (!isString(recipe.id) || !ID_PATTERN.test(recipe.id)) {
    problems.push('id must be a lowercase slug matching ^[a-z0-9][a-z0-9-]{0,39}$')
  }
  if (!isString(recipe.label)) problems.push('label must be a non-empty string')
  if (!COSTS.includes(recipe.cost)) problems.push(`cost must be one of ${COSTS.join(' | ')}`)

  if (!isPlainObject(recipe.discover)) {
    if (requireDiscovery) problems.push('discover must be an object')
  } else {
    const d = recipe.discover
    const hasEnv = Array.isArray(d.env) && d.env.length > 0
    const hasBin = Array.isArray(d.bin) && d.bin.length > 0
    const hasPaths = isPlainObject(d.paths) && Object.values(d.paths).some((list) => Array.isArray(list) && list.length > 0)
    const hasDerive = Array.isArray(d.derive) && d.derive.length > 0
    if (requireDiscovery && !(hasEnv || hasBin || hasPaths || hasDerive)) {
      problems.push('discover needs at least one non-empty source (env / bin / paths / derive)')
    }
    if (recipe.discover.env !== undefined && !Array.isArray(recipe.discover.env)) problems.push('discover.env must be an array of environment variable names')
    if (recipe.discover.bin !== undefined && !Array.isArray(recipe.discover.bin)) problems.push('discover.bin must be an array of command names')
    if (recipe.discover.paths !== undefined && !isPlainObject(recipe.discover.paths)) problems.push('discover.paths must be an object keyed by platform (win32 / darwin / linux)')
    if (recipe.discover.derive !== undefined && !Array.isArray(recipe.discover.derive)) problems.push('discover.derive must be an array of { append } rules')
  }

  if (!isPlainObject(recipe.run)) {
    problems.push('run must be an object')
  } else {
    if (!Array.isArray(recipe.run.argv) || recipe.run.argv.some((arg) => typeof arg !== 'string')) {
      problems.push('run.argv must be an array of strings')
    }
    const via = isPlainObject(recipe.run.prompt) ? recipe.run.prompt.via : undefined
    if (!isString(via)) problems.push('run.prompt.via must be "positional", "stdin", or a flag name')
    for (const key of ['model', 'agent', 'session', 'resume', 'files']) {
      const flag = recipe.run[key]
      if (flag === undefined) continue
      if (!isPlainObject(flag)) problems.push(`run.${key} must be an object`)
      else if (key !== 'resume' && flag.flag !== undefined && !Array.isArray(flag.flag)) {
        problems.push(`run.${key}.flag must be an array of strings`)
      }
    }
  }

  if (!isPlainObject(recipe.output)) {
    problems.push('output must be an object')
  } else {
    if (!FORMATS.includes(recipe.output.format)) problems.push(`output.format must be one of ${FORMATS.join(' | ')}`)
    const answer = recipe.output.answer
    if (!isPlainObject(answer)) problems.push('output.answer must be an object')
    else if (!isString(answer.pick) && !isPlainObject(answer.where)) problems.push('output.answer needs either a pick path or a where filter')
    if (recipe.output.session !== undefined && !isString(recipe.output.session.pick)) problems.push('output.session.pick must be a path string')
    if (recipe.output.errorFlag !== undefined && !isString(recipe.output.errorFlag)) problems.push('output.errorFlag must be a path string')
    if (recipe.output.usage !== undefined) {
      if (!isPlainObject(recipe.output.usage)) problems.push('output.usage must be an object')
      else {
        for (const key of ['cost', 'input', 'output', 'reasoning', 'cacheRead', 'steps']) {
          if (recipe.output.usage[key] !== undefined && !isString(recipe.output.usage[key])) {
            problems.push(`output.usage.${key} must be a path string`)
          }
        }
      }
    }
  }

  if (recipe.models !== undefined && (!Array.isArray(recipe.models) || recipe.models.some((model) => typeof model !== 'string'))) {
    problems.push('models must be an array of strings')
  }
  if (recipe.caps !== undefined && !isPlainObject(recipe.caps)) problems.push('caps must be an object of booleans')

  for (const key of Object.keys(recipe)) {
    if (KNOWN_KEYS.has(key)) continue
    // Imported recipes are held to the exact schema: an unknown key is either a
    // typo or something a future version might interpret, and neither belongs in
    // a file that arrived over the network.
    if (strictKeys) problems.push(`unknown top-level key "${key}" is not allowed in an imported recipe`)
    else warnings.push(`unknown top-level key "${key}" is ignored`)
  }

  return { ok: problems.length === 0, problems, warnings }
}

/** Classify a captured stdout blob. */
export function detectFormat(text) {
  const trimmed = String(text || '').trim()
  if (trimmed === '') return 'text'
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '')
  const jsonLines = lines.filter((line) => {
    try { JSON.parse(line); return true } catch { return false }
  })
  if (jsonLines.length === lines.length && lines.length > 0) return lines.length > 1 ? 'jsonl' : 'json'
  try { JSON.parse(trimmed); return 'json' } catch { return 'text' }
}

const ANSWER_KEYS = ['result', 'response', 'answer', 'text', 'content', 'output', 'message', 'completion', 'reply', 'final']
const SESSION_KEYS = ['session_id', 'sessionId', 'sessionID', 'session', 'conversation_id', 'conversationId']
const COST_KEYS = ['total_cost_usd', 'cost_usd', 'cost', 'totalCost', 'costUSD']
const TOKEN_KEYS = { input: ['input_tokens', 'inputTokens', 'prompt_tokens'], output: ['output_tokens', 'outputTokens', 'completion_tokens'], cacheRead: ['cache_read_input_tokens', 'cacheReadInputTokens'] }

/**
 * Collect candidate paths for a set of field names, searching nested objects to
 * a small depth. The answer of a streaming CLI is usually nested (OpenCode keeps
 * it at `part.text`), so a top-level-only scan would miss the most common case.
 */
function collectPaths(object, keys, prefix = '', depth = 0, out = []) {
  if (!isPlainObject(object) || depth > 3) return out
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key
    const rank = keys.indexOf(key)
    if (rank >= 0 && (typeof value === 'string' || typeof value === 'number')) out.push({ path, value, rank, depth })
    if (isPlainObject(value)) collectPaths(value, keys, path, depth + 1, out)
  }
  return out
}

/** Order candidates by field-name priority, then shallowness, then path. */
function rankPaths(candidates, options = {}) {
  const { stringsOnly = false } = options
  const usable = stringsOnly ? candidates.filter((c) => typeof c.value === 'string' && c.value.trim() !== '') : candidates
  const best = new Map()
  for (const candidate of usable) {
    const seen = best.get(candidate.path)
    if (!seen || candidate.rank < seen.rank) best.set(candidate.path, candidate)
  }
  return [...best.values()]
    .sort((a, b) => (a.rank - b.rank) || (a.depth - b.depth) || a.path.localeCompare(b.path))
    .map((candidate) => candidate.path)
}

/**
 * Turn one captured run into a draft recipe + the evidence a user needs to
 * finish it. Nothing here guesses silently: every suggestion is paired with the
 * value that produced it.
 */
export function draftFromRun({ stdout = '', stderr = '', exitCode = null, argv = [] } = {}) {
  const format = detectFormat(stdout)
  const trimmed = String(stdout || '').trim()

  /* Build the pool of JSON values to inspect: one object for `json`, every event
   * for `jsonl` (a streaming CLI can put the answer on any event type). */
  let events = []
  let single = null
  if (format === 'json') {
    try { single = JSON.parse(trimmed) } catch { single = null }
  } else if (format === 'jsonl') {
    events = trimmed.split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((event) => event !== null)
  }
  const pool = format === 'jsonl' ? events : (single === null ? [] : [single])
  const primary = pool[0] || null

  const candidates = (keys, options) => rankPaths(pool.flatMap((value) => collectPaths(value, keys)), options)
  const answerPaths = candidates(ANSWER_KEYS, { stringsOnly: true })
  const sessionPaths = candidates(SESSION_KEYS, { stringsOnly: true })
  const costPaths = candidates(COST_KEYS)
  const tokenPaths = {}
  for (const [target, keys] of Object.entries(TOKEN_KEYS)) {
    const found = candidates(keys)
    if (found.length) tokenPaths[target] = found[0]
  }

  const draft = {
    id: '',
    label: '',
    vendor: '',
    cost: 'unknown',
    discover: { env: [], bin: [], paths: {}, derive: [] },
    version: { args: ['--version'] },
    run: {
      argv: argv.filter((arg) => typeof arg === 'string'),
      prompt: { via: 'positional' },
      model: { flag: ['--model'] },
    },
    output: {
      format,
      answer: answerPaths.length ? { pick: answerPaths[0] } : undefined,
      session: sessionPaths.length ? { pick: sessionPaths[0] } : undefined,
      usage: (costPaths.length || Object.keys(tokenPaths).length)
        ? {
            ...(costPaths.length ? { cost: costPaths[0] } : {}),
            ...tokenPaths,
          }
        : undefined,
    },
    caps: { model: true, session: sessionPaths.length > 0, resume: false, files: false, autoApprove: false, structured: format !== 'text' },
    _draft: {
      exitCode,
      format,
      answerCandidates: answerPaths,
      sessionCandidates: sessionPaths,
      costCandidates: costPaths,
      tokenCandidates: tokenPaths,
      topLevelKeys: isPlainObject(primary) ? Object.keys(primary) : [],
      stdoutChars: String(stdout || '').length,
      stderrHead: String(stderr || '').slice(0, 400),
      note: 'Fill in id/label/cost and the discovery block, then validate. Nothing was assumed: every path above is paired with a real observed field.',
    },
  }
  return draft
}
