import { describe, expect, test } from "bun:test"
import {
  formatAssistantHeader,
  formatMessage,
  formatPart,
  formatTranscript,
  transcriptFilename,
} from "../src/transcript"
import type { AssistantMessage, Part, Provider, UserMessage } from "../src/gen/types.gen"

const providers: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    source: "api",
    env: [],
    options: {},
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        providerID: "anthropic",
        api: {
          id: "claude-sonnet-4-20250514",
          url: "https://example.com/claude-sonnet-4-20250514",
          npm: "@ai-sdk/anthropic",
        },
        name: "Claude Sonnet 4",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: true,
            video: false,
            pdf: true,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        cost: {
          input: 0,
          output: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        limit: {
          context: 200_000,
          output: 8_192,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2025-05-14",
      },
    },
  },
]

const assistantMsg: AssistantMessage = {
  id: "msg_123",
  sessionID: "ses_123",
  role: "assistant",
  agent: "build",
  modelID: "claude-sonnet-4-20250514",
  providerID: "anthropic",
  mode: "",
  parentID: "msg_parent",
  path: { cwd: "/test", root: "/test" },
  cost: 0.001,
  tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1000000, completed: 1005400 },
}

const userMsg: UserMessage = {
  id: "msg_123",
  sessionID: "ses_123",
  role: "user",
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
  time: { created: 1000000 },
}

const options = { thinking: true, toolDetails: true, assistantMetadata: true }

const base = <T extends Part["type"]>(type: T) => ({
  id: "part_1",
  sessionID: "ses_123",
  messageID: "msg_123",
  type,
})

describe("transcript", () => {
  describe("formatAssistantHeader", () => {
    test("includes metadata when enabled", () => {
      const result = formatAssistantHeader(assistantMsg, { assistantMetadata: true, timestamps: false })
      expect(result).toBe("## Assistant (Build · claude-sonnet-4-20250514 · 5.4s)\n\n")
    })

    test("uses model display name when available", () => {
      const result = formatAssistantHeader(assistantMsg, { assistantMetadata: true, timestamps: false }, providers)
      expect(result).toBe("## Assistant (Build · Claude Sonnet 4 · 5.4s)\n\n")
    })

    test("excludes metadata when disabled", () => {
      const result = formatAssistantHeader(assistantMsg, { assistantMetadata: false, timestamps: false })
      expect(result).toBe("## Assistant\n\n")
    })

    test("handles missing completed time", () => {
      const msg = { ...assistantMsg, time: { created: 1000000 } }
      const result = formatAssistantHeader(msg as AssistantMessage, { assistantMetadata: true, timestamps: false })
      expect(result).toBe("## Assistant (Build · claude-sonnet-4-20250514)\n\n")
    })

    test("titlecases agent name", () => {
      const msg = { ...assistantMsg, agent: "plan" }
      const result = formatAssistantHeader(msg, { assistantMetadata: true, timestamps: false })
      expect(result).toContain("Plan")
    })

    test("prepends a local ISO timestamp by default", () => {
      const result = formatAssistantHeader(assistantMsg, { assistantMetadata: true })
      expect(result).toMatch(
        /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} — Assistant \(Build · claude-sonnet-4-20250514 · 5\.4s\)\n\n$/,
      )
    })
  })

  describe("formatPart", () => {
    test("formats text part", () => {
      const part: Part = { ...base("text"), text: "Hello world" }
      const result = formatPart(part, options)
      expect(result).toBe("Hello world\n\n")
    })

    test("skips synthetic text parts", () => {
      const part: Part = { ...base("text"), text: "Synthetic content", synthetic: true }
      const result = formatPart(part, options)
      expect(result).toBe("")
    })

    test("formats reasoning when thinking enabled", () => {
      const part: Part = { ...base("reasoning"), text: "Let me think...", time: { start: 1000 } }
      const result = formatPart(part, options)
      expect(result).toBe("_Thinking:_\n\nLet me think...\n\n")
    })

    test("skips reasoning when thinking disabled", () => {
      const part: Part = { ...base("reasoning"), text: "Let me think...", time: { start: 1000 } }
      const result = formatPart(part, { ...options, thinking: false })
      expect(result).toBe("")
    })

    test("formats tool part with details", () => {
      const part: Part = {
        ...base("tool"),
        callID: "call_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "file1.txt\nfile2.txt",
          title: "List files",
          metadata: {},
          time: { start: 1000, end: 1100 },
        },
      }
      const result = formatPart(part, options)
      expect(result).toContain("**Tool: bash**")
      expect(result).toContain("**Input:**")
      expect(result).toContain('"command": "ls"')
      expect(result).toContain("**Output:**")
      expect(result).toContain("file1.txt")
    })

    test("formats tool output containing triple backticks without breaking markdown", () => {
      const part: Part = {
        ...base("tool"),
        callID: "call_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo '```hello```'" },
          output: "```hello```",
          title: "Echo backticks",
          metadata: {},
          time: { start: 1000, end: 1100 },
        },
      }
      const result = formatPart(part, options)
      // The tool header should not be inside a code block
      expect(result).toStartWith("**Tool: bash**\n")
      // Input and output should each be in their own code blocks
      expect(result).toContain("**Input:**\n```json")
      expect(result).toContain("**Output:**\n```\n```hello```\n```")
    })

    test("formats tool part without details when disabled", () => {
      const part: Part = {
        ...base("tool"),
        callID: "call_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls" },
          output: "file1.txt",
          title: "List files",
          metadata: {},
          time: { start: 1000, end: 1100 },
        },
      }
      const result = formatPart(part, { ...options, toolDetails: false })
      expect(result).toContain("**Tool: bash**")
      expect(result).not.toContain("**Input:**")
      expect(result).not.toContain("**Output:**")
    })

    test("formats tool error", () => {
      const part: Part = {
        ...base("tool"),
        callID: "call_1",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "invalid" },
          error: "Command failed",
          time: { start: 1000, end: 1100 },
        },
      }
      const result = formatPart(part, options)
      expect(result).toContain("**Error:**")
      expect(result).toContain("Command failed")
    })

    test("formats file part with filename and mime", () => {
      const part: Part = { ...base("file"), mime: "text/plain", filename: "notes.txt", url: "file:///test/notes.txt" }
      const result = formatPart(part, options)
      expect(result).toBe("**File: `notes.txt`** _(text/plain)_\n\n")
    })

    test("formats file part from source path when filename is missing", () => {
      const part: Part = {
        ...base("file"),
        mime: "text/typescript",
        url: "file:///test/index.ts",
        source: {
          type: "file",
          path: "src/index.ts",
          text: { value: "src/index.ts", start: 0, end: 12 },
        },
      }
      const result = formatPart(part, options)
      expect(result).toBe("**File: `src/index.ts`** _(text/typescript)_\n\n")
    })

    test("skips synthetic file parts", () => {
      const part: Part = { ...base("file"), mime: "text/plain", filename: "notes.txt", url: "file:///x", synthetic: true }
      const result = formatPart(part, options)
      expect(result).toBe("")
    })

    test("formats patch part with changed file list", () => {
      const part: Part = {
        ...base("patch"),
        hash: "a1b2c3d4e5f6",
        files: ["src/a.ts", "src/b.ts"],
      }
      const result = formatPart(part, options)
      expect(result).toBe("**Patch `a1b2c3d4` — 2 files changed**\n\n- `src/a.ts`\n- `src/b.ts`\n\n")
    })

    test("formats patch part singular file", () => {
      const part: Part = { ...base("patch"), hash: "00ff00ff", files: ["src/only.ts"] }
      const result = formatPart(part, options)
      expect(result).toContain("1 file changed")
      expect(result).toContain("- `src/only.ts`")
    })

    test("formats subtask part as nested section with agent type", () => {
      const part: Part = {
        ...base("subtask"),
        prompt: "Find all usages of formatTranscript",
        description: "Locate formatter usages",
        agent: "explore",
      }
      const result = formatPart(part, options)
      expect(result).toBe(
        "### Subtask: Locate formatter usages\n\n**Agent:** `explore`\n\nFind all usages of formatTranscript\n\n",
      )
    })

    test("formats subtask part with command", () => {
      const part: Part = {
        ...base("subtask"),
        prompt: "Review the diff",
        description: "Review changes",
        agent: "review",
        command: "/review",
      }
      const result = formatPart(part, options)
      expect(result).toContain("**Agent:** `review` · **Command:** `/review`")
    })

    test("formats compaction part as a visible checkpoint block", () => {
      const part: Part = { ...base("compaction"), auto: false, context_tokens: 4000 }
      const result = formatPart(part, options)
      expect(result).toContain("**Context compaction checkpoint**")
      expect(result).toContain("manual")
      expect(result).toContain("~4000 context tokens")
    })

    test("formats auto compaction with overflow", () => {
      const part: Part = { ...base("compaction"), auto: true, overflow: true }
      const result = formatPart(part, options)
      expect(result).toContain("(auto · triggered by context overflow)")
    })
  })

  describe("formatMessage", () => {
    test("formats user message", () => {
      const parts: Part[] = [{ ...base("text"), text: "Hello" }]
      const result = formatMessage(userMsg, parts, { ...options, timestamps: false })
      expect(result).toContain("## User")
      expect(result).toContain("Hello")
    })

    test("prepends a timestamp to the user header by default", () => {
      const result = formatMessage(userMsg, [], options)
      expect(result).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} — User\n\n$/)
    })

    test("formats assistant message with metadata", () => {
      const parts: Part[] = [{ ...base("text"), text: "Hi there" }]
      const result = formatMessage(assistantMsg, parts, { ...options, providers, timestamps: false })
      expect(result).toContain("## Assistant (Build · Claude Sonnet 4 · 5.4s)")
      expect(result).toContain("Hi there")
    })
  })

  describe("formatTranscript", () => {
    const session = {
      id: "ses_abc123",
      title: "Test Session",
      time: { created: 1000000000000, updated: 1000000001000 },
    }

    test("formats complete transcript", () => {
      const messages = [
        {
          info: { ...userMsg, id: "msg_1", sessionID: "ses_abc123", time: { created: 1000000000000 } },
          parts: [{ ...base("text"), messageID: "msg_1", text: "Hello" }] as Part[],
        },
        {
          info: { ...assistantMsg, id: "msg_2", sessionID: "ses_abc123", time: { created: 1000000000100, completed: 1000000000600 } },
          parts: [{ ...base("text"), messageID: "msg_2", text: "Hi!" }] as Part[],
        },
      ]

      const result = formatTranscript(session, messages, {
        thinking: false,
        toolDetails: false,
        assistantMetadata: true,
        timestamps: false,
        providers,
      })

      expect(result).toContain("# Test Session")
      expect(result).toContain("**Session ID:** ses_abc123")
      expect(result).toContain("## User")
      expect(result).toContain("Hello")
      expect(result).toContain("## Assistant (Build · Claude Sonnet 4 · 0.5s)")
      expect(result).toContain("Hi!")
      expect(result).toContain("---")
    })

    test("falls back to raw model id when provider data is missing", () => {
      const messages = [
        {
          info: {
            ...assistantMsg,
            id: "msg_1",
            sessionID: "ses_abc123",
            time: { created: 1000000000100, completed: 1000000000600 },
          },
          parts: [{ ...base("text"), messageID: "msg_1", text: "Response" }] as Part[],
        },
      ]

      const result = formatTranscript(session, messages, {
        thinking: false,
        toolDetails: false,
        assistantMetadata: true,
        timestamps: false,
      })

      expect(result).toContain("## Assistant (Build · claude-sonnet-4-20250514 · 0.5s)")
    })

    test("formats transcript without assistant metadata", () => {
      const messages = [
        {
          info: { ...assistantMsg, id: "msg_1", sessionID: "ses_abc123" },
          parts: [{ ...base("text"), messageID: "msg_1", text: "Response" }] as Part[],
        },
      ]

      const result = formatTranscript(session, messages, {
        thinking: false,
        toolDetails: false,
        assistantMetadata: false,
        timestamps: false,
      })

      expect(result).toContain("## Assistant\n\n")
      expect(result).not.toContain("Build")
      expect(result).not.toContain("claude-sonnet-4-20250514")
    })

    test("renders every enhanced part type without dropping sections", () => {
      const messages = [
        {
          info: { ...userMsg, id: "msg_1", sessionID: "ses_abc123" },
          parts: [
            { ...base("text"), messageID: "msg_1", text: "Here is the file" },
            { ...base("file"), messageID: "msg_1", mime: "image/png", filename: "shot.png", url: "file:///shot.png" },
            { ...base("compaction"), messageID: "msg_1", auto: true },
          ] as Part[],
        },
        {
          info: { ...assistantMsg, id: "msg_2", sessionID: "ses_abc123" },
          parts: [
            { ...base("patch"), messageID: "msg_2", hash: "deadbeef00", files: ["src/a.ts"] },
            { ...base("subtask"), messageID: "msg_2", prompt: "Do the thing", description: "Thing runner", agent: "build" },
          ] as Part[],
        },
      ]

      const result = formatTranscript(session, messages, { ...options, timestamps: false })

      expect(result).toContain("**File: `shot.png`** _(image/png)_")
      expect(result).toContain("**Context compaction checkpoint**")
      expect(result).toContain("**Patch `deadbeef` — 1 file changed**")
      expect(result).toContain("### Subtask: Thing runner")
    })
  })

  describe("transcriptFilename", () => {
    const created = new Date(2026, 8, 21, 12, 0, 0).getTime()

    test("slugifies the session title and appends the creation date", () => {
      const name = transcriptFilename({ id: "ses_abc123", title: "Fix: Project Switch Freeze!", time: { created } })
      expect(name).toBe("fix-project-switch-freeze-2026-09-21.md")
    })

    test("keeps non-latin letters in the slug", () => {
      const name = transcriptFilename({ id: "ses_abc123", title: "修复 冻结 问题", time: { created } })
      expect(name).toBe("修复-冻结-问题-2026-09-21.md")
    })

    test("falls back to the session id when untitled", () => {
      const name = transcriptFilename({ id: "ses_abc123", title: "", time: { created } })
      expect(name).toBe("session-ses_abc123-2026-09-21.md")
    })

    test("falls back to the session id when title slugifies to nothing", () => {
      const name = transcriptFilename({ id: "ses_abc123", title: "!!!", time: { created } })
      expect(name).toBe("session-ses_abc123-2026-09-21.md")
    })

    test("caps the slug length", () => {
      const name = transcriptFilename({ id: "ses_abc123", title: "a".repeat(200), time: { created } })
      expect(name.length).toBeLessThanOrEqual(60 + "-2026-09-21.md".length)
    })
  })
})
