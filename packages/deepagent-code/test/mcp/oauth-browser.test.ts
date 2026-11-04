async function register() {
  if (process.platform === "win32") {
    const { windowsMcpFile } = await import("../fixture/windows-mcp-file")
    windowsMcpFile("oauth-browser")
    return
  }
  await import("./oauth-browser.cases")
}
await register()
