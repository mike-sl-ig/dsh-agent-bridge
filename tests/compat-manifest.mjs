/**
 * The DSH version this plugin declares itself compatible with.
 *
 * Why this file exists: DSH refuses (or explicitly warns about) a plugin whose
 * `peerDependencies['@deepseek-ai/dsh']` does not admit the running version —
 * `packages/boot/app-boot/src/plugin-compatibility.ts`:
 *
 *   semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })
 *
 * Two consequences drive the assertions below:
 *   1. `includePrerelease: true` means a prerelease runtime (0.2.1-alpha.2) DOES
 *      satisfy a range like `>=0.2.0-rc.2 <0.3.0`. Without that option it would
 *      NOT, and the plugin would be rejected on every alpha build.
 *   2. A wrong upper bound silently locks the plugin out, so the range is pinned
 *      by evidence: the versions this suite has actually been run against.
 *
 * Zero dependencies on purpose. The `satisfies` below implements only the
 * comparator forms this manifest uses (space-separated `>=X` / `<Y`) with
 * semver 2.0.0 precedence, and deliberately skips the "prerelease exclusion"
 * rule because DSH turns that rule off.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log(`PASS ${name}`)
  else {
    failures++
    console.log(`FAIL ${name}${detail === undefined ? '' : `  -- ${detail}`}`)
  }
}

/* ---------------------------------------------------------------- semver -- */

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parse(version) {
  const m = VERSION.exec(String(version).trim().replace(/^v/, ''))
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] === undefined ? [] : m[4].split('.') }
}

/** semver 2.0.0 precedence: a prerelease sorts BEFORE its own release. */
function compare(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const a = left.pre[i]
    const b = right.pre[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const an = /^\d+$/.test(a)
    const bn = /^\d+$/.test(b)
    if (an && bn) {
      if (+a !== +b) return +a < +b ? -1 : 1
    } else if (an !== bn) {
      return an ? -1 : 1
    } else if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return 0
}

/** True when every whitespace-separated comparator holds (DSH's call shape). */
function satisfies(version, range) {
  const v = parse(version)
  if (v === null) return false
  const comparators = String(range).trim().split(/\s+/).filter(Boolean)
  if (comparators.length === 0) return false
  for (const comparator of comparators) {
    const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator)
    if (m === null) return false
    const bound = parse(m[2])
    if (bound === null) return false
    const order = compare(v, bound)
    const op = m[1] === undefined ? '=' : m[1]
    const ok =
      op === '>=' ? order >= 0 : op === '<=' ? order <= 0 : op === '>' ? order > 0 : op === '<' ? order < 0 : order === 0
    if (!ok) return false
  }
  return true
}

/* --------------------------------------------------------------- manifest -- */

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const declared = manifest.peerDependencies === undefined ? undefined : manifest.peerDependencies['@deepseek-ai/dsh']

check('the manifest declares a @deepseek-ai/dsh peer requirement', typeof declared === 'string' && declared.trim() !== '', String(declared))
check('the peer is a range, not a pinned version', typeof declared === 'string' && /[<>]/.test(declared), String(declared))

/* The versions this suite is evidence for. Keep this list honest: add a row only
 * after the suite has actually been run against that runtime. */
const admitted = ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1']
for (const version of admitted) {
  check(`the declared range admits dsh ${version}`, satisfies(version, declared), `${declared} vs ${version}`)
}

/* The upper bound is a promise too: past it the plugin must be re-verified
 * rather than silently loaded into an untested runtime. The `typeof` guard is
 * load-bearing: without it a MISSING declaration would satisfy this check
 * vacuously (satisfies() is false for an undefined range), and the suite would
 * pass with no peer requirement at all. */
check('the declared range refuses dsh 0.3.0',
  typeof declared === 'string' && declared.trim() !== '' && !satisfies('0.3.0', declared), `${declared} vs 0.3.0`)

/* Guard the matcher itself: a satisfies() that says yes to everything would make
 * every assertion above vacuous. Literal ranges, so these stay meaningful even
 * when the manifest declaration is missing. */
check('the matcher rejects an obviously out-of-range version', !satisfies('0.1.0', '>=0.2.0-rc.2 <0.3.0'))
check('the matcher refuses a version past the upper bound', !satisfies('0.3.0', '>=0.2.0-rc.2 <0.3.0'))
check('the matcher admits one inside the range', satisfies('0.2.1-alpha.2', '>=0.2.0-rc.2 <0.3.0'))
check('the matcher rejects a malformed version', !satisfies('not-a-version', declared))
check('the matcher orders a prerelease before its own release', satisfies('0.2.1-alpha.2', '>=0.2.0-rc.2') && !satisfies('0.2.1-alpha.2', '>=0.2.1'))

console.log(`\n${failures === 0 ? 'COMPAT MANIFEST: PASS' : `COMPAT MANIFEST: FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
