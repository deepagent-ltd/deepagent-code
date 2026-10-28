async function register() {
  if (process.platform === "win32") {
    const { windowsMcpFile } = await import("../fixture/windows-mcp-file")
    windowsMcpFile("auth-scope")
    return
  }
  await import("./auth-scope.cases")
}
await register()
