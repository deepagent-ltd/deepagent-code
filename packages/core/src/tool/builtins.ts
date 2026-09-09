export * as BuiltInTools from "./builtins"

import { Layer } from "effect"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { SkillTool } from "./skill"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WriteTool } from "./write"
import { PlanWriteTool } from "./plan"
import { CapabilityRuntimeSearch } from "../system-context/capability-runtime-search"
import { CapabilityLoadTool } from "../system-context/capability-load-tool"
import { ContextQueryTools } from "./context-query-tools"
import { readonlySet } from "../util/readonly-collections"

/**
 * The shipped built-in tool names (the exact registry names `locationLayer`
 * registers). This is the W4 inventory↔registry gate's registered set: a catalog
 * that advertises a tool name absent from this set is a build-gate failure
 * (`assertInventoryMatchesRegistry`). Kept in the same module as the layer so the
 * set and the registration cannot drift silently.
 */
export const builtinToolNames = readonlySet(new Set([
  ApplyPatchTool.name,
  BashTool.name,
  EditTool.name,
  GlobTool.name,
  GrepTool.name,
  PlanWriteTool.name,
  QuestionTool.name,
  ReadTool.name,
  SkillTool.name,
  WebFetchTool.name,
  WebSearchTool.name,
  WriteTool.name,
  CapabilityRuntimeSearch.name,
  CapabilityLoadTool.capabilityLoadName,
  ContextQueryTools.codeIntelName,
  ContextQueryTools.contextQueryName,
]))

/**
 * Composes only the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped canonical registrations, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: edit fuzzy
 * parity, task, LSP,
 * repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep MCP and plugin
 * transforms separate from this static built-in list.
 *
 * NOTE: `todowrite` was removed from the built-in set as part of unifying task
 * tracking onto the `plan` system (the two tracks shadowed each other: the app
 * composer renders the plan and ignores todos, so todo-based progress reports
 * were invisible). The SessionTodo store (session/todo.ts) and its read path are
 * intentionally retained for migration safety and embedded-API compatibility;
 * only the LLM-facing write tool is gone.
 */
export const locationLayer = Layer.mergeAll(
  ApplyPatchTool.layer,
  BashTool.layer,
  EditTool.layer,
  GlobTool.layer,
  GrepTool.layer,
  QuestionTool.layer,
  ReadTool.layer,
  SkillTool.layer,
  WebFetchTool.layer,
  WebSearchTool.layer.pipe(Layer.provide(WebSearchTool.defaultConfigLayer)),
  WriteTool.layer,
  PlanWriteTool.layer,
  CapabilityRuntimeSearch.layer,
  CapabilityLoadTool.layer,
  ContextQueryTools.layer,
)
