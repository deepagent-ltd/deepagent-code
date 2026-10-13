export * as AttachmentPreview from "./attachment-preview"

export const maxBytes = 10 * 1024 * 1024
// Decode previously published metadata without restoring its former upload allowance.
export const legacyMaxBytes = 50 * 1024 * 1024
export const previewBytes = 8 * 1024 * 1024
export const maxPixels = 40_000_000
export const maxDimension = 8192

// Shared by browser and terminal clients; no decoder, filesystem or native dependency.
export function mime(bytes: Uint8Array) {
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return "image/png"
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "image/gif"
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp"
  return "application/octet-stream"
}

export function inspect(bytes: Uint8Array) {
  if (bytes.length > previewBytes) return
  const format = mime(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (format === "image/png") {
    if (bytes.length < 45 || view.getUint32(8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") return
    const dimensions = size(view.getUint32(16), view.getUint32(20))
    if (!dimensions) return
    const depths: Record<number, number[]> = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16],
    }
    if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return
    let offset = 8
    let data = false
    for (let count = 0; count < 4096 && offset + 12 <= bytes.length; count++) {
      const length = view.getUint32(offset)
      const end = offset + length + 12
      if (end > bytes.length) return
      const type = ascii(bytes, offset + 4, 4)
      if (["acTL", "fcTL", "fdAT"].includes(type) || (type === "IHDR" && offset !== 8)) return
      if (type === "IDAT") data = true
      if (type === "IEND")
        return length === 0 && end === bytes.length && data ? { mime: format, ...dimensions } : undefined
      offset = end
    }
    return
  }
  if (format !== "image/jpeg") return
  let offset = 2
  let dimensions: ReturnType<typeof size>
  let scan = false
  let markers = 0
  while (offset < bytes.length && markers < 4096) {
    if (bytes[offset++] !== 255) {
      if (scan) continue
      return
    }
    while (bytes[offset] === 255) offset++
    if (offset >= bytes.length) return
    const marker = bytes[offset++]
    if (scan && (marker === 0 || (marker >= 208 && marker <= 215))) continue
    markers++
    if (marker === 217)
      return scan && dimensions && offset === bytes.length ? { mime: format, ...dimensions } : undefined
    if (marker === 216 || marker === 220 || offset + 2 > bytes.length) return
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.length) return
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      // One baseline/progressive frame. DNL, hierarchical and lossless variants are download-only.
      if (dimensions || ![192, 194].includes(marker) || length < 8 || bytes[offset + 2] !== 8) return
      dimensions = size(view.getUint16(offset + 5), view.getUint16(offset + 3))
      if (!dimensions || ![1, 3, 4].includes(bytes[offset + 7]) || length !== 8 + 3 * bytes[offset + 7]) return
    }
    if (marker === 218) {
      if (!dimensions || length < 6) return
      scan = true
    }
    offset += length
  }
}

function size(width: number, height: number) {
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension || width * height > maxPixels) return
  return { width, height }
}

function ascii(bytes: Uint8Array, offset: number, count: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + count))
}

export function displayName(value: string) {
  return Array.from(value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "�"))
    .slice(0, 255)
    .join("")
}
