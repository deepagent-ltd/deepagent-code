type DurationKey =
  | "ui.message.duration.seconds"
  | "ui.message.duration.minutesSeconds"
  | "ui.message.duration.hoursMinutes"

type Translate = (key: DurationKey, params?: Record<string, string | number>) => string

// Format an elapsed duration (milliseconds) into a compact, locale-formatted string. Mirrors codex's
// `fmt_elapsed_compact` bucketing (s / m s / h m) so the live top-left timer and any completed
// duration read the same way. `format` handles locale-aware number grouping.
export function formatDuration(ms: number, t: Translate, format: (n: number) => string): string {
  if (!(ms >= 0)) return ""
  const total = Math.round(ms / 1000)
  if (total < 60) return t("ui.message.duration.seconds", { count: format(total) })
  if (total < 3600) {
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return t("ui.message.duration.minutesSeconds", {
      minutes: format(minutes),
      seconds: format(seconds),
    })
  }
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return t("ui.message.duration.hoursMinutes", {
    hours: format(hours),
    minutes: format(minutes),
  })
}
