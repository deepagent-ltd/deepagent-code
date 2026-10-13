export * as WorkLeafProofCache from "./work-leaf-proof-cache"

/** Consumption cache only. Entries come from the original authenticated producer;
 * eviction never alters durable facts or substitutes for current SQL verification. */
export class Terminal<T extends object> {
  private readonly works = new Map<string, Map<string, T>>()
  private readonly owners = new Map<string, string>()

  get size() { return this.owners.size }
  get workCount() { return this.works.size }

  set(workID: string, effectID: string, value: T) {
    const owner = this.owners.get(effectID)
    if (owner !== undefined && owner !== workID) return false
    const prior = this.works.get(workID)
    if (prior && !prior.has(effectID) && prior.size >= 128) return false
    if (!prior && this.works.size >= 64) this.release(this.works.keys().next().value!)
    const entries = prior ?? new Map<string, T>()
    entries.set(effectID, value)
    this.owners.set(effectID, workID)
    this.works.delete(workID)
    this.works.set(workID, entries)
    return true
  }

  get(effectID: string) {
    const owner = this.owners.get(effectID)
    if (owner === undefined) return undefined
    const entries = this.works.get(owner)
    if (!entries) return undefined
    this.works.delete(owner)
    this.works.set(owner, entries)
    return entries.get(effectID)
  }

  release(workID: string) {
    const entries = this.works.get(workID)
    if (!entries) return
    this.works.delete(workID)
    entries.forEach((_, effectID) => this.owners.delete(effectID))
  }

  clear() {
    this.works.clear()
    this.owners.clear()
  }
}
