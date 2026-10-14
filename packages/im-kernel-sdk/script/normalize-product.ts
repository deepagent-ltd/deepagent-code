export function normalizeProduct(bytes: ArrayBuffer, output: string) {
  if (!output.endsWith(".js")) return bytes
  // The locked minifier preserves upstream comments; normalize their trailing
  // whitespace before both review hashing and installing the generated bundle.
  return new TextEncoder().encode(new TextDecoder().decode(bytes).replace(/[\t ]+$/gm, "")).buffer
}
