import { onCleanup, onMount, Show } from "solid-js"
import { ButtonV2 } from "@deepagent-code/ui/v2/button-v2"
import { TextInputV2 } from "@deepagent-code/ui/v2/text-input-v2"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { useLanguage } from "@/context/language"
import { createIMActivation, IMActivationErrorKeys, type IMActivationClient } from "./activation-controller"

export function IMActivationPanel(props: {
  client: IMActivationClient
  current: () => boolean
  activated: () => void
}) {
  const language = useLanguage()
  const controller = createIMActivation(props)
  const methods = () => [
    { value: "activation_code" as const, label: language.t("im.activation.method.code") },
    { value: "api_key" as const, label: language.t("im.activation.method.key") },
  ]
  const frozen = () => controller.state.busy || !!controller.state.transactionID || !controller.current()
  onMount(() => void controller.load())
  onCleanup(controller.dispose)

  return (
    <section class="settings-v2-section flex flex-col gap-3" data-component="im-activation">
      <h3 class="settings-v2-section-title">{language.t("im.activation.title")}</h3>
      <p class="text-12-regular text-text-weak">{language.t("im.activation.rootAccounts")}</p>
      <p class="text-12-regular text-text-weak">{language.t("im.activation.separateCredentials")}</p>
      <Show when={!controller.current()}>
        <p role="alert">{language.t("im.activation.localOnly")}</p>
      </Show>
      <Show
        when={controller.state.result?.state === "succeeded" && controller.state.result.credentialStored}
        fallback={
          <>
            <label class="flex flex-col gap-1 text-12-regular">
              {language.t("im.activation.method")}
              <SelectV2
                options={methods()}
                current={methods().find((method) => method.value === controller.state.method)}
                value={(method) => method.value}
                label={(method) => method.label}
                disabled={frozen()}
                onSelect={(method) => {
                  if (method) controller.update({ method: method.value })
                }}
              />
            </label>
            <label class="flex flex-col gap-1 text-12-regular">
              {language.t("im.activation.name")}
              <TextInputV2
                value={controller.state.name}
                maxlength={64}
                disabled={frozen()}
                autocomplete="off"
                spellcheck={false}
                aria-label={language.t("im.activation.name")}
                onInput={(event) => controller.update({ name: event.currentTarget.value })}
              />
            </label>
            <label class="flex flex-col gap-1 text-12-regular">
              {language.t(controller.state.method === "api_key" ? "im.activation.key" : "im.activation.code")}
              <TextInputV2
                type="password"
                value={controller.state.credential}
                maxlength={4096}
                disabled={(frozen() && !controller.canRetryOriginal()) || controller.state.busy}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck={false}
                aria-label={language.t(
                  controller.state.method === "api_key" ? "im.activation.key" : "im.activation.code",
                )}
                onInput={(event) => controller.update({ credential: event.currentTarget.value })}
              />
            </label>
            <p class="text-12-regular text-text-weak">{language.t("im.facade.name.rule")}</p>
            <Show when={!controller.state.transactionID}>
              <Show
                when={controller.state.method === "api_key"}
                fallback={<p class="text-12-regular text-text-weak">{language.t("im.activation.codeHint")}</p>}
              >
                <label class="flex items-start gap-2 text-12-regular">
                  <input
                    type="checkbox"
                    checked={controller.state.consent}
                    disabled={frozen()}
                    onChange={(event) => controller.update({ consent: event.currentTarget.checked })}
                  />
                  {language.t("im.activation.chargeConsent")}
                </label>
              </Show>
            </Show>
            <Show when={!controller.state.transactionID}>
              <div class="flex items-center gap-2">
                <ButtonV2
                  variant="contrast"
                  disabled={
                    frozen() ||
                    !controller.state.observed ||
                    !controller.state.quote ||
                    !controller.state.name.trim() ||
                    !controller.state.credential.trim() ||
                    (controller.state.method === "api_key" && !controller.state.consent)
                  }
                  onClick={() => void controller.submit()}
                >
                  {language.t(controller.state.method === "api_key" ? "im.activation.charge" : "im.activation.redeem")}
                </ButtonV2>
                <ButtonV2
                  variant="neutral"
                  disabled={controller.state.busy || !controller.current()}
                  onClick={() => void controller.load()}
                >
                  {language.t("im.activation.refresh")}
                </ButtonV2>
              </div>
            </Show>
          </>
        }
      >
        <p role="status" class="text-12-regular">
          {language.t("im.activation.state.activated")}
        </p>
      </Show>
      <Show when={controller.state.transactionID}>
        <div class="flex flex-col gap-2 text-12-regular">
          <p role="status">{language.t("im.activation.unknown")}</p>
          <details class="settings-v2-details">
            <summary>{language.t("im.activation.transaction")}</summary>
            <p class="break-all">{controller.state.transactionID}</p>
          </details>
          <ButtonV2
            variant="neutral"
            disabled={controller.state.busy || !controller.current()}
            onClick={() => void controller.check()}
          >
            {language.t("im.activation.check")}
          </ButtonV2>
          <Show when={controller.canRetryOriginal()}>
            <p class="text-text-weak">{language.t("im.activation.retryHint")}</p>
            <label class="flex items-start gap-2">
              <input
                type="checkbox"
                checked={controller.state.consent}
                disabled={controller.state.busy}
                onChange={(event) => controller.update({ consent: event.currentTarget.checked })}
              />
              {language.t("im.activation.retryConsent")}
            </label>
            <ButtonV2
              variant="contrast"
              disabled={controller.state.busy || !controller.state.credential || !controller.state.consent}
              onClick={() => void controller.retryOriginal()}
            >
              {language.t("im.activation.retryOriginal")}
            </ButtonV2>
          </Show>
        </div>
      </Show>
      <Show when={controller.state.result && controller.state.result.chargedCredits !== null}>
        <p class="text-12-regular">
          {language.t("im.activation.charged", { credits: controller.state.result!.chargedCredits! })}
        </p>
      </Show>
      <Show when={controller.state.error}>
        <p role="alert" class="text-12-regular text-text-critical">
          {controller.state.error ? language.t(IMActivationErrorKeys[controller.state.error]) : ""}
        </p>
      </Show>
    </section>
  )
}
