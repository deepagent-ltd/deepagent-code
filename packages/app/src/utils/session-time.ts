// Contextual timestamp for the sidebar session rows.
//   - same calendar day        -> HH:MM        (just the clock time)
//   - within the last 6 days    -> weekday      (e.g. "周三" / "Wed")
//   - 7+ calendar days ago      -> MM-DD        (fall back to a date)
// The boundary is measured in CALENDAR days (not raw 24h spans) so "last Thursday" still reads as a
// weekday while the same weekday a week earlier reads as a date — matching the user's spec.

// Whole-day difference between two dates, ignoring the time-of-day component.
function calendarDayDiff(now: Date, then: Date): number {
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const b = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate())
  return Math.round((a - b) / 86_400_000)
}

export function formatSessionTime(input: number | string | Date, locale: string, now: Date = new Date()): string {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return ""

  const diffDays = calendarDayDiff(now, date)

  // Future or today -> clock time.
  if (diffDays <= 0) {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
  }
  // Yesterday .. 6 days ago -> weekday.
  if (diffDays < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date)
  }
  // A week or more ago -> month-day.
  return new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit" }).format(date)
}
