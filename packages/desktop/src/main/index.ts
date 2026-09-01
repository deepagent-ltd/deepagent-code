import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"
import { resolveDataPath } from "@deepagent-code/core/global-path"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData, WslServersState } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import {
  firstReadyWslServer,
  isSidecarSpawnFailure,
  resolveWslSidecarMode,
  sidecarSpawnFailure,
  type WslServerReady,
  type WslSidecarMode,
} from "./sidecar-routing"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import {
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
  setCloseToTrayEnabled,
  setIsQuitting,
} from "./windows"
import { createWslServersController, type WslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { initPowerSaveBlocker, stopPowerSaveBlocker } from "./power"
import { desktopStoragePaths } from "./storage-path"
import { createTray, destroyTray } from "./tray"

const APP_NAMES: Record<string, string> = {
  dev: "DeepAgent Code Dev",
  beta: "DeepAgent Code Beta",
  prod: "DeepAgent Code",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.deepagent-code.desktop.dev",
  beta: "ai.deepagent-code.desktop.beta",
  prod: "ai.deepagent-code.desktop",
}
const TEST_ONBOARDING = process.env.DEEPAGENT_CODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.DEEPAGENT_CODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.deepagent-code.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = process.env.DEEPAGENT_CODE_TEST_ROOT ?? join(tmpdir(), `deepagent-code-onboarding-${randomUUID()}`)
    if (!process.env.DEEPAGENT_CODE_TEST_ROOT) rmSync(root, { recursive: true, force: true })
    process.env.DEEPAGENT_CODE_TEST_HOME = root
    delete process.env.DEEPAGENT_CODE_HOME
    process.env.DEEPAGENT_CODE_DB ??= ":memory:"
    return root
  })()
  if (!onboardingTestRoot) delete process.env.DEEPAGENT_CODE_TEST_HOME
  const dataRoot = resolveDataPath(process.env)
  const storage = desktopStoragePaths(dataRoot, appId)
  ;[
    dataRoot,
    join(dataRoot, "tmp"),
    storage.root,
    storage.session,
    storage.cache,
    storage.updater,
    storage.logs,
    storage.tmp,
  ].forEach((dir) => mkdirSync(dir, { recursive: true }))
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "DeepAgent Code Dev")
  app.setAppUserModelId(appId)
  app.setPath("userData", storage.root)
  app.setPath("sessionData", storage.session)
  app.setPath("cache", storage.cache)
  app.setPath("logs", storage.logs)
  app.setPath("temp", storage.tmp)
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    void stopSidecars().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  // The remote debugging port is OPT-IN (DEEPAGENT_CODE_DEBUG_PORT). Always-on 9222 in dev let any
  // CDP client (DevTools frontend, IDE inspector) attach and emit protocol noise into the app log —
  // Autofill.enable/setAddresses -32601 (Electron does not implement the Autofill domain) and stale
  // DOM "Node cannot be found" resolutions. Pass --remote-debugging-port explicitly to override.
  const debugPort = process.env.DEEPAGENT_CODE_DEBUG_PORT
  if (!app.isPackaged && !app.commandLine.hasSwitch("remote-debugging-port") && debugPort) {
    app.commandLine.appendSwitch("remote-debugging-port", debugPort)
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(dataRoot)

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("deepagent-code://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    setIsQuitting(true)
    void stopSidecars()
  })

  app.on("will-quit", () => {
    void stopSidecars()
    stopPowerSaveBlocker()
    destroyTray()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  // macOS: re-show the window when the user clicks the Dock icon after it was hidden to the tray.
  // Also serves as a recovery path on any platform if the window is hidden without a visible tray.
  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopSidecars().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  app.setAsDefaultProtocolClient("deepagent-code")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars, storage.updater)
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: (options) => exportDebugLogs({ ...options, pick: options?.pick ?? true }),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
  })
  registerWslIpcHandlers(wslServers)

  mainWindow = createMainWindow()
  if (mainWindow) {
    createMenu({
      trigger: (id) => {
        const win = BrowserWindow.getFocusedWindow() ?? mainWindow
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void showUpdaterDialog(updater, true)
      },
      relaunch: () => {
        relaunch()
      },
    })
  }

  // Keep the app running (prevent idle sleep/hibernate) while it is active, unless the user opted
  // out in settings. The tray icon enables
  // close-to-tray: closing the window hides it to the tray with a right-click “Quit” to fully exit.
  // On platforms without tray support (e.g. Linux GNOME default), tray creation fails silently and
  // close-to-tray stays disabled so closing the window quits normally — avoiding a stranded window.
  initPowerSaveBlocker()
  const trayCreated = createTray(() => mainWindow)
  setCloseToTrayEnabled(trayCreated)

  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.DEEPAGENT_CODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    const connection = yield* Effect.promise(() =>
      startPrimarySidecar({
        platform: process.platform,
        mode: process.platform === "win32" ? resolveWslSidecarMode() : "native",
        hostname,
        port,
        password,
        wslServers,
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
        onPlatformFallback: (reason) => {
          logger.log("sidecar_platform_fallback", { mode: "auto", reason })
        },
      }),
    )
    server = connection.listener

    // Windows keeps the managed WSL server list available next to the local
    // sidecar. A WSL fallback already ran initialize() while routing, so only
    // the local-first path re-triggers it.
    if (process.platform === "win32" && !connection.wslFallback) {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    // Wait for the sidecar to be ready for API requests before delivering credentials
    // to the renderer. Listener-ready ≠ API-ready; delivering credentials too early
    // causes the renderer to race against an uninitialized sidecar, which can result
    // in failed bootstrap requests and a "local server disconnected" splash.
    // Timeout is 15 s (down from the old 30 s). On failure we log and continue.
    yield* Effect.promise(() => connection.health).pipe(
      Effect.timeout("15 seconds"),
      Effect.tapError((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
      Effect.ignore,
    )

    yield* Deferred.succeed(serverReady, connection.ready)

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)
})

type SidecarConnection = {
  listener: SidecarListener | null
  ready: ServerReadyData
  health: Promise<void>
  wslFallback: boolean
}

// Budget for a WSL fallback: WSL2 distro boot plus a fresh `deepagent-code serve`
// start. Each spawnWslSidecar already polls its own health (30s default) inside
// that budget, so a ready WSL server typically resolves far sooner.
const WSL_FALLBACK_TIMEOUT_MS = 120_000

async function startPrimarySidecar(options: {
  platform: NodeJS.Platform
  mode: WslSidecarMode
  hostname: string
  port: number
  password: string
  wslServers: WslServersController
  onStdout: (message: string) => void
  onStderr: (message: string) => void
  onExit: (code: number) => void
  onPlatformFallback: (reason: string) => void
}): Promise<SidecarConnection> {
  const spawnLocal = () =>
    spawnLocalServer(options.hostname, options.port, options.password, {
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      onExit: options.onExit,
    }).then(({ listener, health }) => ({
      listener,
      ready: {
        url: `http://${options.hostname}:${options.port}`,
        username: "deepagent-code",
        password: options.password,
      },
      health: health.wait,
      wslFallback: false,
    }))

  if (options.platform === "win32" && options.mode === "force") {
    return startWslPrimary(options.wslServers)
  }

  try {
    return await spawnLocal()
  } catch (error) {
    if (options.platform !== "win32" || options.mode !== "auto" || !isSidecarSpawnFailure(error)) throw error
    options.onPlatformFallback(error instanceof Error ? error.message : String(error))
    return startWslPrimary(options.wslServers).catch((fallbackError) => {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      const reason = error instanceof Error ? error.message : String(error)
      throw sidecarSpawnFailure(`local sidecar spawn failed (${reason}); WSL fallback failed (${fallbackMessage})`, error)
    })
  }
}

function startWslPrimary(wslServers: WslServersController): Promise<SidecarConnection> {
  return waitForWslServerReady(wslServers).then((ready) => ({
    listener: null,
    ready: {
      url: ready.url,
      username: ready.username,
      password: ready.password,
    },
    health: Promise.resolve(),
    wslFallback: true,
  }))
}

async function waitForWslServerReady(
  wslServers: WslServersController,
  options: { timeoutMs?: number } = {},
): Promise<WslServerReady> {
  const timeoutMs = options.timeoutMs ?? WSL_FALLBACK_TIMEOUT_MS
  return new Promise<WslServerReady>((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubscribe?.()
      action()
    }

    const inspect = (state: WslServersState) => {
      const ready = firstReadyWslServer(state.servers)
      if (ready) {
        settle(() => resolve(ready))
        return
      }
      if (state.servers.length === 0) {
        settle(() => reject(new Error("no WSL sidecar server is configured for fallback")))
        return
      }
      if (state.servers.every((item) => item.runtime.kind === "failed")) {
        settle(() => reject(new Error("every configured WSL sidecar failed to start")))
      }
    }

    unsubscribe = wslServers.subscribe((event) => inspect(event.state))
    timer = setTimeout(() => settle(() => reject(new Error(`WSL fallback timed out after ${timeoutMs}ms`))), timeoutMs)
    // initialize() runs refreshFromStore plus the per-server startServer loop
    // synchronously up to its first await, so the state read below already sees
    // the persisted servers marked starting and no transition can slip through.
    void wslServers.initialize().catch(() => undefined)
    inspect(wslServers.getState())
  })
}

Effect.runFork(main)
