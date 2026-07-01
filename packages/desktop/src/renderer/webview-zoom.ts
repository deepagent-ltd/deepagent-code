// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import { createSignal } from "solid-js"
import { clampZoom, nextZoomLevel } from "@deepagent-code/app/zoom-levels"

const OS_NAME = (() => {
  if (navigator.userAgent.includes("Mac")) return "macos"
  if (navigator.userAgent.includes("Windows")) return "windows"
  if (navigator.userAgent.includes("Linux")) return "linux"
  return "unknown"
})()

const [webviewZoom, setWebviewZoom] = createSignal(1)
let requestedZoom = 1
let pinchZoomEnabled = false
let wheelPinch = undefined as
  | {
      active: boolean
      startZoom: number
      totalDelta: number
      timeout: ReturnType<typeof setTimeout> | undefined
    }
  | undefined

const WHEEL_PINCH_THRESHOLD = 20
const WHEEL_PINCH_END_DELAY = 160

const applyZoom = (next: number) => {
  requestedZoom = next
  void window.api
    .setZoomFactor(next)
    .then(() => {
      if (requestedZoom !== next) return
      setWebviewZoom(next)
    })
    .catch(() => {
      if (requestedZoom !== next) return
      requestedZoom = webviewZoom()
    })
}

window.api.onZoomFactorChanged((factor) => {
  requestedZoom = clampZoom(factor)
  setWebviewZoom(requestedZoom)
})

void window.api.getPinchZoomEnabled().then((enabled) => {
  pinchZoomEnabled = enabled
})

window.api.onPinchZoomEnabledChanged((enabled) => {
  pinchZoomEnabled = enabled
  resetWheelPinch()
})

const setPinchZoomEnabled = (enabled: boolean) => {
  pinchZoomEnabled = enabled
  resetWheelPinch()
  return window.api.setPinchZoomEnabled(enabled)
}

const resetZoom = () => applyZoom(1)
const zoomIn = () => applyZoom(nextZoomLevel(requestedZoom, "in"))
const zoomOut = () => applyZoom(nextZoomLevel(requestedZoom, "out"))
const setZoom = (level: number) => applyZoom(clampZoom(level))

const resetWheelPinch = () => {
  clearTimeout(wheelPinch?.timeout)
  wheelPinch = undefined
}

const normalizeWheelDelta = (event: WheelEvent) => {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * window.innerHeight
  return event.deltaY
}

const updateWheelPinch = (event: WheelEvent) => {
  wheelPinch ??= {
    active: false,
    startZoom: requestedZoom,
    totalDelta: 0,
    timeout: undefined,
  }

  clearTimeout(wheelPinch.timeout)
  wheelPinch.timeout = setTimeout(resetWheelPinch, WHEEL_PINCH_END_DELAY)
  wheelPinch.totalDelta += normalizeWheelDelta(event)

  if (!wheelPinch.active && Math.abs(wheelPinch.totalDelta) < WHEEL_PINCH_THRESHOLD) return
  if (!wheelPinch.active) {
    wheelPinch.active = true
    wheelPinch.startZoom = requestedZoom
    wheelPinch.totalDelta = 0
    return
  }

  wheelPinch.active = true
  const direction = wheelPinch.totalDelta > 0 ? "out" : "in"
  const target = nextZoomLevel(requestedZoom, direction)
  if (target !== requestedZoom) {
    applyZoom(target)
    wheelPinch.totalDelta = 0
    wheelPinch.startZoom = target
  }
}

window.addEventListener(
  "wheel",
  (event) => {
    if (!pinchZoomEnabled) return
    if (!event.ctrlKey) return

    event.preventDefault()
    updateWheelPinch(event)
  },
  { passive: false },
)

window.addEventListener("keydown", (event) => {
  if (!(OS_NAME === "macos" ? event.metaKey : event.ctrlKey)) return

  if (event.key === "-") {
    event.preventDefault()
    zoomOut()
    return
  }
  if (event.key === "=" || event.key === "+") {
    event.preventDefault()
    zoomIn()
    return
  }
  if (event.key === "0") {
    event.preventDefault()
    resetZoom()
  }
})

export { webviewZoom, resetZoom, setPinchZoomEnabled, setZoom, zoomIn, zoomOut }
