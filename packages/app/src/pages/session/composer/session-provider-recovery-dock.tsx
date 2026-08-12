import type { SessionProviderResolutionListResponse } from "@deepagent-code/sdk/v2"
import { hash } from "@deepagent-code/core/util/encode"
import { Button } from "@deepagent-code/ui/button"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Dialog } from "@deepagent-code/ui/dialog"
import { Icon } from "@deepagent-code/ui/icon"
import { createEffect, createResource, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"

export type ProviderRecovery = SessionProviderResolutionListResponse[number]

export function providerRecoveryFingerprint(item: ProviderRecovery) {
  return JSON.stringify([
    item.receiptID,
    item.providerState,
    item.promptEpoch,
    item.sessionMutationEpoch,
    item.requestHash,
    item.historyHash,
    item.worldStateBaselineHash,
  ])
}

export async function providerRecoveryCommandID(item: ProviderRecovery) {
  return `provider-recovery-${await hash(providerRecoveryFingerprint(item))}`
}

export function providerRecoveryPending(input: {
  loading: boolean
  error: unknown
  recoveries: readonly ProviderRecovery[] | undefined
  settlementFailed?: boolean
}) {
  return input.loading || input.error !== undefined || input.settlementFailed === true || (input.recoveries?.length ?? 0) > 0
}

export async function providerRecoveryResolveInput(item: ProviderRecovery) {
  return {
    commandID: await providerRecoveryCommandID(item),
    receiptID: item.receiptID,
    decision: "abandoned" as const,
    expected: {
      providerState: item.providerState,
      promptEpoch: item.promptEpoch,
      sessionMutationEpoch: item.sessionMutationEpoch,
      requestHash: item.requestHash,
      historyHash: item.historyHash,
      worldStateBaselineHash: item.worldStateBaselineHash!,
    },
  }
}

export async function resolveProviderRecovery(input: {
  sessionID: string
  recovery: ProviderRecovery
  resolve: (request: Awaited<ReturnType<typeof providerRecoveryResolveInput>> & { sessionID: string }) => Promise<{
    error?: unknown
    response?: { status?: number }
  }>
  refresh: () => Promise<"cleared" | "retained" | "failed">
}) {
  const request = await providerRecoveryResolveInput(input.recovery)
  const outcome = await input
    .resolve({ sessionID: input.sessionID, ...request })
    .then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )

  if ("error" in outcome) {
    const refreshed = await input.refresh()
    if (refreshed === "cleared") return { status: "resolved" as const }
    return { status: "failed" as const, error: outcome.error, refreshed }
  }

  if (outcome.result.error !== undefined) {
    const refreshed = await input.refresh()
    if (refreshed === "cleared") return { status: "resolved" as const }
    return {
      status: outcome.result.response?.status === 409 ? ("conflict" as const) : ("failed" as const),
      error: outcome.result.error,
      refreshed,
    }
  }

  const refreshed = await input.refresh()
  return { status: refreshed === "cleared" ? ("resolved" as const) : ("refresh_failed" as const) }
}

export function SessionProviderRecoveryDock(props: {
  sessionID: string
  onPendingChange: (pending: boolean) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const language = useLanguage()
  const dialog = useDialog()
  const [store, setStore] = createStore({
    resolving: undefined as string | undefined,
    status: "idle" as "idle" | "conflict" | "failed",
    detail: undefined as string | undefined,
  })
  const [recoveries, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const result = await sdk.client.session.providerResolutionList({ sessionID })
      if (result.error) throw result.error
      return result.data ?? []
    },
  )
  const recovery = () => recoveries()?.[0]

  createEffect(() => {
    props.sessionID
    setStore({ resolving: undefined, status: "idle", detail: undefined })
  })

  createEffect(() => {
    props.onPendingChange(
      providerRecoveryPending({
        loading: recoveries.loading,
        error: recoveries.error,
        recoveries: recoveries(),
        settlementFailed: store.status === "failed",
      }),
    )
  })
  onCleanup(() => props.onPendingChange(false))

  const refresh = async (sessionID: string, receiptID: string) => {
    if (props.sessionID !== sessionID) return "failed" as const
    const results = await Promise.allSettled([
      refetch(),
      sync.session.sync(sessionID, { force: true }),
    ])
    if (results.some((result) => result.status === "rejected")) return "failed" as const
    const descriptors = results[0].status === "fulfilled" ? results[0].value : undefined
    return descriptors?.some((item) => item.receiptID === receiptID) ? ("retained" as const) : ("cleared" as const)
  }

  const abandon = async (item: ProviderRecovery) => {
    if (store.resolving) return
    const sessionID = props.sessionID
    setStore({ resolving: item.receiptID, status: "idle", detail: undefined })
    const outcome = await resolveProviderRecovery({
      sessionID,
      recovery: item,
      resolve: (request) => sdk.client.session.providerResolutionResolve(request),
      refresh: () => refresh(sessionID, item.receiptID),
    })
    if (props.sessionID !== sessionID) return
    setStore("resolving", undefined)

    if (outcome.status === "failed") {
      setStore({ status: "failed", detail: formatServerError(outcome.error, language.t) })
      showToast({
        variant: "error",
        title: language.t("session.providerRecovery.failed"),
        description: store.detail,
      })
      return
    }

    if (outcome.status === "conflict") {
      setStore({
        status: "conflict",
        detail: formatServerError(outcome.error, language.t),
      })
      showToast({
        variant: "default",
        title: language.t("session.providerRecovery.conflict"),
        description: store.detail,
      })
      return
    }

    if (outcome.status === "resolved") {
      setStore({ status: "idle", detail: undefined })
      showToast({ variant: "success", title: language.t("session.providerRecovery.resolved") })
      return
    }

    setStore({ status: "failed", detail: undefined })
    showToast({ variant: "error", title: language.t("session.providerRecovery.refreshFailed") })
  }

  const retry = async () => {
    const results = await Promise.allSettled([refetch(), sync.session.sync(props.sessionID, { force: true })])
    setStore("status", results.every((result) => result.status === "fulfilled") ? "idle" : "failed")
  }

  const confirm = (item: ProviderRecovery) =>
    dialog.show(() => (
      <Dialog title={language.t("session.providerRecovery.confirmTitle")} transition>
        <div class="flex w-[480px] max-w-[calc(100vw-32px)] flex-col gap-4 px-6 pb-6">
          <div class="text-13-regular text-text-base">{language.t("session.providerRecovery.confirmDescription")}</div>
          <div class="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              icon="circle-x"
              onClick={() => {
                dialog.close()
                void abandon(item)
              }}
            >
              {language.t("session.providerRecovery.abandon")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))

  return (
    <Show
      when={recovery()}
      keyed
      fallback={
        <Show when={recoveries.error || store.status === "failed"}>
          <div class="mb-2 border-l-2 border-icon-critical-base bg-surface-raised-base px-3 py-2.5">
            <div class="flex items-start gap-2">
              <Icon name="warning" size="small" class="mt-0.5 shrink-0 text-text-critical" />
              <div class="min-w-0 flex-1">
                <div class="text-13-medium text-text-strong">
                  {language.t(
                    recoveries.error ? "session.providerRecovery.loadFailed" : "session.providerRecovery.refreshFailed",
                  )}
                </div>
                <div class="mt-1 text-12-regular text-text-weak">
                  {language.t(
                    recoveries.error
                      ? "session.providerRecovery.loadFailedDescription"
                      : "session.providerRecovery.refreshFailedDescription",
                  )}
                </div>
              </div>
              <Button size="small" onClick={() => void retry()}>
                {language.t("common.retry")}
              </Button>
            </div>
          </div>
        </Show>
      }
    >
      {(item) => {
        const supported = () =>
          item.continuationRecoverySupported &&
          item.workspaceRecoverySupported &&
          item.sourceWorldStateBaselineStatus === "available"
        return (
          <div
            class="mb-2 border-l-2 border-icon-warning-base bg-surface-raised-base px-3 py-2.5"
            aria-live="polite"
          >
            <div class="flex items-start gap-2">
              <Icon name="warning" size="small" class="mt-0.5 shrink-0 text-text-warning" />
              <div class="min-w-0 flex-1">
                <div class="text-13-medium text-text-strong">{language.t("session.providerRecovery.title")}</div>
                <div class="mt-1 text-12-regular text-text-weak">
                  {language.t("session.providerRecovery.description")}
                </div>
                <div class="mt-1 truncate text-11-regular text-text-weaker">
                  {item.providerID} / {item.modelID}
                </div>
              </div>
              <Button
                size="small"
                icon="circle-x"
                disabled={store.resolving === item.receiptID || !supported()}
                onClick={() => void confirm(item)}
              >
                {store.resolving === item.receiptID
                  ? language.t("session.providerRecovery.resolving")
                  : language.t("session.providerRecovery.abandon")}
              </Button>
            </div>
            <Show when={!item.continuationRecoverySupported}>
              <div class="mt-2 text-11-regular text-text-critical">
                {language.t("session.providerRecovery.unsupported")}
              </div>
            </Show>
            <Show when={!item.workspaceRecoverySupported}>
              <div class="mt-2 text-11-regular text-text-critical">
                {language.t("session.providerRecovery.workspaceUnsupported")}
              </div>
            </Show>
            <Show when={item.sourceWorldStateBaselineStatus !== "available"}>
              <div class="mt-2 text-11-regular text-text-critical">
                {language.t("session.providerRecovery.baselineUnsupported")}
              </div>
            </Show>
            <Show when={store.status !== "idle"}>
              <div class="mt-2 text-11-regular text-text-critical">
                {language.t(
                  store.status === "conflict"
                    ? "session.providerRecovery.conflictDescription"
                    : "session.providerRecovery.failed",
                )}
                <Show when={store.detail}>: {store.detail}</Show>
              </div>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
