import { Tracer } from "effect"

const active = new Map<string, { name: string; started: number; parent?: string }>()
const completed: { name: string; elapsedMs: number; endedAtMs: number }[] = []
const epoch = performance.now()

export const modelTracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options)
    active.set(span.spanId, {
      name: options.name,
      started: performance.now(),
      ...(options.parent._tag === "Some" ? { parent: options.parent.value.spanId } : {}),
    })
    const end = span.end.bind(span)
    span.end = (time, exit) => {
      const entry = active.get(span.spanId)
      if (entry)
        completed.push({
          name: entry.name,
          elapsedMs: Math.round(performance.now() - entry.started),
          endedAtMs: Math.round(performance.now() - epoch),
        })
      if (completed.length > 100) completed.shift()
      active.delete(span.spanId)
      end(time, exit)
    }
    return span
  },
})

export const activeModelSpans = () =>
  Array.from(active, ([id, span]) => ({
    id,
    name: span.name,
    parent: span.parent,
    elapsedMs: Math.round(performance.now() - span.started),
  }))
export const completedModelSpans = () => completed
