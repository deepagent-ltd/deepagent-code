/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { TextareaRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { createInteractiveSubmitGate } from "../../src/prompt/interactive-submit"

test("only the current real terminal event can supply one frozen composer origin", async () => {
  const gate = createInteractiveSubmitGate<{ sourceGeneration: string; barrierOrder: number }>()
  const submitted: Array<ReturnType<typeof gate.take>> = []
  const state = { sourceGeneration: "original-stream", barrierOrder: 2 }
  const refs: { input?: TextareaRenderable; command?: () => void } = {}
  function Harness() {
    const keymap = createDefaultOpenTuiKeymap(useRenderer())
    const offKeys = keymap.intercept("key", (event) => gate.begin(event.event, Object.freeze({ ...state })))
    const offCommands = keymap.registerLayer({
      commands: [
        {
          name: "composer.send",
          run: (event) => {
            submitted.push(gate.take(event.event))
          },
        },
      ],
      bindings: [{ key: "ctrl+return", cmd: "composer.send" }],
    })
    refs.command = () => {
      keymap.dispatchCommand("composer.send")
    }
    onCleanup(() => {
      gate.clear()
      offCommands()
      offKeys()
    })
    return (
      <textarea
        ref={(input: TextareaRenderable) => {
          refs.input = input
          input.focus()
        }}
        keyBindings={[{ name: "return", action: "submit" }]}
        onSubmit={() => {
          submitted.push(gate.take())
          submitted.push(gate.take())
        }}
      />
    )
  }
  const app = await testRender(() => <Harness />)
  try {
    refs.command!()
    expect(submitted).toEqual([undefined])
    submitted.length = 0
    await app.mockInput.pressKey("RETURN")
    expect(submitted).toEqual([{ sourceGeneration: "original-stream", barrierOrder: 2 }, undefined])
    expect(Object.isFrozen(submitted[0])).toBe(true)
    state.barrierOrder = 3
    expect(submitted[0]?.barrierOrder).toBe(2)
    expect(gate.take()).toBeUndefined()
    refs.input!.submit()
    expect(submitted.slice(-2)).toEqual([undefined, undefined])
    submitted.length = 0
    await app.mockInput.pressKey("RETURN", { ctrl: true })
    expect(submitted).toEqual([{ sourceGeneration: "original-stream", barrierOrder: 3 }])
    refs.command!()
    expect(submitted.at(-1)).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
