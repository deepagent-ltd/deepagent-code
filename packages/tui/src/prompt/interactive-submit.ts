/** One synchronous terminal event may authorize one composer submission. Command palette,
 * plugin/ref.submit and startup sends do not gain provenance from a previously seen key. */
export function createInteractiveSubmitGate<Value>() {
  const state: { event?: object; value?: Value; consumed: boolean } = { consumed: false }
  return {
    begin(event: object, value: Value | undefined) {
      state.event = event
      state.value = value
      state.consumed = false
      queueMicrotask(() => {
        if (state.event !== event) return
        state.event = undefined
        state.value = undefined
      })
    },
    take(event?: object) {
      if (!state.event || (event !== undefined && event !== state.event) || state.consumed) return undefined
      state.consumed = true
      return state.value
    },
    clear() {
      state.event = undefined
      state.value = undefined
      state.consumed = true
    },
  }
}
