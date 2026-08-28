import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

declare const DEEPAGENT_CODE_CLI_NAME: string | undefined

export const Commands = Spec.make(
  typeof DEEPAGENT_CODE_CLI_NAME === "string" ? DEEPAGENT_CODE_CLI_NAME : "deepagent-code",
  {
    description: "DeepAgent Code 2.0 preview command line interface",
    commands: [
      Spec.make("debug", {
        description: "Debugging and troubleshooting tools",
        commands: [Spec.make("agents", { description: "List all agents" })],
      }),
      Spec.make("login", {
        description: "Log in to a DeepAgent Server gateway (server mode)",
        params: {
          gateway: Argument.string("gateway").pipe(Argument.optional),
          email: Flag.string("email").pipe(Flag.optional),
          password: Flag.string("password").pipe(Flag.optional),
        },
      }),
      Spec.make("logout", { description: "Log out of the DeepAgent Server gateway" }),
      Spec.make("workspace", {
        description: "Manage DeepAgent Server workspaces (server mode)",
        commands: [
          Spec.make("list", { description: "List workspaces on the gateway" }),
          Spec.make("use", {
            description: "Select the workspace to connect to",
            params: { id: Argument.string("id") },
          }),
        ],
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
        description: "Start the v2 API server",
        params: {
          hostname: Flag.string("hostname").pipe(Flag.withDefault("127.0.0.1")),
          port: Flag.integer("port").pipe(Flag.optional),
          register: Flag.boolean("register").pipe(Flag.withDefault(false)),
        },
      }),
    ],
  },
)
