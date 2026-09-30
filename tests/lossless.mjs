/**
 * The lossless-JSON predicate DSH applies to every tool result.
 *
 * Reimplemented here (the plugin has no runtime dependencies on purpose) from
 * the documented rule: `null`, booleans, strings, finite numbers other than
 * negative zero, dense arrays, and plain or null-prototype records whose own
 * keys are all enumerable and whose values recurse. Cycles, sparse arrays,
 * symbols, non-enumerable own properties, accessors, functions and class
 * instances are rejected.
 *
 * Violating it does not merely corrupt a value — DSH rejects the WHOLE tool call
 * with "value is not lossless JSON", which is how one missing optional field in
 * a recipe once took down an entire agent_run.
 */

export function isLosslessJson(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)

  if (Object.getOwnPropertySymbols(value).length > 0) return false

  if (Array.isArray(value)) {
    // `length` is itself non-enumerable, so arrays are checked by index rather
    // than by descriptor; a sparse hole or an extra named key is still rejected.
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return false
      if (!isLosslessJson(value[index], seen)) return false
    }
    return Object.keys(value).every((key) => /^\d+$/.test(key))
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) return false
    if (!('value' in descriptor)) return false
    if (!isLosslessJson(descriptor.value, seen)) return false
  }
  return true
}

/** Describe the first violation, so a failure names the offending path. */
export function findLosslessViolation(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return ''
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `${path}: non-finite number (${value})`
    return Object.is(value, -0) ? `${path}: negative zero` : ''
  }
  if (typeof value === 'undefined') return `${path}: undefined`
  if (typeof value !== 'object') return `${path}: ${typeof value}`
  if (seen.has(value)) return `${path}: cycle`
  seen.add(value)

  for (const symbol of Object.getOwnPropertySymbols(value)) return `${path}: symbol key ${String(symbol)}`

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return `${path}: non-array prototype`
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return `${path}[${index}]: sparse array hole`
      const inner = findLosslessViolation(value[index], `${path}[${index}]`, seen)
      if (inner) return inner
    }
    const extra = Object.keys(value).find((key) => !/^\d+$/.test(key))
    return extra ? `${path}.${extra}: named key on an array` : ''
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return `${path}: non-plain prototype`
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) return `${path}.${key}: non-enumerable own property`
    if (!('value' in descriptor)) return `${path}.${key}: accessor`
    const inner = findLosslessViolation(descriptor.value, `${path}.${key}`, seen)
    if (inner) return inner
  }
  return ''
}
