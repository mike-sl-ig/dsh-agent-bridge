/**
 * Portable process launcher for external agent CLIs.
 *
 * TWO PATHS, ON PURPOSE
 * ---------------------------------------------------------------------------
 * 1. `ctx.subprocess` (preferred). DSH's own subprocess seam takes an ARGV
 *    VECTOR — no shell, no quoting — and owns the platform differences, the
 *    execution world and executable resolution. It is the only path that stays
 *    inside what DSH sanctions, which matters for a plugin other people install.
 * 2. `node:child_process` (fallback). Used when no subprocess service is
 *    mounted. Measured on Windows 2026-09-30: spawning with REAL FILE
 *    DESCRIPTORS (plus an empty stdin file so the CLI sees EOF immediately)
 *    finishes an OpenCode run in ~5s, whereas inherited pipes make the same CLI
 *    write its whole answer and then never exit. That measurement is why this
 *    fallback opens fds instead of using pipes.
 */

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Safe file-name fragment for a label. */
function slug(value) {
  return String(value || 'run').replace(/[^\w.-]+/g, '_').slice(0, 40)
}

/** Timestamp whose lexical order matches chronological order. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

const DEFAULT_STDOUT_MAX = 8 * 1024 * 1024
const DEFAULT_SPILL_MAX = 64 * 1024 * 1024

/**
 * Run one external command to completion.
 * @param ctx Cordis context (may be undefined); used only for `ctx.subprocess`.
 * @param exe Absolute path, or a bare name resolvable on PATH.
 * @param args Argument vector — never a shell string.
 * @param options cwd, logDir, label, timeoutMs, env, signal.
 * @returns Normalized result with the captured streams and the log file paths.
 */
export async function launch(ctx, exe, args, options = {}) {
  const {
    cwd = process.cwd(),
    logDir,
    label = 'run',
    timeoutMs = 600000,
    env,
    signal,
    stdinText = '',
  } = options
  if (!logDir) throw new Error('launch() needs options.logDir')
  mkdirSync(logDir, { recursive: true })

  const base = `${stamp()}-${slug(label)}`
  const paths = {
    out: join(logDir, `${base}.out.log`),
    err: join(logDir, `${base}.err.log`),
    stdin: join(logDir, `${base}.stdin`),
  }

  const service = ctx && typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined
  const raw = service && typeof service.spawn === 'function'
    ? await launchViaService(service, exe, args, { cwd, timeoutMs, env, signal, stdinText })
    : await launchDirect(exe, args, { cwd, timeoutMs, env, signal, stdinText, paths })

  // Keep per-run artifacts on disk in both paths: the report and any later
  // diagnosis read these, and they are what a user attaches to a bug report.
  writeFileSync(paths.out, raw.stdout || '', 'utf8')
  writeFileSync(paths.err, raw.stderr || '', 'utf8')
  return { ...raw, outPath: paths.out, errPath: paths.err }
}

/**
 * Preferred path: DSH's subprocess service.
 *
 * The service has no timeout parameter (only `graceMs`, which bounds terminate),
 * so the deadline is enforced here: on expiry we call `terminate()` and settle
 * as timedOut rather than letting a wedged agent hold the tool call forever.
 */
async function launchViaService(service, exe, args, { cwd, timeoutMs, env, signal, stdinText = '' }) {
  const started = Date.now()
  let resolved = exe
  try {
    resolved = await service.resolveExecutable(exe, env, signal)
  } catch (error) {
    // Keep going with the raw path: the provider may still accept it, and a
    // failed resolution is worth reporting rather than swallowing.
    return {
      spawned: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      ms: Date.now() - started,
      timedOut: false,
      aborted: false,
      error: `resolveExecutable failed for ${exe}: ${String(error && error.message || error)}`,
    }
  }

  let handle
  try {
    handle = service.spawn({
      argv: [resolved, ...args],
      cwd,
      stdio: {
        // A recipe whose prompt transport is `stdin` needs the text delivered on
        // the child's stdin; everything else gets 'ignore', i.e. an immediate
        // EOF — which is also what stops the "writes its whole answer and then
        // never exits" behaviour measured on Windows.
        stdin: stdinText ? { data: stdinText } : 'ignore',
        stdout: { maxBytes: DEFAULT_STDOUT_MAX, spill: { maxBytes: DEFAULT_SPILL_MAX } },
        stderr: { maxBytes: 1024 * 1024 },
      },
      graceMs: 3000,
      env,
      signal,
    })
  } catch (error) {
    return {
      spawned: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      ms: Date.now() - started,
      timedOut: false,
      aborted: false,
      error: `spawn rejected: ${String(error && error.message || error)}`,
    }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { handle.terminate() } catch { /* already gone */ }
  }, Math.max(1000, timeoutMs))

  let outcome = { exitCode: null, signal: null }
  let doneError = null
  try {
    outcome = await handle.done
  } catch (error) {
    doneError = String(error && error.message || error)
  } finally {
    clearTimeout(timer)
  }

  const read = (reader) => {
    if (!reader || typeof reader.readFrom !== 'function') return { text: '', lossy: false }
    try {
      const chunk = reader.readFrom(0)
      return { text: chunk.text || '', lossy: Boolean(chunk.lossy), spillPath: chunk.spillPath }
    } catch (error) {
      return { text: '', lossy: true, error: String(error && error.message || error) }
    }
  }
  const out = read(handle.collected && handle.collected.stdout)
  const err = read(handle.collected && handle.collected.stderr)

  return {
    spawned: true,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: out.text,
    stderr: err.text,
    lossy: out.lossy || err.lossy,
    spillPath: out.spillPath,
    ms: Date.now() - started,
    timedOut,
    aborted: Boolean(signal && signal.aborted),
    error: doneError || '',
    resolvedExecutable: resolved,
    via: 'subprocess-service',
  }
}

/**
 * Fallback path: node:child_process with real file descriptors.
 * Identical shape to the service path so callers never branch.
 */
function launchDirect(exe, args, { cwd, timeoutMs, env, signal, stdinText = '', paths }) {
  // The stdin file carries the prompt when a recipe asks for stdin transport;
  // otherwise it stays empty, which is the EOF the child needs in order to exit.
  writeFileSync(paths.stdin, stdinText, 'utf8')
  const started = Date.now()
  return new Promise((resolve) => {
    let inFd
    let outFd
    let errFd
    try {
      inFd = openSync(paths.stdin, 'r')
      outFd = openSync(paths.out, 'w')
      errFd = openSync(paths.err, 'w')
    } catch (error) {
      resolve({ spawned: false, exitCode: null, stdout: '', stderr: '', ms: 0, timedOut: false, aborted: false, error: `cannot open stdio: ${error.message}`, via: 'direct' })
      return
    }

    let child
    let settled = false
    let timedOut = false
    const cleanup = () => { for (const fd of [inFd, outFd, errFd]) { try { closeSync(fd) } catch { /* closed */ } } }
    const settle = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      let stdout = ''
      let stderr = ''
      try { stdout = readFileSync(paths.out, 'utf8') } catch { /* missing */ }
      try { stderr = readFileSync(paths.err, 'utf8') } catch { /* missing */ }
      resolve({ spawned: true, exitCode: null, stdout, stderr, ms: Date.now() - started, timedOut, aborted: false, error: '', via: 'direct', ...extra })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* gone */ }
      setTimeout(() => settle({ exitCode: null, timedOut: true }), 2000)
    }, Math.max(1000, timeoutMs))
    if (signal) {
      if (signal.aborted) { try { child = null } catch { /* noop */ } settle({ exitCode: null, aborted: true }); return }
      signal.addEventListener('abort', () => {
        try { child && child.kill() } catch { /* gone */ }
        settle({ exitCode: null, aborted: true })
      }, { once: true })
    }

    try {
      child = spawn(exe, args, { cwd, env, stdio: [inFd, outFd, errFd], windowsHide: true, shell: false })
    } catch (error) {
      settle({ spawned: false, error: String(error && error.message || error) })
      return
    }
    child.on('error', (error) => settle({ spawned: false, error: String(error && error.message || error) }))
    child.on('exit', (code, sig) => settle({ exitCode: code, signal: sig }))
  })
}
