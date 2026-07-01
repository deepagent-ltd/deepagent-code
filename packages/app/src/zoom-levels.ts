export const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5] as const

export const MIN_ZOOM_LEVEL = ZOOM_LEVELS[0]
export const MAX_ZOOM_LEVEL = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]

const EPSILON = 1e-6

export function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL)
}

export function nextZoomLevel(current: number, direction: "in" | "out"): number {
  const clamped = clampZoom(current)
  if (direction === "in") {
    for (const level of ZOOM_LEVELS) {
      if (level > clamped + EPSILON) return level
    }
    return MAX_ZOOM_LEVEL
  }
  for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
    const level = ZOOM_LEVELS[i]
    if (level < clamped - EPSILON) return level
  }
  return MIN_ZOOM_LEVEL
}

export function canZoomIn(factor: number): boolean {
  return clampZoom(factor) < MAX_ZOOM_LEVEL - EPSILON
}

export function canZoomOut(factor: number): boolean {
  return clampZoom(factor) > MIN_ZOOM_LEVEL + EPSILON
}

export function zoomPercent(factor: number): number {
  return Math.round(clampZoom(factor) * 100)
}
