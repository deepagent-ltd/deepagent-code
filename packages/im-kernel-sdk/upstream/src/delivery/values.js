// Shared strict data primitives. No reader or media module dependencies.
export function deliveryError(operation, kind, wireCode) {
  return Object.freeze({ name: "DeliveryError", operation, kind,
    code: wireCode === undefined ? 30001 : wireCode,
    ...(wireCode === undefined ? {} : { wireCode }),
    msg: `delivery ${operation}: ${kind}` });
}


export function snapshot(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !("value" in descriptors[key]))) return;
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

export function utf8(value, limit, empty = false) {
  return typeof value === "string" && (empty || value.length > 0) && value.length <= limit &&
    new TextEncoder().encode(value).length <= limit &&
    new TextDecoder().decode(new TextEncoder().encode(value)) === value;
}

export function text(value, limit) {
  return utf8(value, limit) && !/[\u0000-\u001f\u007f]/.test(value);
}

export function decimal(value, positive = false) {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n && (!positive || value !== "0");
}
export const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const time = (value, positive = false) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
export const keys = (value, allowed) => value !== undefined && Object.keys(value).every(key => allowed.includes(key));

