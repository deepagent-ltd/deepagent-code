import { Checkbox } from "@deepagent-code/ui/checkbox"
import { BrowserScriptGrantEditor, type BrowserScriptGrantDraft } from "./browser-script-grant"
import { useLanguage } from "@/context/language"

export type SharedBrowserGrantDraft = BrowserScriptGrantDraft & {
  filePolicy: { upload: boolean; download: boolean }
}

// This form has no authority or availability inference. The creation flow mounts it
// only after the registered Host and Main leaves have both been qualified.
export function SharedBrowserGrantEditor(props: {
  draft: SharedBrowserGrantDraft
  id: string
  disabled?: boolean
  onChange: (value: Partial<SharedBrowserGrantDraft>) => void
}) {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-3">
      <BrowserScriptGrantEditor {...props} context="snapshot-json-v1" />
      <fieldset class="flex flex-col gap-2" disabled={props.disabled}>
        <legend class="text-13-regular">{language.t("browser.files.title")}</legend>
        <p class="text-13-regular text-text-weak">{language.t("browser.shared.filePolicyHint")}</p>
        <Checkbox
          checked={props.draft.filePolicy.upload}
          disabled={props.disabled}
          onChange={(upload) => {
            if (!props.disabled) props.onChange({ filePolicy: { ...props.draft.filePolicy, upload } })
          }}
        >
          {language.t("browser.files.upload")}
        </Checkbox>
        <Checkbox
          checked={props.draft.filePolicy.download}
          disabled={props.disabled}
          onChange={(download) => {
            if (!props.disabled) props.onChange({ filePolicy: { ...props.draft.filePolicy, download } })
          }}
        >
          {language.t("browser.files.download")}
        </Checkbox>
      </fieldset>
    </div>
  )
}
