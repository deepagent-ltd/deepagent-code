/**
 * A `503` with an empty body is not an application error — it is Effect's
 * `serverAbortError` (`Response.empty({ status: 503 })`), emitted when a request
 * handler fiber is interrupted *server-side* (client aborts become `499`,
 * handler failures become `500` with a body). For PTY create this happens when
 * the per-directory location scope is torn down under the handler by a
 * concurrent instance dispose/reload — common right after connect while the
 * instance is still booting. It is transient: retrying almost always succeeds.
 *
 * The SDK error interceptor wraps such responses as `Error` with
 * `cause: { body, status }` (see sdk/js/src/error-interceptor.ts), so we detect
 * the shape from `cause` rather than the (deliberately opaque) message.
 */
export function isTransientServerAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = error.cause
  if (!cause || typeof cause !== "object") return false
  if ((cause as { status?: unknown }).status !== 503) return false
  const body = (cause as { body?: unknown }).body
  if (body === undefined || body === null || body === "") return true
  // Empty parsed object — the interceptor's fallback for a bodyless response.
  return typeof body === "object" && Object.keys(body as object).length === 0
}

/**
 * Run `op`, retrying only on a transient server-abort `503`. Any other error
 * (real failure, client abort, typed 4xx/5xx with a body) rethrows immediately.
 * Backoff is linear (`delayMs * attempt`) to give the booting instance a beat
 * to settle without hammering the socket.
 */
export async function withServerAbortRetry<T>(
  op: () => Promise<T>,
  opts?: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const retries = opts?.retries ?? 3
  const delayMs = opts?.delayMs ?? 150
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let attempt = 0
  while (true) {
    try {
      return await op()
    } catch (error) {
      if (attempt >= retries || !isTransientServerAbort(error)) throw error
      attempt += 1
      await sleep(delayMs * attempt)
    }
  }
}
