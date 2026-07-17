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
      Spec.make("models", {
        description: "List all available models",
        params: {
          provider: Argument.string("provider").pipe(Argument.optional),
          verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
        },
      }),
      Spec.make("run", {
        description: "Run deepagent-code with a message",
        params: {
          message: Argument.string("message").pipe(Argument.variadic),
          model: Flag.string("model").pipe(Flag.withAlias("m"), Flag.optional),
          agent: Flag.string("agent").pipe(Flag.optional),
          format: Flag.string("format").pipe(Flag.withDefault("default")),
          continue: Flag.boolean("continue").pipe(Flag.withAlias("c"), Flag.withDefault(false)),
          session: Flag.string("session").pipe(Flag.withAlias("s"), Flag.optional),
          fork: Flag.boolean("fork").pipe(Flag.withDefault(false)),
          variant: Flag.string("variant").pipe(Flag.optional),
          "dangerously-skip-permissions": Flag.boolean("dangerously-skip-permissions").pipe(Flag.withDefault(false)),
        },
      }),
      Spec.make("export", {
        description: "Export session data as JSON",
        params: {
          sessionID: Argument.string("sessionID").pipe(Argument.optional),
          sanitize: Flag.boolean("sanitize").pipe(Flag.withDefault(false)),
        },
      }),
      Spec.make("stats", {
        description: "Show token usage and cost statistics",
        params: {
          days: Flag.integer("days").pipe(Flag.optional),
          format: Flag.string("format").pipe(Flag.withDefault("table")),
        },
      }),
      Spec.make("import", {
        description: "Import session data from Codex or Claude export",
        params: {
          file: Argument.string("file"),
          source: Flag.string("source").pipe(Flag.withDefault("codex")),
        },
      }),
      Spec.make("session", {
        description: "Manage sessions",
        commands: [
          Spec.make("list", {
            description: "List sessions",
            params: {
              "max-count": Flag.integer("max-count").pipe(Flag.optional),
              format: Flag.string("format").pipe(Flag.withDefault("table")),
            },
          }),
          Spec.make("delete", {
            description: "Delete a session",
            params: { sessionID: Argument.string("sessionID") },
          }),
        ],
      }),
      Spec.make("auth", {
        description: "Manage AI provider credentials",
        commands: [
          Spec.make("login", {
            description: "Log in to a provider",
            params: {
              provider: Argument.string("provider").pipe(Argument.optional),
              key: Flag.string("key").pipe(Flag.optional),
            },
          }),
          Spec.make("list", { description: "List configured credentials" }),
          Spec.make("logout", {
            description: "Log out from a provider",
            params: { provider: Argument.string("provider").pipe(Argument.optional) },
          }),
        ],
      }),
      Spec.make("agent", {
        description: "Manage agents",
        commands: [Spec.make("list", { description: "List all available agents" })],
      }),
      Spec.make("mcp", {
        description: "Manage MCP servers",
        commands: [
          Spec.make("list", { description: "List MCP servers and their status" }),
          Spec.make("add", {
            description: "Add an MCP server",
            params: {
              name: Argument.string("name"),
              url: Flag.string("url").pipe(Flag.optional),
              command: Flag.string("command").pipe(Flag.optional),
              env: Flag.string("env").pipe(Flag.optional),
              header: Flag.string("header").pipe(Flag.optional),
            },
          }),
        ],
      }),
      Spec.make("packs", {
        description: "Manage domain packs",
        params: {
          action: Argument.choice("action", ["list", "pin", "unpin"]),
          packId: Argument.string("packId").pipe(Argument.optional),
        },
      }),
      Spec.make("wiki", {
        description: "Search and browse the project Wiki",
        params: {
          action: Argument.choice("action", ["list", "get", "search"]),
          args: Argument.string("args").pipe(Argument.variadic),
          type: Flag.string("type").pipe(Flag.optional),
          scope: Flag.string("scope").pipe(Flag.optional),
        },
      }),
      Spec.make("review", {
        description: "Review pending DeepAgent knowledge",
        params: {
          action: Argument.choice("action", ["pending", "approve", "reject"]),
          ids: Argument.string("ids").pipe(Argument.variadic),
        },
      }),
      Spec.make("env-facts", {
        description: "Manage environment facts",
        params: {
          action: Argument.choice("action", ["list", "decide"]),
          factId: Argument.string("factId").pipe(Argument.optional),
          decision: Argument.choice("decision", ["adopt", "reject"]).pipe(Argument.optional),
        },
      }),
      Spec.make("goal", {
        description: "Manage Goal Loop for a session",
        params: {
          action: Argument.choice("action", ["start", "status", "pause", "resume", "stop"]),
          sessionID: Argument.string("sessionID"),
          objective: Flag.string("objective").pipe(Flag.optional),
        },
      }),
      Spec.make("panel", {
        description: "Expert Panel status",
        params: {
          action: Argument.choice("action", ["status"]),
          sessionID: Argument.string("sessionID"),
        },
      }),
      Spec.make("attach", {
        description: "Attach to a running deepagent-code server",
        params: {
          url: Argument.string("url"),
          dir: Flag.string("dir").pipe(Flag.optional),
          continue: Flag.boolean("continue").pipe(Flag.withAlias("c"), Flag.withDefault(false)),
          session: Flag.string("session").pipe(Flag.withAlias("s"), Flag.optional),
          fork: Flag.boolean("fork").pipe(Flag.withDefault(false)),
          password: Flag.string("password").pipe(Flag.withAlias("p"), Flag.optional),
          username: Flag.string("username").pipe(Flag.withAlias("u"), Flag.optional),
        },
      }),
      Spec.make("db", {
        description: "Database tools",
        params: {
          query: Argument.string("query").pipe(Argument.optional),
          format: Flag.string("format").pipe(Flag.withDefault("tsv")),
        },
        commands: [Spec.make("path", { description: "Print the database path" })],
      }),
      Spec.make("web", {
        description: "Start server and open web interface",
        params: {
          hostname: Flag.string("hostname").pipe(Flag.withDefault("127.0.0.1")),
          port: Flag.integer("port").pipe(Flag.optional),
          mdns: Flag.boolean("mdns").pipe(Flag.withDefault(false)),
          "mdns-domain": Flag.string("mdns-domain").pipe(Flag.withDefault("deepagent-code.local")),
          cors: Flag.string("cors").pipe(Flag.optional),
        },
      }),
      Spec.make("upgrade", {
        description: "Upgrade deepagent-code to the latest or a specific version",
        params: {
          target: Argument.string("target").pipe(Argument.optional),
          method: Flag.string("method").pipe(Flag.withAlias("m"), Flag.optional),
        },
      }),
      Spec.make("uninstall", {
        description: "Uninstall deepagent-code and remove all related files",
        params: {
          "keep-config": Flag.boolean("keep-config").pipe(Flag.withAlias("c"), Flag.withDefault(false)),
          "keep-data": Flag.boolean("keep-data").pipe(Flag.withAlias("d"), Flag.withDefault(false)),
          "dry-run": Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
          force: Flag.boolean("force").pipe(Flag.withAlias("f"), Flag.withDefault(false)),
        },
      }),
      Spec.make("pr", {
        description: "Fetch and checkout a GitHub PR branch, then run deepagent-code",
        params: { number: Argument.integer("number") },
      }),
      Spec.make("acp", {
        description: "Start ACP (Agent Client Protocol) server",
        params: {
          hostname: Flag.string("hostname").pipe(Flag.withDefault("127.0.0.1")),
          port: Flag.integer("port").pipe(Flag.optional),
        },
      }),
      Spec.make("github", {
        description: "Manage GitHub agent",
        params: {
          action: Argument.choice("action", ["install", "run"]),
          event: Flag.string("event").pipe(Flag.optional),
          token: Flag.string("token").pipe(Flag.optional),
        },
      }),
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
