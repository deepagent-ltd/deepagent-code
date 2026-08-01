import { app, dialog, shell } from "electron"
import pkg from "electron-updater"
import type { AppAdapter } from "electron-updater/out/AppAdapter"
import { join } from "node:path"
import { UPDATER_ENABLED } from "./constants"
import { createUpdaterController, type UpdaterBackend, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"

const { MacUpdater, NsisUpdater } = pkg
const key = "ready"
const releaseURL = "https://api.github.com/repos/deepagent-ltd/deepagent-code/releases/latest"

export function setupAutoUpdater(stop: () => Promise<void>, updaterCache: string) {
  const logger = getLogger()
  const autoUpdater = process.platform === "linux" ? undefined : platformUpdater(updaterCache)
  if (autoUpdater) {
    autoUpdater.logger = logger
    autoUpdater.channel = "latest"
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    logger.log("auto updater configured", {
      channel: autoUpdater.channel,
      allowPrerelease: autoUpdater.allowPrerelease,
      allowDowngrade: autoUpdater.allowDowngrade,
      currentVersion: app.getVersion(),
      cache: updaterCache,
    })
  }

  const store = getStore("deepagent-code.updater")
  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend: autoUpdater ?? linuxDebUpdater(app.getVersion()),
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return {
          version: value.version,
          ...("manualUrl" in value && typeof value.manualUrl === "string" ? { manualUrl: value.manualUrl } : {}),
        } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    stop,
    log: (message, data) => logger.log(message, data),
  })
}

function platformUpdater(updaterCache: string) {
  const adapter = {
    get version() {
      return app.getVersion()
    },
    get name() {
      return app.getName()
    },
    get isPackaged() {
      return app.isPackaged === true
    },
    get appUpdateConfigPath() {
      return join(
        this.isPackaged ? process.resourcesPath : app.getAppPath(),
        this.isPackaged ? "app-update.yml" : "dev-app-update.yml",
      )
    },
    get userDataPath() {
      return app.getPath("userData")
    },
    get baseCachePath() {
      return updaterCache
    },
    whenReady: () => app.whenReady(),
    relaunch: () => app.relaunch(),
    quit: () => app.quit(),
    onQuit: (handler) => app.once("quit", (_event, exitCode) => handler(exitCode)),
  } satisfies AppAdapter

  if (process.platform === "darwin") return new MacUpdater(undefined, adapter)
  if (process.platform === "win32") return new NsisUpdater(undefined, adapter)
  throw new Error(`Unsupported auto-update platform: ${process.platform}`)
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "error", message: "Update check failed.", title: "Update Error" })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "info", message: "You're up to date.", title: "No Updates" })
    return
  }
  if (state.status !== "ready") return

  if (state.manualUrl) {
    const response = await dialog.showMessageBox({
      type: "info",
      message: `Update ${state.version} is available. Download the Linux .deb package?`,
      title: "Update Available",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response.response === 0) await controller.install()
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${state.version} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) await controller.install()
}

function linuxDebUpdater(currentVersion: string): UpdaterBackend {
  let manualUrl: string | undefined
  return {
    async checkForUpdates() {
      const response = await fetch(releaseURL, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": `DeepAgent-Code/${currentVersion}`,
        },
      })
      if (!response.ok) throw new Error(`GitHub release check failed: ${response.status}`)

      const release = (await response.json()) as {
        tag_name?: string
        assets?: { name?: string; browser_download_url?: string }[]
      }
      const version = releaseVersion(release.tag_name)
      const asset = release.assets?.find((item) => item.name?.endsWith(".deb") && item.browser_download_url)
      if (!version || !asset?.browser_download_url || compareVersion(version, currentVersion) <= 0) {
        manualUrl = undefined
        return { isUpdateAvailable: false, updateInfo: version ? { version } : undefined }
      }

      manualUrl = asset.browser_download_url
      return { isUpdateAvailable: true, updateInfo: { version, manualUrl } }
    },
    async downloadUpdate() {},
    quitAndInstall() {
      if (manualUrl) void shell.openExternal(manualUrl)
    },
  }
}

function releaseVersion(tag: string | undefined) {
  return /^app-v(\d+\.\d+\.\d+)(?:-|$)/.exec(tag ?? "")?.[1]
}

function compareVersion(a: string, b: string) {
  const left = a.split(".").map((item) => Number.parseInt(item, 10))
  const right = b.replace(/-.*/, "").split(".").map((item) => Number.parseInt(item, 10))
  return [0, 1, 2].reduce((result, index) => {
    if (result !== 0) return result
    return (left[index] ?? 0) - (right[index] ?? 0)
  }, 0)
}
