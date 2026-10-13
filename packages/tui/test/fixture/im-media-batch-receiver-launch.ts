// This attempted launcher is retained as failed preparation evidence: its dry
// run exited without output. The accepted entry is the TSX fixture run with
// Bun's explicit --preload argument for the physical production JSX plugin.
import "@opentui/solid/preload"

const descriptor = process.argv[2]
const output = process.argv[3]
const tuple = process.argv[4]
if (!descriptor || !output || !tuple) throw new Error("Actual descriptor, own output, and receiver tuple required")
const { IMMediaBatchReceiver } = await import("./im-media-batch-receiver")
if (process.argv[5] === "--dry") {
  const input = await IMMediaBatchReceiver.preflight(descriptor, tuple)
  console.log(JSON.stringify({ dry: true, originalPreload: true, rendererStarted: false, HTTP: false,
    files: input.tuple.receiver.attachments.length, currentGrant: false }))
}
if (process.argv[5] !== "--dry")
  await IMMediaBatchReceiver.run(descriptor, output, tuple).catch(() => {
    console.error("IM_TUI_PRODUCT_STAGE_FAILED; inspect original first frame and safe observations")
    process.exitCode = 1
  })
