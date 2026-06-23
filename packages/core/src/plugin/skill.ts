/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { Effect } from "effect"
import { PluginV2 } from "../plugin"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-deepagent-code.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("skill"),
  effect: Effect.gen(function* () {
    const skill = yield* SkillV2.Service
    const transform = yield* skill.transform()

    yield* transform((editor) => {
      editor.source(
        new SkillV2.EmbeddedSource({
          type: "embedded",
          skill: new SkillV2.Info({
            name: "customize-deepagent-code",
            description:
              "Use ONLY when the user is editing or creating deepagent-code's own configuration: deepagent-code.json, deepagent-code.jsonc, files under .deepagent-code/, or files under ~/.config/deepagent-code/. Also use when creating or fixing deepagent-code agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring deepagent-code itself.",
            location: AbsolutePath.make("/builtin/customize-deepagent-code.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
    })
  }),
})
