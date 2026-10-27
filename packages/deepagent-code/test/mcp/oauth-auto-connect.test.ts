async function register() {
  if (process.platform === "win32") {
    const { windowsMcpFile } = await import("../fixture/windows-mcp-file")
    windowsMcpFile("oauth-auto-connect")
    return
  }
  await import("./oauth-auto-connect.cases")
}
await register()
