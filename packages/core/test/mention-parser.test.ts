import { describe, it, expect } from "bun:test"
import { MentionParser } from "../src/im/mention-parser"

describe("MentionParser", () => {
  it("should parse simple mentions", () => {
    const content = "Hello @CodeAgent, can you help?"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["CodeAgent"])
  })

  it("should parse multiple mentions", () => {
    const content = "@CodeAgent and @ReviewAgent, please help"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["CodeAgent", "ReviewAgent"])
  })

  it("should deduplicate mentions", () => {
    const content = "@CodeAgent said hello. @CodeAgent is great!"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["CodeAgent"])
  })

  it("should preserve order of first occurrence", () => {
    const content = "@AgentA @AgentB @AgentA @AgentC"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["AgentA", "AgentB", "AgentC"])
  })

  it("should exclude mentions in fenced code blocks", () => {
    const content = `
Hello @AgentA

\`\`\`typescript
// This @AgentB should be ignored
const x = "@AgentC"
\`\`\`

But @AgentD should be found
`
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["AgentA", "AgentD"])
  })

  it("should exclude mentions in triple-tilde code blocks", () => {
    const content = `
@AgentA is outside

~~~
@AgentB is inside
~~~

@AgentC is outside
`
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["AgentA", "AgentC"])
  })

  it("should exclude mentions in inline code", () => {
    const content = "Ask @AgentA but ignore `@AgentB` and find @AgentC"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["AgentA", "AgentC"])
  })

  it("should handle mentions with hyphens and underscores", () => {
    const content = "@code-agent and @debug_agent"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["code-agent", "debug_agent"])
  })

  it("should handle empty content", () => {
    const mentions = MentionParser.parse("")
    expect(mentions).toEqual([])
  })

  it("should handle content with no mentions", () => {
    const content = "This is just regular text with no mentions"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual([])
  })

  it("should handle mentions at start and end", () => {
    const content = "@Start some content @End"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["Start", "End"])
  })

  it("should not parse @ without following word", () => {
    const content = "Email me @ work or @ home"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual([])
  })

  it("should handle nested code blocks correctly", () => {
    const content = `
@OuterAgent

\`\`\`markdown
# Example
@InnerAgent in markdown
\`\`\`

@AnotherOuter
`
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["OuterAgent", "AnotherOuter"])
  })

  it("should handle mentions with numbers", () => {
    const content = "@Agent1 and @Agent2Test"
    const mentions = MentionParser.parse(content)
    expect(mentions).toEqual(["Agent1", "Agent2Test"])
  })
})
