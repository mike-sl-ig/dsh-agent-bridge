/**
 * Surfacing the CLI's own error.
 *
 * Both shipped JSON agents report failure INSIDE the stream instead of on
 * stderr: OpenCode writes `{"type":"error","error":{"type","message","status"}}`
 * and exits 1, CodeBuddy writes the same shape. Before this, a failed run
 * reported "(没有产出最终答案)" and the actual reason — a 401 — sat unread in the
 * raw log, which is exactly how a user ends up asking why nothing happened.
 */

import { normalize } from '../lib/engine.js'

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

const recipe = {
  id: 'opencode',
  output: {
    format: 'jsonl',
    answer: { where: { type: 'text' }, pick: 'part.text' },
    session: { pick: 'sessionID' },
  },
}
const raw = (stdout, exitCode = 1) => ({
  stdout, stderr: '', exitCode, ms: 900, spawned: true, via: 'direct', outPath: 'out', errPath: 'err',
})

/* The exact line the real run produced on 2026-10-12 22:57. */
const authError = JSON.stringify({
  type: 'error',
  sessionID: 'ses_ecf61ea8effeq441j4xlttkG3q',
  error: { type: 'provider.auth', message: 'Upstream request failed: Invalid credential', status: 401 },
})
const refused = normalize(recipe, {}, raw(`${authError}\n`))

check('the error message is surfaced', refused.Error === 'Upstream request failed: Invalid credential', refused.Error)
check('the error code carries the kind and status', refused.ErrorCode === 'provider.auth/401', refused.ErrorCode)
check('a refused run is not ok', refused.Ok === false)
check('the session id is still extracted', refused.Session === 'ses_ecf61ea8effeq441j4xlttkG3q', refused.Session)

const success = normalize(recipe, {}, raw(
  `${JSON.stringify({ type: 'text', part: { text: 'hello' } })}\n${JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 2 } } })}\n`,
  0,
))
check('a successful run reports no error', success.Error === '' && success.ErrorCode === '', `${success.Error}|${success.ErrorCode}`)
check('and is ok', success.Ok === true)

const stringError = normalize(recipe, {}, raw(`${JSON.stringify({ type: 'error', error: 'plain string failure' })}\n`))
check('a string-shaped error is surfaced too', stringError.Error === 'plain string failure', stringError.Error)

const topLevelMessage = normalize(recipe, {}, raw(`${JSON.stringify({ type: 'error', message: 'top level message' })}\n`))
check('a top-level message is the last resort', topLevelMessage.Error === 'top level message', topLevelMessage.Error)

const noBody = normalize(recipe, {}, raw(`${JSON.stringify({ type: 'error' })}\n`))
check('an error event with no text reports an empty message, not a crash', noBody.Error === '')

const nonErrorJson = normalize(recipe, {}, raw(`${JSON.stringify({ type: 'text', part: { text: 'x' } })}\n`, 0))
check('a non-error event is never mistaken for one', nonErrorJson.Error === '')

/* Claude Code reports failure inside a SUCCESSFUL process (is_error), which the
 * recipe already names. That must keep working and must not be overwritten. */
const claude = {
  id: 'claude',
  output: { format: 'json', answer: { pick: 'result' }, errorFlag: 'is_error' },
}
const claudeFailed = normalize(claude, {}, raw(`${JSON.stringify({ result: 'x', is_error: true })}\n`, 0))
check('the recipe-declared error flag still fails the run', claudeFailed.Ok === false)
check('and it does not invent a CLI error message', claudeFailed.Error === '')

const junk = normalize(recipe, {}, raw('not json at all\n', 1))
check('junk stdout does not crash the normalizer', junk.Error === '' && junk.Ok === false)

console.log(failures ? `\n${failures} failure(s)` : '\nall good')
process.exit(failures ? 1 : 0)
