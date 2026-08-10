export function stringify(input: unknown) {
  return JSON.stringify(normalize(input, new WeakSet()))
}

function normalize(input: unknown, ancestors: WeakSet<object>): unknown {
  if (input === undefined || input === null) return null
  if (typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number") return Number.isFinite(input) ? input : null
  if (typeof input === "bigint" || typeof input === "function" || typeof input === "symbol") {
    throw new TypeError(`Unsupported canonical JSON value: ${typeof input}`)
  }
  if (ancestors.has(input)) throw new TypeError("Canonical JSON cannot encode cyclic values")

  ancestors.add(input)
  const result = Array.isArray(input)
    ? input.map((item) => normalize(item, ancestors))
    : Object.fromEntries(
        Object.keys(input)
          .sort()
          .filter((key) => (input as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, normalize((input as Record<string, unknown>)[key], ancestors)]),
      )
  ancestors.delete(input)
  return result
}

export * as CanonicalJson from "./canonical-json"
