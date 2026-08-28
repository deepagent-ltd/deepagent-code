interface ImportMetaEnv {
  readonly DEEPAGENT_CODE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:deepagent-code-server" {
  export namespace Server {
    export const listen: typeof import("../../../deepagent-code/dist/types/src/node").Server.listen
    export type Listener = import("../../../deepagent-code/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../deepagent-code/dist/types/src/node").Config.get
    export type Info = import("../../../deepagent-code/dist/types/src/node").Config.Info
  }
  export namespace Log {
    export const init: typeof import("../../../deepagent-code/dist/types/src/node").Log.init
  }
  export const bootstrap: typeof import("../../../deepagent-code/dist/types/src/node").bootstrap
}
