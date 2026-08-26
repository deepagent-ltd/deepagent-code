import { For, type ComponentProps } from "solid-js"

const CELL = 8
const GAP = 2
const LETTER_GAP = 7
const SPACE_WIDTH = 4

const GLYPHS: Record<string, readonly string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
}

const WORDMARK = "DEEP AGENT CODE"
const GLYPH_WIDTH = 5 * CELL + 4 * GAP
const SPACE_ADVANCE = SPACE_WIDTH * (CELL + GAP)
const WORDMARK_HEIGHT = 7 * CELL + 6 * GAP

function widthOf(char: string) {
  if (char === " ") return SPACE_ADVANCE
  return GLYPH_WIDTH
}

function xOffset(index: number) {
  return [...WORDMARK].slice(0, index).reduce((offset, char) => offset + widthOf(char) + LETTER_GAP, 0)
}

const CELLS = [...WORDMARK].flatMap((char, charIndex) => {
  const glyph = GLYPHS[char]
  if (!glyph) return []
  return glyph.flatMap((row, y) =>
    [...row].flatMap((bit, x) =>
      bit === "1" ? [{ x: xOffset(charIndex) + x * (CELL + GAP), y: y * (CELL + GAP) }] : [],
    ),
  )
})

const WIDTH = [...WORDMARK].reduce(
  (width, char, index) => width + widthOf(char) + (index === WORDMARK.length - 1 ? 0 : LETTER_GAP),
  0,
)
const VIEWBOX_HEIGHT = 129
const Y_OFFSET = (VIEWBOX_HEIGHT - WORDMARK_HEIGHT) / 2

export function PixelWordmark(props: Pick<ComponentProps<"svg">, "class"> & { opacity?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${WIDTH} ${VIEWBOX_HEIGHT}`}
      fill="none"
      preserveAspectRatio="xMidYMid meet"
      classList={{ [props.class ?? ""]: !!props.class }}
      role="img"
      aria-label="Deep Agent Code"
    >
      <g transform={`translate(0 ${Y_OFFSET})`}>
        <For each={CELLS}>
          {(cell) => (
            <rect
              x={cell.x}
              y={cell.y}
              width={CELL}
              height={CELL}
              rx="1"
              fill="currentColor"
              fill-opacity={props.opacity ?? 1}
            />
          )}
        </For>
      </g>
    </svg>
  )
}
