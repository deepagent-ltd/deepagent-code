import { withAlpha } from "@deepagent-code/ui/theme/color"
import { useTheme } from "@deepagent-code/ui/theme/context"
import { resolveThemeVariant } from "@deepagent-code/ui/theme/resolve"
import type { HexColor } from "@deepagent-code/ui/theme/types"
import type { FitAddon, Ghostty, Terminal as Term } from "ghostty-web"
import { type ComponentProps, createEffect, createMemo, onCleanup, onMount, splitProps } from "solid-js"
import { matchKeybind, parseKeybind } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { terminalFontFamily, useSettings } from "@/context/settings"
import { terminalFailure, type LocalPTY, type TerminalFailure, type TerminalStatus } from "@/context/terminal"
import { disposeIfDisposable, getHoveredLinkText, setOptionIfSupported } from "@/utils/runtime-adapters"
import { terminalWriter } from "@/utils/terminal-writer"
import { terminalWebSocketURL } from "@/utils/terminal-websocket-url"

const TOGGLE_TERMINAL_ID = "terminal.toggle"
const DEFAULT_TOGGLE_TERMINAL_KEYBIND = "ctrl+`"

// Pane-management keybinds handled by the session command layer. Ghostty swallows
// keys while a terminal is focused unless this handler returns true, so these must
// be allowed to bubble up for split/close/focus-neighbour to work (V3.7 Phase 4.2).
const PASSTHROUGH_KEYBINDS: Record<string, string> = {
  "terminal.split": "ctrl+alt+\\",
  "terminal.closePane": "ctrl+w",
  "terminal.focus.left": "ctrl+arrowleft",
  "terminal.focus.right": "ctrl+arrowright",
  "terminal.focus.up": "ctrl+arrowup",
  "terminal.focus.down": "ctrl+arrowdown",
}
export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  autoFocus?: boolean
  runtimeId?: string
  onSubmit?: () => void
  onStatusChange?: (status: TerminalStatus, error?: TerminalFailure) => void
  /** When true (restored PTY), show the terminal immediately after xterm initialises
   *  instead of waiting for the WebSocket handshake. The WebSocket still connects in
   *  the background; input typed before it's ready is buffered. */
  optimisticReady?: boolean
}

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined

const loadGhostty = () => {
  if (shared) return shared
  shared = import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((err) => {
      shared = undefined
      throw err
    })
  return shared
}

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

const debugTerminal = (...values: unknown[]) => {
  if (!import.meta.env.DEV) return
  console.debug("[terminal]", ...values)
}

const useTerminalUiBindings = (input: {
  container: HTMLDivElement
  term: Term
  cleanups: VoidFunction[]
  handlePointerDown: () => void
  handleLinkClick: (event: MouseEvent) => void
}) => {
  const handleCopy = (event: ClipboardEvent) => {
    const selection = input.term.getSelection()
    if (!selection) return

    const clipboard = event.clipboardData
    if (!clipboard) return

    event.preventDefault()
    clipboard.setData("text/plain", selection)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData
    const text = clipboard?.getData("text/plain") ?? clipboard?.getData("text") ?? ""
    if (!text) return

    event.preventDefault()
    event.stopPropagation()
    input.term.paste(text)
  }

  const handleTextareaFocus = () => {
    input.term.options.cursorBlink = true
  }
  const handleTextareaBlur = () => {
    input.term.options.cursorBlink = false
  }

  input.container.addEventListener("copy", handleCopy, true)
  input.cleanups.push(() => input.container.removeEventListener("copy", handleCopy, true))

  input.container.addEventListener("paste", handlePaste, true)
  input.cleanups.push(() => input.container.removeEventListener("paste", handlePaste, true))

  input.container.addEventListener("pointerdown", input.handlePointerDown)
  input.cleanups.push(() => input.container.removeEventListener("pointerdown", input.handlePointerDown))

  input.container.addEventListener("click", input.handleLinkClick, {
    capture: true,
  })
  input.cleanups.push(() =>
    input.container.removeEventListener("click", input.handleLinkClick, {
      capture: true,
    }),
  )

  input.term.textarea?.addEventListener("focus", handleTextareaFocus)
  input.term.textarea?.addEventListener("blur", handleTextareaBlur)
  input.cleanups.push(() => input.term.textarea?.removeEventListener("focus", handleTextareaFocus))
  input.cleanups.push(() => input.term.textarea?.removeEventListener("blur", handleTextareaBlur))
}

export const Terminal = (props: TerminalProps) => {
  const platform = usePlatform()
  const sdk = useSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  const server = useServer()
  const directory = sdk.directory
  const client = sdk.client
  const url = sdk.url
  const auth = server.current?.http
  const username = auth?.username ?? "deepagent-code"
  const password = auth?.password ?? ""
  const sameOrigin = new URL(url, location.href).origin === location.origin
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, [
    "pty",
    "class",
    "classList",
    "autoFocus",
    "runtimeId",
    "onSubmit",
    "onStatusChange",
    "optimisticReady",
  ])
  const id = local.pty.ptyId
  let ws: WebSocket | undefined
  let term: Term | undefined
  let _ghostty: Ghostty
  let fitAddon: FitAddon
  let handleResize: () => void
  let fitFrame: number | undefined
  let sizeTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSize: { cols: number; rows: number } | undefined
  let lastSize: { cols: number; rows: number } | undefined
  let connected = false
  let hasOutput = false
  let reportedReady = false
  let disposed = false
  const cleanups: VoidFunction[] = []
  let cursor = 0
  let seek = 0
  let output: ReturnType<typeof terminalWriter> | undefined
  let drop: VoidFunction | undefined
  let reconn: ReturnType<typeof setTimeout> | undefined
  let tries = 0

  const isFailure = (error: unknown): error is TerminalFailure =>
    Boolean(
      error &&
        typeof error === "object" &&
        "operation" in error &&
        "code" in error &&
        typeof error.code === "string" &&
        "message" in error &&
        typeof error.message === "string",
    )

  const failure = (error: unknown, status?: number) => {
    if (isFailure(error)) return error
    return terminalFailure({ operation: "connect", error, status, ptyId: id, directory, runtimeId: local.runtimeId })
  }

  const setStatus = (status: TerminalStatus, error?: TerminalFailure) => {
    if (disposed) return
    local.onStatusChange?.(status, error)
  }

  const markReady = () => {
    if (reportedReady) return
    reportedReady = true
    setStatus("ready")
  }

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch (err) {
        debugTerminal("cleanup failed", err)
      }
    }
  }

  const pushSize = async (cols: number, rows: number) => {
    if (!connected || disposed) return
    const result = await client.pty.update({ ptyID: id, size: { cols, rows } }, { throwOnError: false })
    if (result.response?.ok) return
    const error = terminalFailure({
      operation: "resize",
      error: result.error,
      status: result.response?.status,
      ptyId: id,
      directory,
      runtimeId: local.runtimeId,
    })
    if (error.status === 404) {
      connected = false
      setStatus("exited", error)
      return
    }
    console.warn("[terminal] resize failed", error)
  }

  const getTerminalColors = (): TerminalColors => {
    const mode = theme.mode() === "dark" ? "dark" : "light"
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    if (!currentTheme) return fallback
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds && !variant?.palette) return fallback
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = resolved["text-stronger"] ?? fallback.foreground
    const background = resolved["background-stronger"] ?? fallback.background
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
    const selectionBackground = withAlpha(base, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const terminalColors = createMemo(getTerminalColors)

  const scheduleFit = () => {
    if (disposed) return
    if (!fitAddon) return
    if (fitFrame !== undefined) return

    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined
      if (disposed) return
      fitAddon.fit()
    })
  }

  const scheduleSize = (cols: number, rows: number) => {
    if (disposed) return
    if (lastSize?.cols === cols && lastSize?.rows === rows) return

    pendingSize = { cols, rows }
    if (!connected) return

    if (!lastSize) {
      lastSize = pendingSize
      pendingSize = undefined
      void pushSize(cols, rows)
      return
    }

    if (sizeTimer !== undefined) return
    sizeTimer = setTimeout(() => {
      sizeTimer = undefined
      const next = pendingSize
      if (!next) return
      pendingSize = undefined
      if (disposed) return
      if (lastSize?.cols === next.cols && lastSize?.rows === next.rows) return
      lastSize = next
      void pushSize(next.cols, next.rows)
    }, 100)
  }

  createEffect(() => {
    const colors = terminalColors()
    if (!term) return
    setOptionIfSupported(term, "theme", colors)
  })

  createEffect(() => {
    const font = terminalFontFamily(settings.appearance.terminalFont())
    if (!term) return
    setOptionIfSupported(term, "fontFamily", font)
    scheduleFit()
  })

  let zoom = platform.webviewZoom?.()
  createEffect(() => {
    const next = platform.webviewZoom?.()
    if (next === undefined) return
    if (next === zoom) return
    zoom = next
    scheduleFit()
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    t.textarea?.focus()
    setTimeout(() => t.textarea?.focus(), 0)
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container && !container.contains(activeElement)) {
      activeElement.blur()
    }
    focusTerminal()
  }

  const handleLinkClick = (event: MouseEvent) => {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
    if (event.altKey) return
    if (event.button !== 0) return

    const t = term
    if (!t) return

    const text = getHoveredLinkText(t)
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()
    platform.openLink(text)
  }

  onMount(() => {
    const run = async () => {
      setStatus("connecting")
      const loaded = await loadGhostty()
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      const t = new mod.Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: 14,
        fontFamily: terminalFontFamily(settings.appearance.terminalFont()),
        allowTransparency: false,
        convertEol: false,
        theme: terminalColors(),
        scrollback: 10_000,
        ghostty: g,
      })
      cleanups.push(() => t.dispose())
      if (disposed) {
        cleanup()
        return
      }
      _ghostty = g
      term = t
      output = terminalWriter((data, done) =>
        t.write(data, () => {
          done?.()
        }),
      )

      t.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase()

        if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
          document.execCommand("copy")
          return true
        }

        // allow for toggle terminal keybinds in parent
        const config = settings.keybinds.get(TOGGLE_TERMINAL_ID) ?? DEFAULT_TOGGLE_TERMINAL_KEYBIND
        if (matchKeybind(parseKeybind(config), event)) return true

        // let pane-management keybinds bubble to the session command layer
        for (const [id, fallback] of Object.entries(PASSTHROUGH_KEYBINDS)) {
          const bind = settings.keybinds.get(id) ?? fallback
          if (matchKeybind(parseKeybind(bind), event)) return true
        }

        return false
      })

      const fit = new mod.FitAddon()
      cleanups.push(() => disposeIfDisposable(fit))
      t.loadAddon(fit)
      fitAddon = fit

      t.open(container)
      useTerminalUiBindings({
        container,
        term: t,
        cleanups,
        handlePointerDown,
        handleLinkClick,
      })

      if (local.autoFocus !== false) focusTerminal()

      if (typeof document !== "undefined" && document.fonts) {
        void document.fonts.ready.then(scheduleFit)
      }

      const onResize = t.onResize((size) => {
        scheduleSize(size.cols, size.rows)
      })
      cleanups.push(() => disposeIfDisposable(onResize))
      const onData = t.onData((data) => {
        // When optimisticReady is active the buffering handler below takes over.
        if (local.optimisticReady) return
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      })
      cleanups.push(() => disposeIfDisposable(onData))
      const onKey = t.onKey((key) => {
        if (key.key == "Enter") {
          local.onSubmit?.()
        }
      })
      cleanups.push(() => disposeIfDisposable(onKey))

      const startResize = () => {
        fit.observeResize()
        handleResize = scheduleFit
        window.addEventListener("resize", handleResize)
        cleanups.push(() => window.removeEventListener("resize", handleResize))
      }

      fit.fit()
      scheduleSize(t.cols, t.rows)
      startResize()

      // For restored PTYs: show the terminal surface immediately after xterm is
      // initialised instead of waiting for the full WebSocket handshake (which can
      // take 2-4 s). Input typed before the socket opens is buffered and flushed
      // once the connection is established.
      let inputBuffer = local.optimisticReady ? "" : undefined
      if (local.optimisticReady) {
        markReady()
        // Intercept onData to buffer keystrokes until the WebSocket is open.
        const onDataOpt = t.onData((data) => {
          if (ws?.readyState === WebSocket.OPEN) {
            if (inputBuffer) {
              ws.send(inputBuffer)
              inputBuffer = undefined
            }
            ws.send(data)
          } else {
            inputBuffer = (inputBuffer ?? "") + data
          }
        })
        cleanups.push(() => disposeIfDisposable(onDataOpt))
      }

      const once = { value: false }
      const decoder = new TextDecoder()

      const fail = (err: unknown) => {
        if (disposed) return
        if (once.value) return
        once.value = true
        connected = false
        const error = failure(err)
        setStatus(error.status === 404 ? "exited" : "error", error)
      }

      const gone = () =>
        client.pty
          .get({ ptyID: id }, { throwOnError: false })
          .then((result) => result.response?.status === 404)
          .catch((err) => {
            debugTerminal("failed to inspect terminal session", err)
            return false
          })

      const connectToken = async () => {
        const result = await client.pty
          .connectToken(
            { ptyID: id, directory },
            {
              throwOnError: false,
              headers: { "x-deepagent-code-ticket": "1" },
            },
          )
          .catch((err: unknown) => {
            if (err instanceof Error && err.message.includes("Request is not supported")) return
            throw err
          })
        if (!result) return {}
        // With throwOnError:false a completed request always carries a response; the SDK types it
        // optional (it can be absent when the request itself failed to build), so guard once.
        const response = result.response
        if (!response) throw new Error("PTY connect ticket failed: no response from server")
        if (response.status === 200 && result.data?.ticket) return { ticket: result.data.ticket }
        if (response.status === 405) return {}
        if (response.status === 404) throw failure(result.error, response.status)
        if (response.status === 403)
          throw failure(new Error("PTY connect ticket rejected by origin or CSRF checks"), response.status)
        throw failure(result.error ?? new Error(`PTY connect ticket failed with ${response.status}`), response.status)
      }

      const retry = (err: unknown) => {
        if (disposed) return
        if (reconn !== undefined) return
        if (tries >= 5) {
          fail(err)
          return
        }

        const ms = Math.min(250 * 2 ** Math.min(tries, 4), 4_000)
        setStatus("reconnecting", failure(err))
        reconn = setTimeout(async () => {
          reconn = undefined
          if (disposed) return
          if (await gone()) {
            if (disposed) return
            fail(failure(new Error("Terminal process no longer exists"), 404))
            return
          }
          if (disposed) return
          tries += 1
          void open()
        }, ms)
      }

      const open = async () => {
        if (disposed) return
        drop?.()

        const connection = await connectToken().catch((err) => {
          fail(err)
          return undefined
        })
        if (once.value) return
        if (disposed) return
        if (!connection) return

        const socket = new WebSocket(
          terminalWebSocketURL({
            url,
            id,
            directory,
            cursor: seek,
            ticket: connection.ticket,
            sameOrigin,
            username,
            password,
            authToken: server.current?.type === "http" ? server.current.authToken : false,
          }),
        )
        socket.binaryType = "arraybuffer"
        ws = socket

        const handleOpen = () => {
          if (disposed) return
          tries = 0
          connected = true
          reportedReady = false
          lastSize = undefined
          scheduleSize(t.cols, t.rows)
          markReady()
        }

        const handleMessage = (event: MessageEvent) => {
          if (disposed) return
          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            if (bytes[0] !== 0) return
            const json = decoder.decode(bytes.subarray(1))
            try {
              const meta: unknown = JSON.parse(json)
              const next = meta && typeof meta === "object" && "cursor" in meta ? meta.cursor : undefined
              if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
                cursor = next
                seek = next
                if (hasOutput || next > 0) markReady()
              }
            } catch (err) {
              debugTerminal("invalid websocket control frame", err)
            }
            return
          }

          const data = typeof event.data === "string" ? event.data : ""
          if (!data) return
          hasOutput = true
          markReady()
          output?.push(data)
          cursor += data.length
          seek = cursor
        }

        const handleError = (error: Event) => {
          if (disposed) return
          debugTerminal("websocket error", error)
        }

        const stop = () => {
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
        }

        const handleClose = (event: CloseEvent) => {
          connected = false
          reportedReady = false
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (disposed) return
          retry(new Error(language.t("terminal.connectionLost.abnormalClose", { code: event.code })))
        }

        drop = stop
        socket.addEventListener("open", handleOpen)
        socket.addEventListener("message", handleMessage)
        socket.addEventListener("error", handleError)
        socket.addEventListener("close", handleClose)
      }

      void open()
    }

    void run().catch((err) => {
      if (disposed) return
      const error = failure(err)
      console.error("[terminal] renderer failed", error)
      setStatus(error.status === 404 ? "exited" : "error", error)
    })
  })

  onCleanup(() => {
    disposed = true
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
    if (sizeTimer !== undefined) clearTimeout(sizeTimer)
    if (reconn !== undefined) clearTimeout(reconn)
    connected = false
    drop?.()
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close(1000)

    const finalize = () => cleanup()

    if (!output) {
      finalize()
      return
    }

    output.flush(finalize)
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      data-terminal-pty-id={id}
      data-prevent-autofocus
      tabIndex={-1}
      style={{ "background-color": terminalColors().background }}
      classList={{
        ...local.classList,
        "select-text": true,
        "size-full pl-6 pr-0 py-3 font-mono relative overflow-hidden": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
