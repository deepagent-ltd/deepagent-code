import { For, Show } from "solid-js"
import { Checkbox } from "@deepagent-code/ui/checkbox"
import { TextField } from "@deepagent-code/ui/text-field"
import { SelectV2 } from "@deepagent-code/ui/v2/select-v2"
import { useLanguage } from "@/context/language"

export const browserProgramOperations = ["fill", "select", "click", "press", "scroll", "drag"] as const
export type BrowserScriptGrantDraft = {
  source: string
  argsJSON: string
  scriptMode: "readonly" | "program"
  programOperations: (typeof browserProgramOperations)[number][]
  programSteps: string
}
export type BrowserValidationScript = {
  source: string
  argsJSON: string
  scriptHash: string
  argsHash: string
  mode?: "program"
  operations?: BrowserScriptGrantDraft["programOperations"]
  maxSteps?: number
}

/** Hash the exact bytes the native host will receive, including JSON whitespace. */
export async function prepareBrowserScriptGrant(
  input: BrowserScriptGrantDraft,
  errors: { script: string; program: string },
): Promise<BrowserValidationScript | undefined> {
  const draft = { ...input, programOperations: [...input.programOperations] }
  if (!draft.source.isWellFormed() || !draft.argsJSON.isWellFormed()) throw new Error(errors.script)
  const bytes = [new TextEncoder().encode(draft.source), new TextEncoder().encode(draft.argsJSON)]
  if (bytes.some((value) => value.byteLength > 8192)) throw new Error(errors.script)
  if (!draft.source) return
  const { Option, Schema } = await import("effect")
  if (Option.isNone(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(draft.argsJSON)))
    throw new Error(errors.script)
  const maxSteps = Number(draft.programSteps)
  if (
    draft.scriptMode === "program" &&
    (!Number.isSafeInteger(maxSteps) ||
      maxSteps < 1 ||
      maxSteps > 16 ||
      !draft.programOperations.length ||
      new Set(draft.programOperations).size !== draft.programOperations.length ||
      draft.programOperations.some((operation) => !browserProgramOperations.includes(operation)))
  )
    throw new Error(errors.program)
  const hashes = await Promise.all(bytes.map((value) => crypto.subtle.digest("SHA-256", value)))
  return {
    source: draft.source,
    argsJSON: draft.argsJSON,
    scriptHash: Array.from(new Uint8Array(hashes[0]), (value) => value.toString(16).padStart(2, "0")).join(""),
    argsHash: Array.from(new Uint8Array(hashes[1]), (value) => value.toString(16).padStart(2, "0")).join(""),
    ...(draft.scriptMode === "program"
      ? { mode: "program" as const, operations: draft.programOperations, maxSteps }
      : {}),
  }
}

export function BrowserScriptGrantEditor(props: {
  draft: BrowserScriptGrantDraft
  id: string
  disabled?: boolean
  context?: "snapshot-json-v1"
  onChange: (value: Partial<BrowserScriptGrantDraft>) => void
}) {
  const language = useLanguage()
  const text = (key: string) => language.t(`browser.control.${key}` as Parameters<typeof language.t>[0])
  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-col gap-2">
        <span id={`browser-script-mode-${props.id}`} class="text-13-regular">
          {text("program.mode")}
        </span>
        <SelectV2
          aria-labelledby={`browser-script-mode-${props.id}`}
          options={["readonly", "program"] as const}
          current={props.draft.scriptMode}
          label={(value) => text(value === "program" ? "program.name" : "program.readonly")}
          disabled={props.disabled}
          onSelect={(value) => {
            if (value && !props.disabled) props.onChange({ scriptMode: value })
          }}
        />
      </div>
      <Show when={props.draft.scriptMode === "program"}>
        <fieldset class="flex flex-col gap-2" disabled={props.disabled}>
          <legend class="text-13-regular">{text("program.operations")}</legend>
          <div class="grid grid-cols-2 gap-2">
            <For each={browserProgramOperations}>
              {(operation) => (
                <Checkbox
                  checked={props.draft.programOperations.includes(operation)}
                  disabled={props.disabled}
                  onChange={(checked) => {
                    if (props.disabled) return
                    props.onChange({
                      programOperations: browserProgramOperations.filter((value) =>
                        value === operation ? checked : props.draft.programOperations.includes(value),
                      ),
                    })
                  }}
                >
                  {text(`program.operation.${operation}`)}
                </Checkbox>
              )}
            </For>
          </div>
        </fieldset>
        <TextField
          label={text("program.steps")}
          type="number"
          value={props.draft.programSteps}
          disabled={props.disabled}
          onChange={(value) => {
            if (!props.disabled) props.onChange({ programSteps: value })
          }}
        />
      </Show>
      <TextField
        label={text("scriptSource")}
        description={
          props.context === "snapshot-json-v1"
            ? language.t("browser.shared.scriptContextHint")
            : text(props.draft.scriptMode === "program" ? "program.hint" : "scriptHint")
        }
        multiline
        rows={4}
        value={props.draft.source}
        disabled={props.disabled}
        onChange={(value) => {
          if (!props.disabled) props.onChange({ source: value })
        }}
      />
      <TextField
        label={text("scriptArgs")}
        multiline
        rows={2}
        value={props.draft.argsJSON}
        disabled={props.disabled}
        onChange={(value) => {
          if (!props.disabled) props.onChange({ argsJSON: value })
        }}
      />
    </div>
  )
}
