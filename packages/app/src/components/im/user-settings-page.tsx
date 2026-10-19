import { Show } from "solid-js"
import { Button } from "@deepagent-code/ui/button"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useSettings } from "@/context/settings"
import { useServerSync } from "@/context/server-sync"
import type { IMFacadeStatus } from "@/utils/im-client"
import { BlockedCard, IdentityCard } from "./facade-cards"
import { imEntitlementState, observeIMEntitlement } from "./entitlement"

const CONNECTION_KEYS = {
  connected: "im.facade.kernel.connected",
  connecting: "im.facade.kernel.connecting",
  disconnected: "im.facade.kernel.disconnected",
  failed: "im.facade.kernel.failed",
} as const

export function IMUserSettingsPage(props: {
  status?: IMFacadeStatus
  statusFailed?: boolean
  current: () => boolean
  localAvailable: boolean
  onManageIM: () => void
  onChanged: () => void
  renameRequest?: number
}) {
  const language = useLanguage()
  const settings = useSettings()
  const sync = useServerSync()
  const models = useModels()
  const status = () => (props.current() && !props.statusFailed ? props.status : undefined)
  const identity = () => (status()?.facade === "active" && status()?.identity ? status() : undefined)
  const model = () => {
    if (!props.current() || !props.localAvailable) return undefined
    const configured = sync.data.config.im?.model
    return models
      .list()
      .find(
        (item) =>
          `${item.provider.id}/${item.id}` === configured &&
          models.visible({ providerID: item.provider.id, modelID: item.id }),
      )
  }

  return (
    <section
      class="im-sidebar-body flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
      data-slot="im-user-settings"
    >
      <Show
        when={identity()?.identity?.uuid}
        keyed
        fallback={
          <p class="im-sidebar-identity rounded-2xl bg-surface-raised-base p-4 text-13-medium">
            {language.t("im.user.identityUnknown")}
          </p>
        }
      >
        {(_uuid) => (
          <IdentityCard status={identity()!} onChanged={props.onChanged} compact renameRequest={props.renameRequest} />
        )}
      </Show>
      <Show when={status()?.facade === "blocked" || status()?.kernel}>
        <p role="status" class="text-12-regular text-text-weak">
          {status()?.facade === "blocked"
            ? language.t("im.facade.blocked.title")
            : status()?.kernel
              ? language.t(CONNECTION_KEYS[status()!.kernel!])
              : language.t("common.unknown")}
        </p>
      </Show>
      <Show when={props.statusFailed}>
        <div class="flex flex-col gap-2">
          <p role="alert" class="text-12-regular text-text-critical">
            {language.t("im.facade.status.failed")}
          </p>
          <Button
            size="small"
            variant="secondary"
            class="self-start"
            disabled={!props.current()}
            onClick={() => props.current() && props.onChanged()}
          >
            {language.t("common.retry")}
          </Button>
        </div>
      </Show>
      <Show when={status()?.blocked && status()?.blocked?.code !== "im_activation_required"}>
        <BlockedCard blocked={status()!.blocked!} onRecovered={props.onChanged} onActivate={props.onManageIM} />
      </Show>
      <dl class="im-sidebar-summary flex min-w-0 flex-col gap-4 rounded-2xl bg-surface-raised-base p-4">
        <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
          <dt class="text-12-regular text-text-weak">{language.t("settings.im.entitlement.title")}</dt>
          <dd class="min-w-0 break-words text-right text-12-medium">
            {language.t(`settings.im.entitlement.${imEntitlementState(observeIMEntitlement(status()))}`)}
          </dd>
        </div>
        <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
          <dt class="text-12-regular text-text-weak">{language.t("im.user.localDAC")}</dt>
          <dd class="min-w-0 break-words text-right text-12-medium">
            {language.t(
              props.current() && props.localAvailable ? "im.user.localAvailable" : "im.user.localUnavailable",
            )}
          </dd>
        </div>
        <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
          <dt class="text-12-regular text-text-weak">{language.t("im.user.model")}</dt>
          <dd class="min-w-0 break-words text-right text-12-medium">
            {model() ? `${model()!.provider.name} / ${model()!.name}` : language.t("im.user.modelUnknown")}
          </dd>
        </div>
      </dl>
      <div class="im-sidebar-section im-sidebar-summary flex min-w-0 flex-col gap-3 rounded-2xl bg-surface-raised-base p-4">
        <h3 class="text-12-medium text-text-weak">{language.t("im.user.preferences")}</h3>
        <dl class="flex min-w-0 flex-col gap-4">
          <div class="flex min-w-0 justify-between gap-3 text-12-regular">
            <dt>{language.t("im.user.appearance")}</dt>
            <dd>{language.t("im.user.followsDAC")}</dd>
          </div>
          <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 text-12-regular">
            <dt>{language.t("im.user.taskNotifications")}</dt>
            <dd class="min-w-0 break-words text-right">
              <p>
                {language.t(settings.notifications.agent() ? "im.user.notificationsOn" : "im.user.notificationsOff")}
              </p>
              <p class="text-text-weak">
                {language.t(settings.sounds.agentEnabled() ? "im.user.soundsOn" : "im.user.soundsOff")}
              </p>
            </dd>
          </div>
        </dl>
      </div>
      <Button variant="primary" disabled={!props.current()} onClick={() => props.current() && props.onManageIM()}>
        {language.t("im.user.manageIM")}
      </Button>
    </section>
  )
}
