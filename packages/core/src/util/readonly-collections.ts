export function readonlySet<Value>(source: ReadonlySet<Value>): ReadonlySet<Value> {
  const view: ReadonlySet<Value> = Object.freeze({
    get size() {
      return source.size
    },
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    has: (value: Value) => source.has(value),
    forEach: (callback: (value: Value, key: Value, set: ReadonlySet<Value>) => void, thisArg?: unknown) =>
      source.forEach((value) => callback.call(thisArg, value, value, view)),
    union: <Other>(other: ReadonlySetLike<Other>) => new Set<Value | Other>([...source, ...setLikeValues(other)]),
    intersection: <Other>(other: ReadonlySetLike<Other>) =>
      new Set<Value & Other>(
        Array.from(source).filter((value): value is Value & Other => other.has(value as unknown as Other)),
      ),
    difference: (other: ReadonlySetLike<unknown>) => new Set(Array.from(source).filter((value) => !other.has(value))),
    symmetricDifference: <Other>(other: ReadonlySetLike<Other>) =>
      new Set<Value | Other>([
        ...Array.from(source).filter((value) => !other.has(value as unknown as Other)),
        ...setLikeValues(other).filter((value) => !source.has(value as unknown as Value)),
      ]),
    isSubsetOf: (other: ReadonlySetLike<unknown>) => Array.from(source).every((value) => other.has(value)),
    isSupersetOf: (other: ReadonlySetLike<unknown>) =>
      setLikeValues(other).every((value) => source.has(value as Value)),
    isDisjointFrom: (other: ReadonlySetLike<unknown>) => Array.from(source).every((value) => !other.has(value)),
    [Symbol.iterator]: () => source[Symbol.iterator](),
  })
  return view
}

function setLikeValues<Value>(source: ReadonlySetLike<Value>) {
  return Array.from({ [Symbol.iterator]: () => source.keys() })
}

export function readonlyMap<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  const view: ReadonlyMap<Key, Value> = Object.freeze({
    get size() {
      return source.size
    },
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    get: (key: Key) => source.get(key),
    has: (key: Key) => source.has(key),
    forEach: (callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) =>
      source.forEach((value, key) => callback.call(thisArg, value, key, view)),
    [Symbol.iterator]: () => source[Symbol.iterator](),
  })
  return view
}
