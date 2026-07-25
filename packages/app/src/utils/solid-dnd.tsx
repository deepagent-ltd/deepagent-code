import { useDragDropContext } from "@thisbeyond/solid-dnd"
import type { Id, Transformer } from "@thisbeyond/solid-dnd"
import { createRoot, onCleanup, onMount, type JSXElement } from "solid-js"

type DragEvent = { draggable?: { id?: unknown } }

const isDragEvent = (event: unknown): event is DragEvent => {
  if (typeof event !== "object" || event === null) return false
  return "draggable" in event
}

export const getDraggableId = (event: unknown): string | undefined => {
  if (!isDragEvent(event)) return undefined
  const draggable = event.draggable
  if (!draggable) return undefined
  return typeof draggable.id === "string" ? draggable.id : undefined
}

const createTransformer = (id: string, axis: "x" | "y"): Transformer => ({
  id,
  order: 100,
  callback: (transform) => (axis === "x" ? { ...transform, x: 0 } : { ...transform, y: 0 }),
})

const createAxisConstraint = (axis: "x" | "y", transformerId: string) => (): JSXElement => {
  const context = useDragDropContext()
  if (!context) return null
  const [, { onDragStart, onDragEnd, addTransformer, removeTransformer }] = context
  const transformer = createTransformer(transformerId, axis)
  const dispose = createRoot((dispose) => {
    onDragStart((event) => {
      const id = getDraggableId(event)
      if (!id) return
      addTransformer("draggables", id, transformer)
    })
    onDragEnd((event) => {
      const id = getDraggableId(event)
      if (!id) return
      removeTransformer("draggables", id, transformer.id)
    })
    return dispose
  })
  onCleanup(dispose)
  return null
}

export const ConstrainDragXAxis = createAxisConstraint("x", "constrain-x-axis")

export const ConstrainDragYAxis = createAxisConstraint("y", "constrain-y-axis")

// ---------------------------------------------------------------------------
// FixedDragDropSensors — patches solid-dnd 0.7.5 pointer sensor bug.
//
// Bug: createPointerSensor's onCleanup only calls removeSensor(), never
// detach(). This leaves document-level pointermove/pointerup listeners
// orphaned after every DragDropSensors remount. Orphaned onPointerMove
// handlers call event.preventDefault(), swallowing all subsequent pointer
// events and making the UI unresponsive after ~2 project switches.
//
// Fix: reimplement createPointerSensor locally so that onCleanup calls
// detach() BEFORE removeSensor(), and add a pointercancel handler that
// solid-dnd omits entirely.
// ---------------------------------------------------------------------------

function createFixedPointerSensor(id = "pointer-sensor") {
  const ctx = useDragDropContext()
  if (!ctx) return

  const [state, { addSensor, removeSensor, sensorStart, sensorMove, sensorEnd, dragStart, dragEnd }] = ctx

  const activationDelay = 250
  const activationDistance = 10

  const initialCoordinates = { x: 0, y: 0 }
  let activationDelayTimeoutId: number | null = null
  let activationDraggableId: string | number | null = null

  const isActiveSensor = () => state.active.sensorId === id

  const clearSelection = () => window.getSelection()?.removeAllRanges()

  const detach = () => {
    if (activationDelayTimeoutId !== null) {
      clearTimeout(activationDelayTimeoutId)
      activationDelayTimeoutId = null
    }
    document.removeEventListener("pointermove", onPointerMove)
    document.removeEventListener("pointerup", onPointerUp)
    document.removeEventListener("pointercancel", onPointerCancel)
    document.removeEventListener("selectionchange", clearSelection)
  }

  const onActivate = () => {
    if (!state.active.sensor) {
      sensorStart(id, initialCoordinates)
      dragStart(activationDraggableId!)
      clearSelection()
      document.addEventListener("selectionchange", clearSelection)
    } else if (!isActiveSensor()) {
      detach()
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    const coordinates = { x: event.clientX, y: event.clientY }
    if (!state.active.sensor) {
      const dx = coordinates.x - initialCoordinates.x
      const dy = coordinates.y - initialCoordinates.y
      if (Math.sqrt(dx * dx + dy * dy) > activationDistance) onActivate()
    }
    if (isActiveSensor()) {
      event.preventDefault()
      sensorMove(coordinates)
    }
  }

  const onPointerUp = (event: PointerEvent) => {
    detach()
    if (isActiveSensor()) {
      event.preventDefault()
      dragEnd()
      sensorEnd()
    }
  }

  // solid-dnd omits this entirely — pointercancel fires when the OS/browser
  // cancels the gesture (scroll-lock, focus loss, navigation). Without it
  // the sensor stays "half-attached" indefinitely.
  const onPointerCancel = () => {
    detach()
    if (isActiveSensor()) {
      dragEnd()
      sensorEnd()
    }
  }

  const attach = (event: PointerEvent, draggableId: Id) => {
    if (event.button !== 0) return
    document.addEventListener("pointermove", onPointerMove)
    document.addEventListener("pointerup", onPointerUp)
    document.addEventListener("pointercancel", onPointerCancel)
    activationDraggableId = draggableId
    initialCoordinates.x = event.clientX
    initialCoordinates.y = event.clientY
    activationDelayTimeoutId = window.setTimeout(onActivate, activationDelay)
  }

  onMount(() => {
    addSensor({ id, activators: { pointerdown: attach } })
  })

  onCleanup(() => {
    // THE FIX: call detach() before removeSensor() so document listeners are
    // always cleaned up, even if the component unmounts mid-gesture.
    detach()
    removeSensor(id)
  })
}

/**
 * Drop-in replacement for solid-dnd's DragDropSensors that fixes the pointer
 * sensor's missing detach() call in onCleanup and adds pointercancel support.
 */
export const FixedDragDropSensors = (props: { children?: JSXElement }): JSXElement => {
  createFixedPointerSensor()
  return props.children as JSXElement
}
