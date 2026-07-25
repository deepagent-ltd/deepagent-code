import { openai } from "@ai-sdk/openai"
import type { Tool } from "ai"
import { APPLY_PATCH_LARK_GRAMMAR } from "@/tool/apply-patch-grammar"

type ProtocolModel = { readonly provider: string }

export const supportsApplyPatch = (model: ProtocolModel) => model.provider.endsWith(".responses")

export const format = {
  type: "grammar" as const,
  syntax: "lark" as const,
  definition: APPLY_PATCH_LARK_GRAMMAR,
}

export const input = (value: unknown) => ({ patchText: typeof value === "string" ? value : "" })

export const tools = (model: ProtocolModel, source: Record<string, Tool>): Record<string, Tool> => {
  if (!supportsApplyPatch(model)) {
    const { apply_patch: _applyPatch, ...result } = source
    return result
  }
  const patch = source.apply_patch
  if (!patch?.execute) {
    const { apply_patch: _applyPatch, ...result } = source
    return result
  }
  const execute = patch.execute
  const result = { ...source }
  result.apply_patch = {
    ...openai.tools.customTool({
      name: "apply_patch",
      description: `${patch.description ?? "Apply a patch to workspace files."}\nThis is a FREEFORM tool. Send the patch directly without a JSON wrapper.`,
      format,
    }),
    execute: (value: string, options: Parameters<typeof execute>[1]) => execute(input(value), options),
    toModelOutput: patch.toModelOutput,
  }
  return result
}

export * as FreeformTools from "./freeform-tools"
