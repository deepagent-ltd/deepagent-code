import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@deepagent-code/core/config"
import { ConfigSkillPlugin } from "@deepagent-code/core/config/plugin/skill"
import { Global } from "@deepagent-code/core/global"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SkillV2 } from "@deepagent-code/core/skill"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigSkillPlugin.Plugin", () => {
  it.effect("registers configured skill directories and URLs", () =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make("/repo/packages/app")
      const sources: SkillV2.Source[] = []
      const transform = Effect.fnUntraced(function* () {
        return Effect.fnUntraced(function* (update: (editor: SkillV2.Editor) => void) {
          update({
            source: (source) => sources.push(source),
            list: () => sources,
          })
        })
      })

      yield* ConfigSkillPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.deepagent-code") }),
                new Config.Document({
                  type: "document",
                  info: decode({
                    skills: ["./skills", "~/shared-skills", "/opt/skills", "https://example.test/skills/"],
                  }),
                }),
              ]),
          }),
        ),
        Effect.provideService(Global.Service, Global.Service.of(Global.make({ home: "/home/test" }))),
        Effect.provideService(Location.Service, Location.Service.of(location({ directory }))),
        Effect.provideService(
          SkillV2.Service,
          SkillV2.Service.of({
            transform,
            sources: () => Effect.succeed(sources),
            list: () => Effect.succeed([]),
          }),
        ),
      )

      expect(sources).toEqual([
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.deepagent-code", "skill")),
        }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.deepagent-code", "skills")),
        }),
        new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        new SkillV2.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "shared-skills")),
        }),
        new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make("/opt/skills") }),
        new SkillV2.UrlSource({ type: "url", url: "https://example.test/skills/" }),
      ])
    }),
  )
})
