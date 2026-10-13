/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"

const state = { mounted: false }
function Probe() {
  const [ready, setReady] = createSignal(false)
  onMount(() => { state.mounted = true; setReady(true) })
  return <box><text>{ready() ? "Fixture mounted" : "Fixture pending"}</text></box>
}

const app = await testRender(() => <Probe />, { width: 40, height: 5 })
await app.renderOnce()
await Bun.sleep(0)
await app.renderOnce()
const frameVisible = app.captureCharFrame().includes("Fixture mounted")
app.renderer.destroy()
const transform = Reflect.get(globalThis, Symbol.for("opentui.solid.transform"))
console.log(JSON.stringify({ mounted: state.mounted, frameVisible, rendererDestroyed: app.renderer.isDestroyed,
  solidTransformInstalled: Boolean(transform && typeof transform === "object" && transform.installed === true),
  HTTP: false, PTY: false, prompt: false }))
