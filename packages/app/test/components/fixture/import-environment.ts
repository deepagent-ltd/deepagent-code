import path from "node:path"

export function importFixtureEnvironment(root: string) {
  return {
    // Windows needs its system directory to load the child runtime and its DLLs.
    // Keep user configuration and writable roots inside this original fixture.
    ...(process.platform === "win32" ? {
      SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec ?? process.env.COMSPEC,
      SystemDrive: process.env.SystemDrive,
      USERPROFILE: path.join(root, "home"),
      APPDATA: path.join(root, "config"),
      LOCALAPPDATA: path.join(root, "data"),
    } : {}),
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    DEEPAGENT_CODE_HOME: path.join(root, "data"),
    DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
    DEEPAGENT_CODE_DB: path.join(root, "live.db"),
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_IM_AGENT_RESPONDER: "off",
  }
}
