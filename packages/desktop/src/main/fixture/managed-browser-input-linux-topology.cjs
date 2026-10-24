// Stock-Electron L0 topology fixture. This never provides a production lease.
const assert = require("node:assert/strict")
const { app, BrowserWindow } = require("electron")
const { spawn } = require("node:child_process")
const path = require("node:path")
const fs = require("node:fs")

app.commandLine.appendSwitch("ozone-platform", "x11")
app.commandLine.appendSwitch("gtk-version", "3")
app.commandLine.appendSwitch("disable-gpu")
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] })
    const chunks = []
    child.stderr.on("data", (chunk) => chunks.push(chunk))
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(command + ":" + code + ":" + Buffer.concat(chunks))),
    )
  })
app
  .whenReady()
  .then(async () => {
    assert.equal(process.platform, "linux")
    assert.equal(process.arch, "x64")
    assert.equal(process.versions.electron, "41.10.6")
    assert.equal(process.versions.node, "24.18.0")
    const probe = require(path.join(__dirname, "managed-browser-input-linux-topology.node"))
    assert.deepEqual(Object.keys(probe), ["inspect"])
    const window = new BrowserWindow({
      width: 640,
      height: 480,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    await window.loadURL(
      "data:text/html,<input id='input' autofocus><script>globalThis.events=[]; for(const type of ['keydown','input','compositionstart','compositionupdate','compositionend']) document.addEventListener(type,e=>events.push({type:e.type,trusted:e.isTrusted}));</script>",
    )
    window.show()
    window.focus()
    await window.webContents.executeJavaScript("document.getElementById('input').focus()")
    const handle = window.getNativeWindowHandle()
    const before = probe.inspect(handle)
    assert.equal(before.gtk3AlreadyLoaded, true)
    assert.equal(before.gdkX11Display, true)
    assert.equal(before.xresSameProcessWindow, true)
    assert.equal(before.installedSignalHooks, 5)
    assert.equal(before.runtimeQualified, false)
    const xid = String(handle.length === 4 ? handle.readUInt32LE() : handle.readBigUInt64LE())
    await run("/usr/bin/xdotool", ["windowfocus", "--sync", xid])
    await run("/usr/bin/xdotool", ["key", "--clearmodifiers", "a"])
    await new Promise((resolve) => setTimeout(resolve, 150))
    const physical = probe.inspect(handle)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('input').value"), "a")
    assert.equal(physical.existingGdkClientWindow, true)
    window.webContents.debugger.attach("1.3")
    await window.webContents.debugger.sendCommand("Input.insertText", { text: "b" })
    const afterCdp = probe.inspect(handle)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('input').value"), "ab")
    assert.equal(afterCdp.commit, physical.commit)
    await run("/usr/bin/xdotool", ["key", "--clearmodifiers", "ctrl+shift+u"])
    await run("/usr/bin/xdotool", ["type", "--clearmodifiers", "4e2d"])
    await run("/usr/bin/xdotool", ["key", "--clearmodifiers", "Return"])
    await new Promise((resolve) => setTimeout(resolve, 150))
    const composition = probe.inspect(handle)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('input').value"), "ab中")
    assert.ok(composition["preedit-start"] > afterCdp["preedit-start"])
    assert.ok(composition["preedit-end"] > afterCdp["preedit-end"])
    await run("/usr/bin/xdotool", ["key", "--clearmodifiers", "ctrl+shift+u"])
    await run("/usr/bin/xdotool", ["type", "--clearmodifiers", "4e2d"])
    await run("/usr/bin/xdotool", ["key", "--clearmodifiers", "Escape"])
    await new Promise((resolve) => setTimeout(resolve, 150))
    const cancelled = probe.inspect(handle)
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('input').value"), "ab中")
    assert.ok(cancelled["preedit-end"] > composition["preedit-end"])
    const other = new BrowserWindow({
      width: 320,
      height: 240,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    await other.loadURL("data:text/html,<input id='other' autofocus>")
    other.show()
    other.focus()
    await other.webContents.executeJavaScript("document.getElementById('other').focus()")
    const otherHandle = other.getNativeWindowHandle()
    const otherXid = String(otherHandle.length === 4 ? otherHandle.readUInt32LE() : otherHandle.readBigUInt64LE())
    await run("/usr/bin/xdotool", ["windowfocus", "--sync", otherXid])
    await run("/usr/bin/xdotool", ["key", "--clearmodifiers", "z"])
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(await other.webContents.executeJavaScript("document.getElementById('other').value"), "z")
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('input').value"), "ab中")
    const afterOtherWindow = probe.inspect(handle)
    assert.ok(afterOtherWindow.commit > cancelled.commit)
    const result = {
      schemaVersion: "dac.managed-browser-input.linux.topology.v1",
      runtime: process.versions,
      commandedBackend: "x11",
      commandedGtk: "3",
      environment: "owned-xvfb-x64",
      physicalSource: "xtest-not-human",
      nativeIme: "gtk3-simple-unicode-not-ibus-or-fcitx",
      before,
      physical,
      afterCdp,
      composition,
      cancelled,
      afterOtherWindow,
      events: await window.webContents.executeJavaScript("events"),
      qualification: "unverified",
      blocker: "original-context-client-join-and-synchronous-chromium-dispatch-unavailable",
    }
    fs.writeFileSync(path.join(__dirname, "linux-topology-result.json"), JSON.stringify(result, null, 2) + "\n")
    console.log(JSON.stringify(result))
    other.destroy()
    window.destroy()
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
setTimeout(() => {
  console.error("LINUX_TOPOLOGY_TIMEOUT")
  app.exit(2)
}, 20_000).unref()
