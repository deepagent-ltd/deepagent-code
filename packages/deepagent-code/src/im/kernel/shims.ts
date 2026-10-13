// Browser-global shims so jugglechat-websdk runs under Bun (PoC §16 第 0 步实测的 6 个 shim 移植)。
// Only APIs the SDK actually calls on the text-message path are provided.
// MUST be imported before jugglechat-websdk: the bundle captures
// `localStorage`/`sessionStorage`/`WebSocket` at module-evaluation time.
// 全部带 typeof 守卫：在真浏览器里加载本模块是零副作用的。

class MapStorage {
  #map = new Map<string, string>()
  getItem(key: string): string | null {
    const value = this.#map.get(String(key))
    return value === undefined ? null : value
  }
  setItem(key: string, value: unknown): void {
    this.#map.set(String(key), String(value))
  }
  removeItem(key: string): void {
    this.#map.delete(String(key))
  }
  clear(): void {
    this.#map.clear()
  }
}

interface ShimmedGlobals {
  localStorage?: unknown
  sessionStorage?: unknown
  window?: { indexedDB?: unknown }
  XMLHttpRequest?: unknown
  FileReader?: unknown
  location?: { protocol: string }
}

const globals = globalThis as ShimmedGlobals

// localStorage / sessionStorage（SDK import 时就裸引用；Bun 1.4.2 实测没有 localStorage）
if (typeof globals.localStorage === "undefined") globals.localStorage = new MapStorage()
if (typeof globals.sessionStorage === "undefined") globals.sessionStorage = new MapStorage()

// window + indexedDB stub：SDK init() → Logger → DB() 无守卫调用 window.indexedDB.open()；
// 让 open 走 onerror 分支，SDK 会标记 log DB 不可用并 no-op 全部 DB IO——正是我们要的。
if (typeof globals.window === "undefined") globals.window = {}
if (typeof globals.window.indexedDB === "undefined") {
  globals.window.indexedDB = {
    open(_name: string, _version?: number) {
      const request: { result: unknown; onerror?: ((error: unknown) => void) | null } = { result: null }
      queueMicrotask(() => {
        if (typeof request.onerror === "function") request.onerror(new Error("indexedDB not available under Bun"))
      })
      return request
    },
  }
}

// XMLHttpRequest（fetch 版）：SDK WebRequest 走它打 GET <nav>/navigator/general 与 GET <server>/health。
// 暴露面：open/setRequestHeader/send/abort/timeout、readyState、status、responseText、responseURL、
// onreadystatechange、onerror、upload.onprogress。
if (typeof globals.XMLHttpRequest === "undefined") {
  class FetchXHR {
    readyState = 0
    status = 0
    responseText = ""
    responseURL = ""
    timeout = 0
    upload = { onprogress: null as null | ((event: unknown) => void) }
    onreadystatechange: null | (() => void) = null
    onerror: null | ((event: unknown) => void) = null
    #method = "GET"
    #url = ""
    #headers: Record<string, string> = {}
    #controller: AbortController | null = null

    open(method: string, url: string): void {
      this.#method = method
      this.#url = url
      this.readyState = 1
    }
    setRequestHeader(name: string, value: string): void {
      this.#headers[name] = value
    }
    abort(): void {
      this.#controller?.abort()
    }
    send(body?: unknown): void {
      const controller = new AbortController()
      this.#controller = controller
      const timer = this.timeout > 0 ? setTimeout(() => controller.abort(), this.timeout) : undefined
      void (async () => {
        try {
          const bodiless = /^(GET|HEAD)$/i.test(this.#method)
          // SDK 默认传 {} 作 body；浏览器对 GET/HEAD 会丢弃 body。
          const payload: BodyInit | undefined =
            bodiless || body === undefined || body === null
              ? undefined
              : typeof body === "string"
                ? body
                : body instanceof Uint8Array || body instanceof ArrayBuffer
                  ? (body as BodyInit)
                  : JSON.stringify(body)
          const response = await fetch(this.#url, {
            method: this.#method,
            headers: this.#headers,
            body: payload,
            signal: controller.signal,
          })
          this.status = response.status
          this.responseURL = response.url
          this.responseText = await response.text()
          this.readyState = 4
          try {
            this.onreadystatechange?.()
          } catch (callbackError) {
            console.error(
              "[kernel-shims] SDK onreadystatechange threw:",
              (callbackError as Error)?.message ?? callbackError,
            )
          }
        } catch (error) {
          // 隔离 SDK 侧 handler 缺陷（getNavis 读 t.result，浏览器里网络错误 Event 同样没有该字段）。
          try {
            if (this.onerror) {
              this.onerror({ status: this.status || 0, error: String(error) })
            } else {
              this.readyState = 4
              this.status = this.status || 0
              this.onreadystatechange?.()
            }
          } catch (callbackError) {
            console.error("[kernel-shims] SDK error handler threw:", (callbackError as Error)?.message ?? callbackError)
          }
        } finally {
          if (timer) clearTimeout(timer)
        }
      })()
    }
  }
  globals.XMLHttpRequest = FetchXHR
}

// FileReader：WS onmessage 路径 `new FileReader(); fr.onload=...; fr.readAsArrayBuffer(data)`。
// Bun 的 WebSocket 二进制投递可能是 ArrayBuffer / Buffer(Uint8Array) / Blob。
if (typeof globals.FileReader === "undefined") {
  class BunFileReader {
    result: ArrayBuffer | null = null
    onload: null | (() => void) = null
    onerror: null | ((event: unknown) => void) = null
    readAsArrayBuffer(data: unknown): void {
      void (async () => {
        if (data instanceof ArrayBuffer) {
          this.result = data
        } else if (ArrayBuffer.isView(data)) {
          this.result = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
        } else if (typeof Blob !== "undefined" && data instanceof Blob) {
          this.result = await data.arrayBuffer()
        } else if (typeof data === "string") {
          this.result = new TextEncoder().encode(data).buffer as ArrayBuffer
        } else {
          throw new Error("FileReader shim: unsupported data type")
        }
        this.onload?.()
      })().catch((error) => this.onerror?.(error))
    }
  }
  globals.FileReader = BunFileReader
}

// location：SDK getProtocol() 在 ESM 严格模式下给未声明的 location 赋值必炸；"http:" 是安全默认
// （显式 https://wss:// URL 仍会被 SDK 自己的字符串检查升级）。
if (typeof globals.location === "undefined") globals.location = { protocol: "http:" }

// navigator.appVersion：Bun 的 navigator 没有该字段，SDK 把它放进 x-device header。
try {
  const nav = (globalThis as { navigator?: { appVersion?: string } }).navigator
  if (typeof nav !== "undefined" && nav.appVersion === undefined) {
    const version = process.versions.bun
      ? `Bun/${process.versions.bun}`
      : process.versions.electron
        ? `Electron/${process.versions.electron} Node/${process.versions.node}`
        : `Node/${process.versions.node}`
    Object.defineProperty(nav, "appVersion", { value: version, configurable: true })
  }
} catch {
  // 非致命：最坏情况 x-device header 里是 "undefined"
}

export {}
