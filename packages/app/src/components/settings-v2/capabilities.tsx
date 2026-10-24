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
import { catalogRows } from "./capability-panel-model"
import { SettingsPage } from "./parts/page"
import { SettingsMetadata } from "./metadata"
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
  readonly snapshotError?: string
  readonly onRetry: () => void
  readonly t: (key: string, params?: Record<string, string | number | boolean>) => string
}

/** Human overview first; complete machine records are retained in collapsed diagnostics. */
export function CapabilitiesView(props: CapabilityPanelViewProps) {
  const loading = () => props.catalog === undefined && props.catalogError === undefined
  const label = (kind: "name" | "description", id: string, fallback: string) => {
    const key = `settings.capabilities.${kind}.${id}`
    const value = props.t(key)
    return value && value !== key ? value : fallback
  }
  return (
    <div class="settings-v2-capabilities">
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
            <p class="text-12-regular text-text-weak">{props.t("settings.capabilities.description")}</p>
            <SettingsListV2>
              <Show
                when={catalogRows(props.catalog).length > 0}
                fallback={<div class="settings-v2-capabilities-empty">{props.t("settings.capabilities.empty")}</div>}
              >
                <For each={catalogRows(props.catalog)}>
                  {(row) => (
                    <SettingsRowV2
                      title={label("name", row.id, row.id)}
                      description={label("description", row.id, row.summary)}
                    >
                      <Tag class="settings-v2-capabilities-availability">{props.t(row.availabilityKey)}</Tag>
                    </SettingsRowV2>
                  )}
                </For>
              </Show>
            </SettingsListV2>
          </div>
        </Show>
      </Show>
      <div class="settings-v2-section">
        <SettingsMetadata
          title={props.t("settings.capabilities.diagnostics")}
          value={JSON.stringify(
            {
              catalog: props.catalog ?? null,
              receipts: props.receipts ?? null,
              snapshot: props.snapshot ?? null,
              readFailures: {
                catalog: props.catalogError !== undefined,
                receipts: props.receiptsError !== undefined,
                snapshot: props.snapshotError !== undefined,
              },
            },
            null,
            2,
          )}
        />
      </div>
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
    <SettingsPage title={t("settings.capabilities.title")} class="settings-v2-capabilities">
      <CapabilitiesView
        catalog={catalog()}
        catalogError={catalogError()}
        receipts={receipts()}
        receiptsError={receipts.error ? String(receipts.error) : undefined}
        snapshot={snapshot()}
        snapshotError={snapshot.error ? String(snapshot.error) : undefined}
        onRetry={() => {
          void refetchCatalog()
          void refetchReceipts()
          void refetchSnapshot()
        }}
        t={t}
      />
    </SettingsPage>
  )
}
