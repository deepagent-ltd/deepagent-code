import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

declare const DEEPAGENT_CODE_CLI_NAME: string | undefined

export const Commands = Spec.make(
  typeof DEEPAGENT_CODE_CLI_NAME === "string" ? DEEPAGENT_CODE_CLI_NAME : "deepagent-code",
  {
    description: "DeepAgent Code 2.0 preview command line interface",
    params: {
      project: Argument.string("project").pipe(Argument.optional),
      continue: Flag.boolean("continue").pipe(Flag.withAlias("c"), Flag.withDefault(false)),
      session: Flag.string("session").pipe(Flag.withAlias("s"), Flag.optional),
      fork: Flag.boolean("fork").pipe(Flag.withDefault(false)),
      model: Flag.string("model").pipe(Flag.withAlias("m"), Flag.optional),
      agent: Flag.string("agent").pipe(Flag.optional),
      prompt: Flag.string("prompt").pipe(Flag.optional),
    },
    commands: [
      Spec.make("debug", {
        description: "Debugging and troubleshooting tools",
        commands: [Spec.make("agents", { description: "List all agents" })],
      }),
      Spec.make("migrate", { description: "Migrate v1 data to v2" }),
      Spec.make("service", {
        description: "Manage the background server",
        commands: [
          Spec.make("start", { description: "Start the background server" }),
          Spec.make("restart", { description: "Restart the background server" }),
          Spec.make("status", { description: "Show background server status" }),
          Spec.make("stop", { description: "Stop the background server" }),
          Spec.make("password", {
            description: "Get or set the server password",
            params: { value: Argument.string("value").pipe(Argument.optional) },
          }),
        ],
      }),
      Spec.make("serve", {
        description: "Start the deepagent-code server",
        params: {
          hostname: Flag.string("hostname").pipe(Flag.withDefault("127.0.0.1")),
          port: Flag.integer("port").pipe(Flag.optional),
          register: Flag.boolean("register").pipe(Flag.withDefault(false)),
          mdns: Flag.boolean("mdns").pipe(Flag.withDefault(false)),
          "mdns-domain": Flag.string("mdns-domain").pipe(Flag.withDefault("deepagent-code.local")),
          // Comma-separated additional CORS origins, e.g. --cors "http://a:1,http://b:2".
          cors: Flag.string("cors").pipe(Flag.optional),
        },
      }),
    ],
  },
)
