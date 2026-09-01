import { createResource, For, Show, type Component } from "solid-js"
import { Tag } from "@deepagent-code/ui/v2/badge-v2"
import {
  type CapabilityCatalog,
  type CapabilityLoadReceipts,
  type SystemContextSnapshot,
} from "@deepagent-code/sdk/client"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { catalogRows, receiptRows, snapshotRow } from "./capability-panel-model"
import "./settings-v2.css"

// C6-09 — capability panel: consumes /capability/catalog (L0 catalog rows), the recorded load
// receipts (identity + metrics, never a body) from /capability/loadReceipts, and the
// /system-context/snapshot diagnostics (catalog digest identity, L0 line count, digest
// consistency). Row derivation lives in capability-panel-model.ts (fixture-testable); this
// file is the settings-v2 shell (fetch) + the presentational view.

export type CapabilityCatalogClient = {
  capability: {
    catalog(options?: { throwOnError?: boolean }): Promise<{ data?: CapabilityCatalog }>
    loadReceipts(options?: { throwOnError?: boolean }): Promise<{ data?: CapabilityLoadReceipts }>
  }
  systemContext: {
    snapshot(options?: { throwOnError?: boolean }): Promise<{ data?: SystemContextSnapshot }>
  }
}

export type CapabilityPanelViewProps = {
  readonly catalog?: CapabilityCatalog
  readonly catalogError?: string
  readonly receipts?: CapabilityLoadReceipts
  readonly receiptsError?: string
  readonly snapshot?: SystemContextSnapshot
  readonly onRetry: () => void
  readonly t: (key: string, params?: Record<string, string | number | boolean>) => string
}

/** Presentational panel body — no SDK/context dependency. */
export function CapabilitiesView(props: CapabilityPanelViewProps) {
  const loading = () => props.catalog === undefined && props.catalogError === undefined

  return (
    <div class="settings-v2-tab-body settings-v2-capabilities">
      <Show
        when={props.catalogError === undefined}
        fallback={
          <div class="settings-v2-capabilities-status" data-component="capabilities-error">
            <span>{props.t("settings.capabilities.loadFailed")}</span>
            <button type="button" class="settings-v2-capabilities-retry" onClick={props.onRetry}>
              {props.t("settings.capabilities.retry")}
            </button>
          </div>
        }
      >
        <Show
          when={!loading()}
          fallback={
            <div class="settings-v2-capabilities-status">
              {props.t("common.loading")}
              {props.t("common.loading.ellipsis")}
            </div>
          }
        >
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{props.t("settings.capabilities.catalogTitle")}</h3>
            <SettingsListV2>
              <Show
                when={catalogRows(props.catalog).length > 0}
                fallback={<div class="settings-v2-capabilities-empty">{props.t("settings.capabilities.empty")}</div>}
              >
                <For each={catalogRows(props.catalog)}>
                  {(row) => (
                    <SettingsRowV2 title={`${row.id} · v${row.version}`} description={row.summary}>
                      <div class="flex items-center gap-1.5">
                        <Tag class="settings-v2-capabilities-availability">{props.t(row.availabilityKey)}</Tag>
                        <span class="settings-v2-capabilities-meta">{row.entryTools.join(", ")}</span>
                      </div>
                    </SettingsRowV2>
                  )}
                </For>
              </Show>
            </SettingsListV2>
          </div>

          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{props.t("settings.capabilities.receiptsTitle")}</h3>
            <SettingsListV2>
              <Show
                when={receiptRows(props.receipts).length > 0}
                fallback={
                  props.receiptsError !== undefined ? (
                    <div class="settings-v2-capabilities-empty">{props.t("settings.capabilities.loadFailed")}</div>
                  ) : (
                    <div class="settings-v2-capabilities-empty">{props.t("settings.capabilities.receiptsEmpty")}</div>
                  )
                }
              >
                <For each={receiptRows(props.receipts)}>
                  {(row) => (
                    <SettingsRowV2 title={`${row.capabilityId} · v${row.version}`} description={`${row.bodyRef} · ${row.bodyHash}`}>
                      <div class="flex items-center gap-1.5">
                        <Tag>{props.t("settings.capabilities.receiptsState")}</Tag>
                        <span class="settings-v2-capabilities-meta">
                          {row.tokenCount} tok · {row.byteCount} B
                        </span>
                      </div>
                    </SettingsRowV2>
                  )}
                </For>
              </Show>
            </SettingsListV2>
          </div>

          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{props.t("settings.capabilities.snapshotTitle")}</h3>
            <SettingsListV2>
              <Show
                when={snapshotRow(props.snapshot)}
                fallback={<div class="settings-v2-capabilities-empty">{props.t("settings.capabilities.snapshotUnavailable")}</div>}
              >
                {(row) => (
                  <SettingsRowV2
                    title={row().catalogSnapshotId}
                    description={`${props.t("settings.capabilities.digest", { digest: row().catalogDigest })} · ${props.t("settings.capabilities.l0lineCount", { count: row().l0LineCount })}`}
                  >
                    <Tag>
                      {row().catalogDigestConsistent
                        ? props.t("settings.capabilities.digestConsistent")
                        : props.t("settings.capabilities.digestInconsistent")}
                    </Tag>
                  </SettingsRowV2>
                )}
              </Show>
            </SettingsListV2>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export const SettingsCapabilitiesV2: Component = () => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  // W9.5: pass params through so `{{digest}}`/`{{count}}` templates resolve to real values
  // instead of rendering the literal placeholders.
  const t = (key: string, params?: Record<string, string | number | boolean>) => language.t(key as never, params)

  const [catalog, { refetch: refetchCatalog }] = createResource(
    () => serverSdk.client as unknown as CapabilityCatalogClient,
    (client) => client.capability.catalog({ throwOnError: true }).then((result) => result.data),
  )
  const [receipts, { refetch: refetchReceipts }] = createResource(
    () => serverSdk.client as unknown as CapabilityCatalogClient,
    (client) => client.capability.loadReceipts({ throwOnError: true }).then((result) => result.data),
  )
  const [snapshot, { refetch: refetchSnapshot }] = createResource(
    () => serverSdk.client as unknown as CapabilityCatalogClient,
    (client) => client.systemContext.snapshot({ throwOnError: true }).then((result) => result.data),
  )

  const catalogError = () => (catalog.error ? String(catalog.error) : undefined)

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{t("settings.capabilities.title")}</h2>
      </div>
      <CapabilitiesView
        catalog={catalog()}
        catalogError={catalogError()}
        receipts={receipts()}
        receiptsError={receipts.error ? String(receipts.error) : undefined}
        snapshot={snapshot()}
        onRetry={() => {
          void refetchCatalog()
          void refetchReceipts()
          void refetchSnapshot()
        }}
        t={t}
      />
    </>
  )
}
