/**
 * Prompt-transport test.
 *
 * Recipes may declare `run.prompt.via: "stdin"`, in which case the prompt must
 * NOT appear in argv and must instead be delivered on the child's stdin. That
 * path was reachable in the engine but never wired to the launcher — a recipe
 * using it would silently run with an empty prompt. These checks pin both
 * transports down:
 *
 *   - the direct path runs a REAL child (node itself, echoing stdin), so the
 *     file-descriptor stdin handoff is exercised for real;
 *   - the service path runs against a FAKE subprocess service, which is the only
 *     way to assert the stdio spec outside DSH.
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildArgs } from '../lib/engine.js'
import { launch } from '../lib/launch.js'

const logDir = join(tmpdir(), 'agent-bridge-stdin')
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : '  -- ' + detail}`)
}

const ECHO = ['-e', 'process.stdin.pipe(process.stdout)']

const stdinRecipe = {
  id: 'stdin-transport',
  run: { argv: ECHO, prompt: { via: 'stdin' } },
  output: { format: 'text', answer: { pick: 'text' } },
}
const positionalRecipe = {
  id: 'positional-transport',
  run: { argv: ECHO, prompt: { via: 'positional' } },
  output: { format: 'text', answer: { pick: 'text' } },
}
const flagRecipe = {
  id: 'flag-transport',
  run: { argv: ['say'], prompt: { via: '--prompt' } },
  output: { format: 'text', answer: { pick: 'text' } },
}

/* ------------------------------------------------------------- argv building */

const viaStdin = buildArgs(stdinRecipe, { prompt: 'PING-STDIN' })
check('stdin transport keeps the prompt out of argv',
  !viaStdin.args.includes('PING-STDIN') && viaStdin.promptVia === 'stdin', JSON.stringify(viaStdin.args))

const viaPositional = buildArgs(positionalRecipe, { prompt: 'PING-POS' })
check('positional transport appends the prompt last',
  viaPositional.args[viaPositional.args.length - 1] === 'PING-POS' && viaPositional.promptVia === 'positional',
  JSON.stringify(viaPositional.args))

const viaFlag = buildArgs(flagRecipe, { prompt: 'PING-FLAG' })
check('flag transport passes the prompt behind its flag',
  viaFlag.args.join(' ').endsWith('--prompt PING-FLAG') && viaFlag.promptVia === '--prompt',
  JSON.stringify(viaFlag.args))

/* --------------------------------------------------- direct path, real child */

const echoed = await launch(undefined, process.execPath, viaStdin.args, {
  cwd: tmpdir(),
  logDir,
  label: 'stdin-echo',
  timeoutMs: 30000,
  stdinText: 'PING-STDIN',
})
check('direct path: a real child receives the prompt on stdin',
  echoed.exitCode === 0 && echoed.stdout.includes('PING-STDIN'),
  `exit=${echoed.exitCode} stdout=${JSON.stringify(echoed.stdout.slice(0, 60))}`)
check('direct path: the stdin file on disk holds the prompt, not an empty file',
  echoed.outPath !== '' && (await import('node:fs')).readFileSync(echoed.outPath.replace(/\.out\.log$/, '.stdin'), 'utf8') === 'PING-STDIN',
  echoed.outPath)

const empty = await launch(undefined, process.execPath, viaStdin.args, {
  cwd: tmpdir(),
  logDir,
  label: 'stdin-empty',
  timeoutMs: 30000,
})
check('direct path: an empty stdin still means EOF (the child exits at once)',
  empty.exitCode === 0 && empty.stdout.trim() === '', `exit=${empty.exitCode} stdout=${JSON.stringify(empty.stdout)}`)

/* --------------------------------------------- service path, fake subprocess */

const captured = []
const fakeHandle = {
  done: Promise.resolve({ exitCode: 0, signal: null }),
  collected: {
    stdout: { readFrom: () => ({ text: 'FAKE-OUT', lossy: false }) },
    stderr: { readFrom: () => ({ text: '', lossy: false }) },
  },
  terminate: () => {},
}
const fakeService = {
  resolveExecutable: async (command) => command,
  spawn: (spec) => { captured.push(spec); return fakeHandle },
}
const serviceCtx = { get: (key) => (key === 'subprocess' ? fakeService : undefined) }

const serviced = await launch(serviceCtx, 'node', ['-e', 'x'], {
  cwd: tmpdir(),
  logDir,
  label: 'service-stdin',
  timeoutMs: 5000,
  stdinText: 'PING-STDIN',
})
check('service path: reads the collected streams back',
  serviced.stdout === 'FAKE-OUT' && serviced.via === 'subprocess-service' && serviced.exitCode === 0,
  `stdout=${JSON.stringify(serviced.stdout)} via=${serviced.via}`)
check('service path: passes the prompt as { data } on stdin',
  captured[0] && JSON.stringify(captured[0].stdio.stdin) === JSON.stringify({ data: 'PING-STDIN' }),
  JSON.stringify(captured[0] && captured[0].stdio.stdin))
check('service path: argv[0] is the resolved executable and stdout is collected',
  captured[0].argv[0] === 'node' && typeof captured[0].stdio.stdout.maxBytes === 'number' && captured[0].stdio.stdout.spill,
  JSON.stringify(captured[0].argv))

captured.length = 0
await launch(serviceCtx, 'node', ['-e', 'x'], { cwd: tmpdir(), logDir, label: 'service-nostdin', timeoutMs: 5000 })
check('service path: without a prompt the stdin is ignored (immediate EOF)',
  captured[0].stdio.stdin === 'ignore', JSON.stringify(captured[0].stdio.stdin))

console.log(`\n${failures === 0 ? 'PROMPT TRANSPORT: PASS' : `PROMPT TRANSPORT: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
