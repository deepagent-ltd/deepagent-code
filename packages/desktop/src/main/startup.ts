import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { App } from "electron"
import { resolveDataPath } from "@deepagent-code/core/global-path"
import { CHANNEL } from "./constants"
import { desktopStoragePaths } from "./storage-path"

const names = { dev: "DeepAgent Code Dev", beta: "DeepAgent Code Beta", prod: "DeepAgent Code" }
const ids = { dev: "ai.deepagent-code.desktop.dev", beta: "ai.deepagent-code.desktop.beta", prod: "ai.deepagent-code.desktop" }
const initialized = new WeakMap<App, ReturnType<typeof initialize>>()

export function initializeDesktopStartup(app: App) {
  const current = initialized.get(app)
  if (current) return current
  const startup = initialize(app)
  initialized.set(app, startup)
  return startup
}

function initialize(app: App) {
  const appID = app.isPackaged ? ids[CHANNEL] : ids.dev
  const name = app.isPackaged ? names[CHANNEL] : names.dev
  const onboardingTestRoot = process.env.DEEPAGENT_CODE_TEST_ONBOARDING === "1"
    ? process.env.DEEPAGENT_CODE_TEST_ROOT ?? join(resolveDataPath(), "tmp", `deepagent-code-onboarding-${randomUUID()}`)
    : undefined
  if (onboardingTestRoot) {
    if (!process.env.DEEPAGENT_CODE_TEST_ROOT) rmSync(onboardingTestRoot, { recursive: true, force: true })
    process.env.DEEPAGENT_CODE_TEST_HOME = onboardingTestRoot
    delete process.env.DEEPAGENT_CODE_HOME
    process.env.DEEPAGENT_CODE_DB ??= ":memory:"
  }
  if (!onboardingTestRoot) delete process.env.DEEPAGENT_CODE_TEST_HOME
  const dataRoot = resolveDataPath(process.env)
  return { appID, name, onboardingTestRoot, dataRoot, storage: prepareDesktopStorage({ app, dataRoot, appID, name }) }
}

export function prepareDesktopStorage(input: { app: App; dataRoot: string; appID: string; name: string }) {
  if (input.app.isReady()) throw new Error("Desktop storage must initialize before Electron is ready")
  const storage = desktopStoragePaths(input.dataRoot, input.appID)
  ;[
    input.dataRoot, join(input.dataRoot, "tmp"), storage.root, storage.session, storage.cache,
    storage.updater, storage.logs, storage.tmp,
  ].forEach((directory) => mkdirSync(directory, { recursive: true }))
  input.app.setName(input.name)
  input.app.setAppUserModelId(input.appID)
  input.app.setPath("userData", storage.root)
  input.app.setPath("sessionData", storage.session)
  input.app.setPath("cache", storage.cache)
  input.app.setPath("logs", storage.logs)
  input.app.setPath("temp", storage.tmp)
  return storage
}
