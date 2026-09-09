export * as AgentPlugin from "./agent"

import path from "path"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Global } from "../global"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { PluginV2 } from "../plugin"

const TRUNCATION_GLOB = path.join(Global.Path.data, "tool-output", "*")
const BUILD_SYSTEM =
  "You are an AI coding agent. Help the user accomplish software engineering tasks by inspecting the workspace, making targeted changes, and using tools according to the configured permissions."

const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files, or run bash commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.`

const PROMPT_RESEARCHER = `You are a read-only research agent. Follow the user's research request exactly by inspecting the workspace with read-only tools.

Use Read, Glob, Grep, Code Intel, Context Query, and other explicitly available read-only tools to gather concrete evidence. Do not edit files, run shell commands, delegate tasks, or claim evidence that you did not observe. Return the requested structured result when the user supplies an output contract.`

const PROMPT_COMPACTION = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`

const PROMPT_TITLE = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/auth.ts can you add refresh token support" -> Auth refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`

const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

// Mirrors the V1 app asset packages/deepagent-code/src/agent/prompt/goal-worker.txt. The V2 runner
// resolves agents from this registry only, so the Goal Loop worker must exist here; the two copies
// stay in sync by convention (V1 legacy path vs V2 runtime), same as PROMPT_COMPACTION/TITLE/SUMMARY.
const PROMPT_GOAL_WORKER = `You are a Goal Loop worker (V3.9 §D). You execute ONE step of a long-running, supervised goal per turn and report progress by maintaining your goal's plan.

Your operating contract:
- You work against a single goal whose completion is judged by an OBJECTIVE Grader (tests pass / no diagnostics / reviewer clean / panel approves / plan complete). You do NOT decide when the goal is done — the Grader does. Your job is to make the active plan step genuinely progress toward those criteria.
- Your turn starts with the goal's current plan already loaded (goal, steps, active step). Execute the active step using your normal tools. When a step is genuinely complete, update the plan: mark it \`done\`, set the next step \`active\` — your plan edits are written back to the goal's plan, which is exactly what the Grader reads. If you are stuck, mark the step \`blocked\` with a short note explaining why — never mark a step \`done\` to satisfy the gate.
- You may ONLY update your OWN goal's plan step status. You cannot change the goal or its completion criteria, and you cannot touch another goal's plan. This is enforced by permission and session scope.
- Stay within your tool permissions. Do not attempt to elevate privileges, bypass approvals, or run destructive operations without the normal gates. The loop that drives you enforces hard limits (max ticks / tokens / wallclock) and will stop and escalate to a human on no-progress, over-limit, or critical failure — so be honest about blockers rather than thrashing.
- Attach evidence to completed steps where you can (the command you ran, the test that passed). Ground every "done" in a verifiable fact.

Be focused and incremental: one meaningful step of real progress per turn, reported through the plan, is exactly what the loop needs.`

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("agent"),
  effect: Effect.gen(function* () {
    const agent = yield* AgentV2.Service
    const location = yield* Location.Service
    const worktree = location.directory
    const whitelistedDirs = [TRUNCATION_GLOB, path.join(Global.Path.tmp, "*")]
    const readonlyExternalDirectory: PermissionV2.Ruleset = [
      { action: "external_directory", resource: "*", effect: "ask" },
      ...whitelistedDirs.map(
        (resource): PermissionV2.Rule => ({ action: "external_directory", resource, effect: "allow" }),
      ),
    ]
    const defaults: PermissionV2.Ruleset = [
      { action: "*", resource: "*", effect: "allow" },
      ...readonlyExternalDirectory,
      { action: "question", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ]

    yield* agent.update((editor) => {
      editor.update(AgentV2.defaultID, (item) => {
        item.description = "The default agent. Executes tools based on configured permissions."
        item.system ??= BUILD_SYSTEM
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "question", resource: "*", effect: "allow" },
          ]),
        )
      })

      editor.update(AgentV2.ID.make("plan"), (item) => {
        item.description = "Plan mode. Disallows all edit tools."
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "question", resource: "*", effect: "allow" },
            { action: "external_directory", resource: path.join(Global.Path.data, "plans", "*"), effect: "allow" },
            { action: "edit", resource: "*", effect: "deny" },
            { action: "edit", resource: path.join(".deepagent-code", "plans", "*.md"), effect: "allow" },
            {
              action: "edit",
              resource: path.relative(worktree, path.join(Global.Path.data, "plans", "*.md")),
              effect: "allow",
            },
          ]),
        )
      })

      editor.update(AgentV2.ID.make("general"), (item) => {
        item.description = "General-purpose agent for researching complex questions and executing multi-step tasks."
        item.mode = "subagent"
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "todowrite", resource: "*", effect: "deny" }]))
      })

      editor.update(AgentV2.ID.make("explore"), (item) => {
        item.description =
          'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'
        item.system = PROMPT_EXPLORE
        item.mode = "subagent"
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "webfetch", resource: "*", effect: "allow" },
              { action: "websearch", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
            readonlyExternalDirectory,
          ),
        )
      })

      editor.update(AgentV2.ID.make("researcher"), (item) => {
        item.description = "Read-only agent for evidence-backed research into a specific subsystem."
        item.system = PROMPT_RESEARCHER
        item.mode = "subagent"
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "webfetch", resource: "*", effect: "allow" },
              { action: "websearch", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
              { action: "code_intel", resource: "*", effect: "allow" },
              { action: "context_query", resource: "*", effect: "allow" },
            ],
            readonlyExternalDirectory,
          ),
        )
      })

      // V3.9 §D/§E Goal Loop worker. Mirrors the V1 registry entry
      // (packages/deepagent-code/src/agent/agent.ts "goal-worker"): a working ruleset (read + edit +
      // bash) with `plan: allow` so the worker can maintain its OWN goal's plan step status, and
      // `task: deny` against recursive fan-out. Hidden so it is never a directly selectable agent —
      // the Goal Loop controller drives it by name. Session-scoped `run:<sessionId>` plan-store
      // isolation bounds the plan grant to the worker's own goal.
      editor.update(AgentV2.ID.make("goal-worker"), (item) => {
        item.description =
          "Goal Loop worker (V3.9 §D). A long-running, supervised worker that executes ONE plan step per tick against an objectively-graded goal and maintains its own goal's plan (step status). Read + edit capable; delegates nothing (task denied). Used by the Goal Loop controller, not invoked directly for one-off tasks."
        item.system = PROMPT_GOAL_WORKER
        item.mode = "subagent"
        item.hidden = true
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "read", resource: "*", effect: "allow" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "list", resource: "*", effect: "allow" },
              { action: "edit", resource: "*", effect: "allow" },
              { action: "write", resource: "*", effect: "allow" },
              { action: "patch", resource: "*", effect: "allow" },
              { action: "bash", resource: "*", effect: "allow" },
              { action: "webfetch", resource: "*", effect: "allow" },
              { action: "code_intel", resource: "*", effect: "allow" },
              { action: "context_query", resource: "*", effect: "allow" },
              { action: "plan", resource: "*", effect: "allow" },
              { action: "task", resource: "*", effect: "deny" },
            ],
            readonlyExternalDirectory,
          ),
        )
      })

      editor.update(AgentV2.ID.make("compaction"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_COMPACTION
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      editor.update(AgentV2.ID.make("title"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      editor.update(AgentV2.ID.make("summary"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })
    })
  }),
})
