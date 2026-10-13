import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { initializeDesktopStartup } from "../startup"

const startup = initializeDesktopStartup(app)
writeFileSync(join(process.env.DAC_STARTUP_ROOT!, "entry.json"), JSON.stringify({ ready: app.isReady(), session: app.getPath("sessionData"), expected: startup.storage.session }), { mode: 0o600 })
await import("./startup")
