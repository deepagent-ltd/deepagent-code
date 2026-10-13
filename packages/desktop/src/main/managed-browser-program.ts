import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"

type Command = Extract<BrowserSchema.Command, { type: "program" }>
export type ProgramInput = Extract<
  BrowserSchema.Command,
  { type: "fill" | "select" | "click" | "press" | "scroll" | "drag" }
>

/** Only original, command-bound AX references become native inputs. The planner's JSON
 * cannot supply a document, selector, backend node, clipboard or filesystem capability. */
export function compileManagedBrowserProgram(
  control: BrowserSchema.Control,
  command: Command,
  json: string,
  fail: (code: BrowserSchema.Error["code"]) => never,
) {
  if (!BrowserSchema.allowsProgram(control, command)) return fail("BROWSER_SCOPE_DENIED")
  if (Buffer.byteLength(json, "utf8") > BrowserSchema.MAX_SCRIPT_RESULT_BYTES) return fail("BROWSER_OUTPUT_LIMIT")
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(BrowserSchema.ProgramPlan), {
    onExcessProperty: "error",
  })(json)
  if (Option.isNone(decoded)) return fail("BROWSER_INVALID_RECORD")
  const plan = decoded.value
  const grant =
    control.profile === BrowserSchema.INTERACTION_PROFILE
      ? control.programGrants?.find(
          (value) =>
            value.scriptHash === command.scriptHash &&
            value.argsHash === createHash("sha256").update(command.argsJSON).digest("hex"),
        )
      : undefined
  if (
    !grant ||
    plan.steps.length > grant.maxSteps ||
    plan.steps.some((value) => !grant.operations.includes(value.type))
  )
    return fail("BROWSER_SCOPE_DENIED")
  const targets = new Map(command.targets.map((value) => [value.name, value.ref]))
  const inputs = plan.steps.map((step, ordinal) => {
    if (
      (step.type === "click" || step.type === "press") &&
      step.waitForNavigation &&
      (ordinal !== plan.steps.length - 1 || (step.type === "press" && step.key !== "Enter"))
    )
      return fail("BROWSER_INVALID_RECORD")
    const ref = targets.get(step.target)
    if (!ref) return fail("BROWSER_STALE_TARGET")
    const target = {
      tabID: command.tabID,
      generation: command.generation,
      frameID: command.frameID,
      observationRevision: command.observationRevision,
      ref,
    }
    if (step.type === "fill") return { ...target, type: step.type, text: step.text } satisfies ProgramInput
    if (step.type === "select") return { ...target, type: step.type, values: step.values } satisfies ProgramInput
    if (step.type === "click")
      return {
        ...target,
        type: step.type,
        ...(step.count === undefined ? {} : { count: step.count }),
        ...(step.waitForNavigation === undefined ? {} : { waitForNavigation: step.waitForNavigation }),
      } satisfies ProgramInput
    if (step.type === "press")
      return {
        ...target,
        type: step.type,
        key: step.key,
        ...(step.waitForNavigation === undefined ? {} : { waitForNavigation: step.waitForNavigation }),
      } satisfies ProgramInput
    if (step.type === "scroll")
      return { ...target, type: step.type, deltaX: step.deltaX, deltaY: step.deltaY } satisfies ProgramInput
    const targetRef = targets.get(step.targetTo)
    if (!targetRef) return fail("BROWSER_STALE_TARGET")
    return {
      ...target,
      type: step.type,
      targetRef,
      ...(step.steps === undefined ? {} : { steps: step.steps }),
    } satisfies ProgramInput
  })
  return { inputs, planHash: createHash("sha256").update(CanonicalJson.stringify(plan)).digest("hex") }
}
