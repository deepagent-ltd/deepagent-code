import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { Link } from "../link"
import { imEntitlementExpiry, imEntitlementState, type IMEntitlementObservation } from "./entitlement"

export function IMEntitlementSummary(props: { observation: IMEntitlementObservation }) {
  const language = useLanguage()
  const state = () => imEntitlementState(props.observation)
  const expiry = () => {
    const value = imEntitlementExpiry(props.observation)
    return value !== undefined ? new Date(value).toLocaleDateString() : undefined
  }

  return (
    <div class="flex min-w-0 flex-col gap-2" data-component="im-entitlement" data-entitlement-state={state()}>
      <h3 class="settings-v2-section-title">{language.t("settings.im.entitlement.title")}</h3>
      <p role="status" class="text-13-medium">
        {language.t(`settings.im.entitlement.${state()}`)}
      </p>
      <Show when={props.observation.state === "active"}>
        <p class="text-12-regular text-text-weak">
          {expiry()
            ? language.t("settings.im.entitlement.expiresOn", { date: expiry()! })
            : props.observation.state === "active" && props.observation.lifetime === true
              ? language.t("settings.im.entitlement.lifetime")
              : language.t("settings.im.entitlement.expiryUnknown")}
        </p>
      </Show>
      <Show when={props.observation.state === "unknown" && !props.observation.serviceConfigured}>
        <p class="text-12-regular text-text-weak">{language.t("settings.im.entitlement.serviceRequired")}</p>
      </Show>
      <details class="settings-v2-details">
        <summary>{language.t("settings.im.entitlement.plans")}</summary>
        <ul class="flex flex-col gap-2 py-2 text-12-regular">
          <li>{language.t("settings.im.entitlement.planYear")}</li>
          <li>{language.t("settings.im.entitlement.planThreeYears")}</li>
          <li>{language.t("settings.im.entitlement.planLifetime")}</li>
        </ul>
        <p class="text-12-regular text-text-weak">{language.t("settings.im.entitlement.purchaseUnavailable")}</p>
        <Link href="https://ai.deepagent.ltd/">{language.t("settings.im.entitlement.homepage")}</Link>
      </details>
    </div>
  )
}
