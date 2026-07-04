import { Schema } from "effect"

/**
 * Parses @mentions from markdown content, excluding code blocks.
 */
export class MentionParser {
  /**
   * Extract all @AgentName mentions from markdown content.
   * Rules:
   * - Only parse from plain text (not fenced code blocks)
   * - Deduplicate mentions
   * - Preserve order of first occurrence
   */
  static parse(content: string): string[] {
    // Remove fenced code blocks and inline code
    const withoutCode = this.removeCode(content)

    // Extract mentions: @word (alphanumeric, underscore, hyphen)
    const mentionRegex = /@([\w-]+)/g
    const matches = withoutCode.matchAll(mentionRegex)

    const mentions = new Set<string>()
    const ordered: string[] = []

    for (const match of matches) {
      const name = match[1]
      if (!mentions.has(name)) {
        mentions.add(name)
        ordered.push(name)
      }
    }

    return ordered
  }

  /**
   * Remove fenced code blocks (``` ... ``` or ~~~ ... ~~~) and inline code
   * (`...`) from markdown content.
   */
  private static removeCode(content: string): string {
    const codeBlockRegex = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
    const inlineCodeRegex = /`[^`]*`/g
    return content.replace(codeBlockRegex, "").replace(inlineCodeRegex, "")
  }
}

/**
 * Agent descriptor for IM system.
 */
export const AgentDescriptor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  description: Schema.optional(Schema.String),
  visible: Schema.Boolean,
})

export type AgentDescriptor = Schema.Schema.Type<typeof AgentDescriptor>
