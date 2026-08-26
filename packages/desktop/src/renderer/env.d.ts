import type { ElectronAPI } from "../preload/types"

declare global {
  interface Window {
    api: ElectronAPI
    __DEEPAGENT_CODE__?: {
      deepLinks?: string[]
    }
  }
}
