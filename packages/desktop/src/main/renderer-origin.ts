export function rendererOrigin(value: string | undefined) {
  if (!value || !URL.canParse(value)) return
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return
  return url.origin
}
