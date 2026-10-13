/** Read-only viewport for the fixed ASCII PTY performance probes. It consumes cursor
 * updates and synchronized frame ends; removing ANSI escapes loses incremental text.
 * This is not a terminal implementation or a full visual/Unicode acceptance oracle. */
export function createPerformanceViewport(columns: number, rows: number) {
  const screen = Array.from({ length: rows }, () => Array.from({ length: columns }, () => " "))
  const state = { x: 0, y: 0, savedX: 0, savedY: 0, pending: "", frames: 0 }
  function reset() {
    screen.forEach((row) => row.fill(" "))
    state.x = 0; state.y = 0
  }
  function push(text: string) {
    state.pending += text
    const cursor = { index: 0 }
    while (cursor.index < state.pending.length) {
      const character = state.pending[cursor.index]!
      if (character === "\x1b") {
        const kind = state.pending[cursor.index + 1]
        if (!kind) break
        if (kind === "[") {
          const suffix = state.pending.slice(cursor.index + 2)
          const end = suffix.search(/[@-~]/)
          if (end < 0) break
          const argumentsText = suffix.slice(0, end)
          const final = suffix[end]!
          const values = argumentsText.split(";").map((part) => Number(part) || 0)
          if ((final === "H" || final === "f") && !argumentsText.startsWith("?")) {
            state.y = Math.min(rows - 1, Math.max(0, (values[0] || 1) - 1))
            state.x = Math.min(columns - 1, Math.max(0, (values[1] || 1) - 1))
          }
          if (final === "A") state.y = Math.max(0, state.y - (values[0] || 1))
          if (final === "B") state.y = Math.min(rows - 1, state.y + (values[0] || 1))
          if (final === "C") state.x = Math.min(columns - 1, state.x + (values[0] || 1))
          if (final === "D") state.x = Math.max(0, state.x - (values[0] || 1))
          if (final === "G") state.x = Math.min(columns - 1, Math.max(0, (values[0] || 1) - 1))
          if (final === "s") { state.savedX = state.x; state.savedY = state.y }
          if (final === "u" && !argumentsText) { state.x = state.savedX; state.y = state.savedY }
          if (final === "K") screen[state.y]!.fill(" ", values[0] === 0 ? state.x : 0, values[0] === 1 ? state.x + 1 : columns)
          if (final === "J") {
            if (values[0] === 2 || values[0] === 3) screen.forEach((row) => row.fill(" "))
            if (values[0] === 0) { screen[state.y]!.fill(" ", state.x); screen.slice(state.y + 1).forEach((row) => row.fill(" ")) }
            if (values[0] === 1) { screen[state.y]!.fill(" ", 0, state.x + 1); screen.slice(0, state.y).forEach((row) => row.fill(" ")) }
          }
          if (argumentsText === "?1049" && final === "h") reset()
          if (argumentsText === "?2026" && final === "l") state.frames++
          cursor.index += end + 3
          continue
        }
        if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
          const suffix = state.pending.slice(cursor.index + 2)
          const end = suffix.search(/\x07|\x1b\\/)
          if (end < 0) break
          cursor.index += end + 2 + (suffix[end] === "\x07" ? 1 : 2)
          continue
        }
        if (kind === "7") { state.savedX = state.x; state.savedY = state.y }
        if (kind === "8") { state.x = state.savedX; state.y = state.savedY }
        cursor.index += 2
        continue
      }
      if (character === "\r") state.x = 0
      if (character === "\n") state.y = Math.min(rows - 1, state.y + 1)
      if (character === "\b") state.x = Math.max(0, state.x - 1)
      if (character === "\t") state.x = Math.min(columns - 1, (Math.floor(state.x / 8) + 1) * 8)
      if (character >= " " && character !== "\x7f") {
        screen[state.y]![state.x] = character
        state.x++
        if (state.x >= columns) { state.x = 0; state.y = Math.min(rows - 1, state.y + 1) }
      }
      cursor.index++
    }
    state.pending = state.pending.slice(cursor.index)
  }
  return { push, text: () => screen.map((row) => row.join("")).join("\n"), frames: () => state.frames }
}
