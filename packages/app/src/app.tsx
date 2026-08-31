import "@/index.css"
import * as Sentry from "@sentry/solid"
import { I18nProvider } from "@deepagent-code/ui/context"
import { DialogProvider } from "@deepagent-code/ui/context/dialog"
import { FileComponentProvider } from "@deepagent-code/ui/context/file"
import { MarkedProvider } from "@deepagent-code/ui/context/marked"
import { File } from "@deepagent-code/ui/file"
import { Font } from "@deepagent-code/ui/font"
import { Splash } from "@deepagent-code/ui/logo"
import { ThemeProvider } from "@deepagent-code/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useLocation, useParams } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
  untrack,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/context/command"
import { BootstrapGate } from "@/maintenance/bootstrap-gate"
import { CommentsProvider } from "@/context/comments"
import { DebugProvider } from "@/context/debug"
import { FileProvider } from "@/context/file"
import type { DesktopApi } from "@/utils/desktop-api"
import { GatewayProvider } from "@/context/gateway"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { GlobalProvider } from "@/context/global"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { TabsProvider } from "@/context/tabs"
import { WslServersProvider } from "@/wsl/context"
import DirectoryLayout, { decodeDirectory } from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"
import { startupViewReady } from "@/utils/startup-ready"

const HomeRoute = lazy(() => import("@/pages/home"))
const Session = lazy(() => import("@/pages/session"))
const AgentSystemRoute = lazy(() => import("@/pages/agent-system"))
const ReviewRoute = lazy(() => import("@/pages/review"))

const SessionRoute = Object.assign(
  () => (
    <SessionProviders>
      <Session />
    </SessionProviders>
  ),
  { preload: Session.preload },
)

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __DEEPAGENT_CODE__?: {
      deepLinks?: string[]
    }
    api?: DesktopApi
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyDesignClass() {
  createEffect(() => {
    if (typeof document === "undefined") return

    document.body.classList.add("text-12-regular")
    document.body.classList.remove("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
  })

  return null
}

function AppShellProviders(props: ParentProps<{ onStartupReady?: () => void }>) {
  const [startupRestoreSettled, setStartupRestoreSettled] = createSignal(false)

  return (
    <SettingsProvider>
      <BodyDesignClass />
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <HighlightsProvider>
                  <Layout onStartupRestoreSettled={() => setStartupRestoreSettled(true)}>
                    {props.onStartupReady ? (
                      <StartupViewReady restoreSettled={startupRestoreSettled()} onReady={props.onStartupReady} />
                    ) : null}
                    {props.children}
                  </Layout>
                </HighlightsProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <DebugProvider>
            <CommentsProvider>{props.children}</CommentsProvider>
          </DebugProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function StartupViewReady(props: { restoreSettled: boolean; onReady: () => void }) {
  const server = useServer()
  const serverSync = useServerSync()
  const location = useLocation()
  const params = useParams()
  let complete = false
  let signature = ""

  const state = () => {
    const directory = params.dir ? decodeDirectory(params.dir) : undefined
    const sessionId = params.id
    const store = directory ? serverSync.peek(directory, { bootstrap: false })[0] : undefined
    return {
      pathname: location.pathname,
      serverReady: server.ready(),
      globalReady: serverSync.ready,
      globalError: !!serverSync.error,
      restoreSettled: props.restoreSettled,
      lastProject: server.projects.last(),
      directory,
      directoryReady: !directory || (!!store && store.status !== "loading"),
      sessionId,
      hasSession: !!store?.session.some((session) => session.id === sessionId),
      messagesReady: !!sessionId && store?.message[sessionId] !== undefined,
    }
  }

  createEffect(() => {
    const current = state()
    const nextSignature = JSON.stringify({
      route: current.pathname === "/" ? "home" : current.sessionId ? "session" : "directory",
      serverReady: current.serverReady,
      globalReady: current.globalReady,
      globalError: current.globalError,
      restoreSettled: current.restoreSettled,
      hasLastProject: !!current.lastProject,
      hasDirectory: !!current.directory,
      directoryReady: current.directoryReady,
      hasSessionId: !!current.sessionId,
      hasSession: current.hasSession,
      messagesReady: current.messagesReady,
    })
    if (signature !== nextSignature) {
      signature = nextSignature
      console.info("[startup] readiness", nextSignature)
    }

    if (complete || !startupViewReady(current)) return
    complete = true
    props.onReady()
  })

  return null
}

function RouterRoot(
  props: ParentProps<{
    appChildren?: JSX.Element
    onStartupReady?: () => void
  }>,
) {
  return (
    <AppShellProviders onStartupReady={props.onStartupReady}>
      {/*<Suspense fallback={<Loading />}>*/}
      {props.appChildren}
      {props.children}
      {/*</Suspense>*/}
    </AppShellProviders>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                Sentry.captureException(error)
                return <ErrorPage error={error} />
              }}
            >
              <QueryProvider>
                <WslServersProvider>
                  <DialogProvider>
                    <MarkedProvider>
                      <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                    </MarkedProvider>
                  </DialogProvider>
                </WslServersProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // Desktop sidecars enter the provider only after their main-process health check.
  // Other non-http connections get a grace period; HTTP connections fail instantly.
  // Track only the stable active-server key: depending on `server.current` (a memo
  // whose identity changes with connection/project churn) re-ran this resource on
  // every upstream update, flickering `checking` and remounting the bootstrap gate.
  const [startupHealthCheck, healthCheckActions] = createResource(() => {
    void server.key
    const current = untrack(() => server.current)
    if (props.disableHealthCheck || current?.type === "sidecar") return true
    return Effect.gen(function* () {
      if (!current) return true
      const { http, type } = current

      while (true) {
        const res = yield* Effect.promise(() => checkServerHealth(http))
        if (res.healthy) return true
        if (checkMode() === "background" || type === "http") return false
      }
    }).pipe(
      Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
      Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
      Effect.runPromise,
    )
  })
  const checking = createMemo(
    () => checkMode() === "blocking" && ["unresolved", "pending"].includes(startupHealthCheck.state),
  )

  return (
    <Show
      when={!checking()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck.latest}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") void healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              void healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
  onStartupReady?: () => void
}) {
  return (
    <GatewayProvider>
      <ServerProvider
        defaultServer={props.defaultServer}
        canonicalLocalServer={props.canonicalLocalServer}
        servers={props.servers}
      >
        <GlobalProvider>
          <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
            <BootstrapGate>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => (
                  <TabsProvider>
                    <ServerKey>
                      <QueryProvider>
                        <ServerSDKProvider>
                          <ServerSyncProvider>
                            <RouterRoot appChildren={props.children} onStartupReady={props.onStartupReady}>
                              {routerProps.children}
                            </RouterRoot>
                          </ServerSyncProvider>
                        </ServerSDKProvider>
                      </QueryProvider>
                    </ServerKey>
                  </TabsProvider>
                )}
              >
                <Route path="/" component={HomeRoute} />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route path="/" component={() => <Navigate href="session" />} />
                  <Route path="/agent" component={AgentSystemRoute} />
                  <Route path="/review" component={ReviewRoute} />
                  <Route path="/session/:id?" component={SessionRoute} />
                </Route>
              </Dynamic>
            </BootstrapGate>
          </ConnectionGate>
        </GlobalProvider>
      </ServerProvider>
    </GatewayProvider>
  )
}
