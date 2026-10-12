import { app } from "electron"
import { initializeDesktopStartup } from "./startup"

// Keep this entry free of heavyweight ESM dependencies. Electron reads session prefs while
// loading the app, before the original Main's asynchronous migration can finish.
initializeDesktopStartup(app)
await import("./index")
