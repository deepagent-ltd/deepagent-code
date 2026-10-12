import { liveTopic, liveRequest, decodeLive } from "./live-read";
import Proto from "../socket/proto";
import { topics, deliveryError, readerRequest, receiptRequest } from "./contract";

function varint(bytes, cursor) {
  let value = 0n;
  for (let i = 0; i < 10 && cursor.offset < bytes.length; i++) {
    const byte = bytes[cursor.offset++];
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) {
      if (i === 9 && byte > 1 || i > 0 && byte === 0) throw Error("noncanonical protobuf integer");
      return value;
    }
  }
  throw Error("truncated protobuf integer");
}

// Convert bounded BigInt via decimal text: upstream babel-minify rewrites direct
// Number(bigint) into unary +bigint, which throws in the released artifact.
// Inspect raw integer bytes before the bundled protobuf implementation can
// coerce them through Number (its browser build does not supply Long).
export function wireInteger(bytes, wanted) {
  const cursor = { offset: 0 };
  let value = "0";
  let seen = false;
  while (cursor.offset < bytes.length) {
    const raw = varint(bytes, cursor);
    if (raw > 4294967295n) throw Error("invalid protobuf tag");
    const tag = Number(raw.toString()), kind = tag & 7, id = tag >>> 3;
    if (!id || id === wanted && kind !== 0) throw Error("invalid protobuf field");
    if (kind === 0) {
      const integer = varint(bytes, cursor);
      if (id === wanted) {
        if (seen || integer > 9223372036854775807n) throw Error("invalid protected integer");
        seen = true; value = integer.toString();
      }
    } else if (kind === 2) {
      const length = varint(bytes, cursor);
      if (length > BigInt(bytes.length - cursor.offset)) throw Error("invalid protobuf length");
      cursor.offset += Number(length.toString());
    } else if (kind === 1) cursor.offset += 8;
    else if (kind === 5) cursor.offset += 4;
    else throw Error("invalid protobuf wire type");
    if (cursor.offset > bytes.length) throw Error("truncated protobuf field");
  }
  return value;
}

export function safeInteger(bytes, id) {
  const value = Number(wireInteger(bytes, id));
  if (!Number.isSafeInteger(value)) throw Error("unsafe protected timestamp");
  return value;
}

// Descriptor-driven strict decode uses the generated proto schema. Rejecting
// duplicate/default/unknown fields and noncanonical integers mirrors Go's
// deterministic marshal boundary without losing int64 values first.
export function strictDecode(typeName, bytes, limit) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > limit) throw Error("protected response size");
  const type = Proto.lookup(`codec.${typeName}`).resolveAll();
  const decode = (schema, body, depth) => {
    if (depth > 2) throw Error("protected nesting limit");
    // Resolving the outer type does not resolve its child's message fields.
    // Cold distributed clients have not run an encoder to initialize them.
    schema.resolveAll();
    const result = {};
    for (const field of schema.fieldsArray) result[field.name] = field.partOf ? undefined : field.repeated ? [] :
      field.type === "string" ? "" : field.type === "bool" ? false : field.type === "int64" && field.name === "msgSeqNo" ? "0" : 0;
    const cursor = { offset: 0 };
    const seen = new Set();
    let previous = 0;
    while (cursor.offset < body.length) {
      const raw = varint(body, cursor);
      if (raw > 4294967295n) throw Error("invalid protected tag");
      const tag = Number(raw.toString()), id = tag >>> 3, wire = tag & 7;
      const field = schema.fieldsById[id];
      if (!field || id < previous || seen.has(id) && !field.repeated) throw Error("unknown or duplicate protected field");
      seen.add(id); previous = id;
      const nested = field.resolvedType?.fieldsArray !== undefined;
      if (wire !== (field.type === "string" || nested ? 2 : 0)) throw Error("wrong protected wire type");
      let value;
      if (wire === 0) {
        const integer = varint(body, cursor);
        if (integer === 0n || integer > (field.type === "int64" ? 9223372036854775807n : field.type === "bool" ? 1n : 2147483647n))
          throw Error("invalid protected scalar");
        value = field.name === "msgSeqNo" ? integer.toString() : field.type === "bool" ? true : Number(integer.toString());
        if (typeof value === "number" && !Number.isSafeInteger(value)) throw Error("unsafe protected timestamp");
      } else {
        const length = varint(body, cursor);
        if (length === 0n || length > BigInt(body.length - cursor.offset) || length > BigInt(nested ? 131072 : field.name === "content" ? 65536 : 2048))
          throw Error("protected field size");
        const slice = body.subarray(cursor.offset, cursor.offset + Number(length.toString()));
        cursor.offset += Number(length.toString());
        value = nested ? decode(field.resolvedType, slice, depth + 1) : new TextDecoder("utf-8", { fatal: true }).decode(slice);
      }
      if (field.repeated) {
        if (result[field.name].length >= 32) throw Error("protected item limit");
        result[field.name].push(value);
      } else result[field.name] = value;
    }
    if (schema.oneofsArray.some(group => group.oneof.filter(name => result[name] !== undefined).length !== 1))
      throw Error("invalid protected oneof");
    return result;
  };
  return decode(type, bytes, 0);
}

export function decodeQuery(topic, bytes) {
  if (liveTopic(topic)) return decodeLive(bytes);
  const entry = topics[topic];
  if (!entry) throw deliveryError("query", "invalid_response");
  return strictDecode(entry[1], bytes, entry[2]);
}

export function encodeQuery(topic, input) {
  if (liveTopic(topic)) {
    const bytes = new TextEncoder().encode(JSON.stringify(liveRequest(topic, input)));
    if (bytes.length > 4096) throw deliveryError("live_read", "invalid_request");
    return bytes;
  }
  if (topic === "qry_delivery_capabilities") return new Uint8Array();
  const request = topic === "qry_delivery_receipt" ? receiptRequest(input) : readerRequest(topic, input);
  const type = Proto.lookup(topic === "qry_delivery_receipt" ? "codec.DeliveryReceiptQuery" : "codec.DeliveryReadQuery");
  const wire = topic === "qry_delivery_output_proof" ? { version: request.version, scopeKey: request.scopeKey,
    outputRows: request.rows.map(row => row.kind === "visible" ?
      { visible: { projectionKey: row.projectionKey, projectionRevision: row.projectionRevision } } :
      { pending: { conversationType: row.conversationType, targetId: row.conversationID } }) } : request;
  const bytes = type.encode(type.create(wire)).finish();
  if (bytes.length > 4096) throw deliveryError(topics[topic][0], "invalid_request");
  return bytes;
}
