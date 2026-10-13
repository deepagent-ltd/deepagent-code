export * as BrowserDNSMessage from "./managed-browser-dns-message"

/** RFC 1035 wire data only. This module neither resolves nor authorizes a name. */
export class InvalidMessage extends Error {
  constructor() { super("Invalid DNS response") }
}
const invalid = (): never => { throw new InvalidMessage() }
export const question = (hostname: string, type: 1 | 28) => {
  if (hostname.length > 253 || !hostname.includes(".") || hostname !== hostname.toLowerCase() ||
    hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid()
  const name = Buffer.concat([...hostname.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])), Buffer.from([0])])
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(type); tail.writeUInt16BE(1, 2)
  return Buffer.concat([header, name, tail])
}

export function response(packet: Buffer, hostname: string, type: 1 | 28) {
  if (packet.length < 12 || packet.length > 65535 || packet.readUInt16BE(0) !== 0 ||
    (packet.readUInt16BE(2) & 0xfa4f) !== 0x8000 || packet.readUInt16BE(4) !== 1) invalid()
  const question = readName(packet, 12)
  if (question.name !== hostname || question.next + 4 > packet.length ||
    packet.readUInt16BE(question.next) !== type || packet.readUInt16BE(question.next + 2) !== 1) invalid()
  const counts = [packet.readUInt16BE(6), packet.readUInt16BE(8), packet.readUInt16BE(10)]
  if (counts.reduce((total, count) => total + count, 0) > 128) invalid()
  const state = { offset: question.next + 4 }
  const allAddresses: string[] = []
  const answers: Array<{ owner: string; type: number; target?: string; address?: string }> = []
  for (const [section, count] of counts.entries()) {
    for (let index = 0; index < count; index++) {
      const owner = readName(packet, state.offset)
      if (owner.next + 10 > packet.length) invalid()
      const kind = packet.readUInt16BE(owner.next)
      const family = packet.readUInt16BE(owner.next + 2)
      const length = packet.readUInt16BE(owner.next + 8)
      const start = owner.next + 10
      const end = start + length
      if (end > packet.length || (family !== 1 && kind !== 41)) invalid()
      const record: typeof answers[number] = { owner: owner.name, type: kind }
      if (kind === 1 || kind === 28) {
        if (length !== (kind === 1 ? 4 : 16)) invalid()
        record.address = kind === 1 ? [...packet.subarray(start, end)].join(".") :
          Array.from({ length: 8 }, (_, position) => packet.readUInt16BE(start + position * 2).toString(16)).join(":")
        allAddresses.push(record.address)
      }
      if (kind === 5) {
        const target = readName(packet, start, end)
        if (target.next !== end || !target.name) invalid()
        record.target = target.name
      }
      // DNAME and extended rcodes are not guessed; no additional record is a route.
      if (kind === 39 || (kind === 41 && (packet.readUInt32BE(owner.next + 4) >>> 24) !== 0)) invalid()
      if (section === 0) answers.push(record)
      state.offset = end
    }
  }
  if (state.offset !== packet.length) invalid()
  const chain = { name: hostname, depth: 0 }
  const visited = new Set<string>()
  while (true) {
    if (visited.has(chain.name)) invalid()
    visited.add(chain.name)
    const links = answers.filter((record) => record.owner === chain.name && record.type === 5)
    if (!links.length) break
    if (links.length !== 1 || ++chain.depth > 8 || answers.some((record) => record.owner === chain.name && record.address)) invalid()
    chain.name = links[0]!.target!
  }
  if (answers.some((record) => record.target && !visited.has(record.owner))) invalid()
  const addresses = [...new Set(answers.filter((record) => record.owner === chain.name && record.type === type)
    .map((record) => record.address).filter((value): value is string => value !== undefined))]
  if (allAddresses.length > 32 || answers.some((record) => record.address && (record.owner !== chain.name || record.type !== type))) invalid()
  return { addresses, allAddresses, canonicalName: chain.name }
}

function readName(packet: Buffer, start: number, limit = packet.length) {
  const cursor = { offset: start, next: undefined as number | undefined, hops: 0, bytes: 0 }
  const labels: string[] = []
  const visited = new Set<number>()
  while (true) {
    if (cursor.offset >= packet.length || (cursor.next === undefined && cursor.offset >= limit) || visited.has(cursor.offset)) invalid()
    visited.add(cursor.offset)
    const size = packet[cursor.offset]!
    if (size === 0) {
      cursor.bytes++
      if (cursor.bytes > 255) invalid()
      return { name: labels.join(".").toLowerCase(), next: cursor.next ?? cursor.offset + 1 }
    }
    if ((size & 0xc0) === 0xc0) {
      if (++cursor.hops > 16 || cursor.offset + 2 > packet.length || (cursor.next === undefined && cursor.offset + 2 > limit)) invalid()
      const pointer = packet.readUInt16BE(cursor.offset) & 0x3fff
      if (pointer >= cursor.offset || pointer < 12) invalid()
      cursor.next ??= cursor.offset + 2
      cursor.offset = pointer
      continue
    }
    if (size > 63 || cursor.offset + size + 1 > packet.length ||
      (cursor.next === undefined && cursor.offset + size + 1 > limit)) invalid()
    const label = packet.subarray(cursor.offset + 1, cursor.offset + size + 1)
    if ([...label].some((byte) => !((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) || byte === 45 || byte === 95))) invalid()
    cursor.bytes += size + 1
    if (cursor.bytes > 254) invalid()
    labels.push(label.toString("ascii")); cursor.offset += size + 1
  }
}
