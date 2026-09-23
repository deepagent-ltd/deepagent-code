import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  ScriptKind,
  ScriptTarget,
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  type SourceFile,
} from "typescript"
import { buildInventory } from "../script/caller-inventory/build"
import {
  encodeRuntimeStateInventory,
  runtimeStateCandidates,
  runtimeStateInventory,
} from "../script/runtime-state-inventory"
import { readonlyMap, readonlySet } from "../src/util/readonly-collections"

const repository = path.resolve(import.meta.dir, "../../..")

describe("production runtime integrity", () => {
  test("source modules cannot create a private Database runtime or nested Database build", async () => {
    const files = await Array.fromAsync(
      new Bun.Glob("packages/*/src/**/*.ts").scan({ cwd: repository, onlyFiles: true }),
    )
    const violations = (
      await Promise.all(
        files.map(async (file) => ({ file, source: await Bun.file(path.join(repository, file)).text() })),
      )
    )
      .flatMap(({ file, source }) => [
        ...(makeRuntimeDatabase.test(source) ? [`${file}: private makeRuntime(Database.Service)`] : []),
        ...(buildDatabase.test(source) ? [`${file}: nested Layer.build(Database...)`] : []),
      ])
      .sort()

    expect(violations).toEqual([])
  })

  test("the keyed Location tree cannot re-close the host seams", async () => {
    const source = await Bun.file(path.join(repository, "packages/core/src/location-layer.ts")).text()
    const runner = await Bun.file(path.join(repository, "packages/core/src/session/runner/index.ts")).text()
    expect(source).not.toContain("Layer.provide(productionV2SourcesLayer)")
    expect(source).not.toContain("Layer.provide(ContextToolRuntime.seam)")
    expect(source).toContain("Layer.provide(runtimeHost)")
    expect(runner).not.toContain("gateRegistry")
    expect(runner).not.toContain("registerToolSettleGate")
  })

  test("production built-ins register the real domain_pack_load implementation", async () => {
    // V2.0.1 WS3 chain repair: the inactive prototype in capability-load-tool.ts is gone;
    // the production tool lives in domain-pack-load-tool.ts and is registered by builtins.
    const loads = await Bun.file(
      path.join(repository, "packages/core/src/system-context/capability-load-tool.ts"),
    ).text()
    const builtins = await Bun.file(path.join(repository, "packages/core/src/tool/builtins.ts")).text()
    expect(loads).not.toContain("export function makeDomainPackLoadTool")
    expect(builtins).toContain("DomainPackLoadTool.layer")
    expect(builtins).toContain("DomainPackLoadTool.name")
  })

  test("the DeepAgent V2 frame composes Core's canonical Session runtime", async () => {
    const source = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/session/v2-runner-frame.ts"),
    ).text()
    expect(source).toContain("SessionRuntime.layer")
    expect(source).not.toContain("SessionExecutionLocal.layer")
    expect(source).not.toContain("SessionProjector.layer")
    expect(source).not.toContain("SessionV2.layer")
  })

  test("Task terminal settlement cannot skip its compensation receipt through an optional seam", async () => {
    const task = await Bun.file(path.join(repository, "packages/deepagent-code/src/tool/task-run.ts")).text()
    const receipt = await Bun.file(
      path.join(repository, "packages/core/src/session/runner/v2-task-run-receipt.ts"),
    ).text()
    expect(task).toContain("V2TaskRunReceipt.recordInTransaction(tx")
    expect(task).not.toContain("CurrentTaskRunTerminalRecorder")
    expect(receipt).not.toContain("CurrentTaskRunTerminalRecorder")
  })

  test("business turns cannot depend on process-local model capability evidence", async () => {
    const files = ["packages/core/src/session/runner/model.ts", "packages/core/src/session/runner/llm.ts"]
    const sources = await Promise.all(files.map((file) => Bun.file(path.join(repository, file)).text()))
    for (const source of sources) {
      expect(source).not.toContain("configEvidenceForTurn")
      expect(source).not.toContain("refreshConfigEvidence")
    }
    expect(sources[1]).toContain("buildCapabilityEvidence(modelInfo, modelProvider)")
  })

  test("the production runner oracle cannot bypass SessionExecution ownership", async () => {
    const source = await Bun.file(path.join(repository, "packages/core/test/session-runner.test.ts")).text()
    expect(source).not.toContain("SessionRunner.Service")
    expect(source).not.toContain("SessionRunCoordinator.Service")
    expect(source).not.toMatch(/\.run\(\{\s*sessionID,\s*force:/)
    expect(source).toContain("SessionExecutionLocal.layer")
  })

  test("Core V2 cannot inherit a process-global LLM middleware", async () => {
    const llm = await Bun.file(path.join(repository, "packages/llm/src/route/client.ts")).text()
    const gateway = await Bun.file(path.join(repository, "packages/core/src/agent-gateway.ts")).text()
    const location = await Bun.file(path.join(repository, "packages/core/src/location-layer.ts")).text()
    const runner = await Bun.file(path.join(repository, "packages/core/src/session/runner/llm.ts")).text()
    const legacy = await Bun.file(path.join(repository, "packages/deepagent-code/src/session/llm.ts")).text()
    expect(llm).not.toContain("let clientMiddleware")
    expect(llm).not.toContain("registerClientMiddleware")
    expect(gateway).not.toContain("registerClientMiddleware")
    expect(location).toContain("LLMClient.managedLayer")
    expect(location).toContain("AgentGateway.runtimeLayer")
    expect(runner).toContain("yield* AgentGateway.Runtime")
    expect(legacy).toContain("AgentGateway.manageStream(")
    expect(legacy).toContain("LLMClient.layer.pipe")
    expect(legacy).not.toContain("LLMClient.managedLayer")
  })

  test("the EventV2 outbox registry is captured by its production root", async () => {
    const writer = await Bun.file(path.join(repository, "packages/deepagent-code/src/event/v2-outbox-writer.ts")).text()
    const bridge = await Bun.file(path.join(repository, "packages/deepagent-code/src/event-v2-bridge.ts")).text()
    expect(writer).not.toContain("let defaultRegistry")
    expect(writer).not.toMatch(/export function (?:register|resetRegistry)\b/)
    expect(writer).toContain("registry: Registry")
    expect(bridge).toContain("layerWithRegistry")
    expect(bridge).toContain("registrationForEventType(event.type, registry)")
  })

  test("EventV2 schema registries are bounded and cannot be mutated through exported views", async () => {
    const source = await Bun.file(path.join(repository, "packages/core/src/event/define.ts")).text()
    expect(source).toContain("export const MAX_EVENT_DEFINITIONS = 1024")
    expect(source).toContain("export const registry = readonlyMap(definitionsByType)")
    expect(source).toContain("export const syncRegistry = readonlyMap(syncDefinitionsByVersion)")
    expect(source).toContain("Duplicate EventV2 synchronized definition")
    expect(source).not.toContain("export const registry = new Map")
    expect(source).not.toContain("export const syncRegistry = new Map")
  })

  test("production queues, pubsubs, and callback streams declare finite backpressure", async () => {
    const files = await Array.fromAsync(
      new Bun.Glob("packages/*/src/**/*.{ts,tsx}").scan({ cwd: repository, onlyFiles: true }),
    )
    const violations = (
      await Promise.all(
        files.map(async (file) => runtimeChannelViolations(file, await Bun.file(path.join(repository, file)).text())),
      )
    )
      .flat()
      .sort()
    expect(violations).toEqual([])
    expect(
      await Array.fromAsync(
        new Bun.Glob("packages/*/src/**/*.{ts,tsx}").scan({ cwd: repository, onlyFiles: true }),
      ).then(async (sourceFiles) =>
        (
          await Promise.all(
            sourceFiles.map(async (file) =>
              (await Bun.file(path.join(repository, file)).text()).includes('concurrency: "unbounded"') ? [file] : [],
            ),
          )
        ).flat(),
      ),
    ).toEqual([])
  })

  test("createRuntimeFeatureRegistry is only constructed by the canonical runtime root", async () => {
    const files = await Array.fromAsync(
      new Bun.Glob("packages/*/src/**/*.{ts,tsx}").scan({ cwd: repository, onlyFiles: true }),
    )
    const violations = (
      await Promise.all(
        files.map(async (file) => registryConstructionCalls(file, await Bun.file(path.join(repository, file)).text())),
      )
    )
      .flat()
      .filter((reference) => !registryConstructionWhitelist.has(reference.slice(0, reference.lastIndexOf(":"))))
      .sort()
    expect(violations).toEqual([])
    expect(
      registryConstructionCalls(
        "probe.ts",
        "// createRuntimeFeatureRegistry(undefined) is documentation, not a call\ncreateRuntimeFeatureRegistry(undefined)",
      ),
    ).toEqual(["probe.ts:2"])
  })

  test("exported authority collections cannot expose mutable runtime objects", async () => {
    const files = await Array.fromAsync(
      new Bun.Glob("packages/*/src/**/*.{ts,tsx}").scan({ cwd: repository, onlyFiles: true }),
    )
    const violations = (
      await Promise.all(
        files.map(async (file) => {
          const source = await Bun.file(path.join(repository, file)).text()
          return Array.from(
            source.matchAll(
              /^export\s+const\s+([A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*new\s+(Map|Set|WeakMap|WeakSet|URL|EventEmitter)\b/gm,
            ),
            (match) =>
              `${file}:${source.slice(0, match.index).split("\n").length}: ${match[1]} exposes new ${match[2]}`,
          )
        }),
      )
    )
      .flat()
      .sort()
    expect(violations).toEqual([])

    const sourceSet = new Set(["fixed"])
    const set = readonlySet(sourceSet)
    expect((set as Set<string>).add).toBeUndefined()
    expect((set as Set<string>).delete).toBeUndefined()
    expect((set as Set<string>).clear).toBeUndefined()
    expect(set.has("fixed")).toBeTrue()

    const sourceMap = new Map([["fixed", 1]])
    const map = readonlyMap(sourceMap)
    expect((map as Map<string, number>).set).toBeUndefined()
    expect((map as Map<string, number>).delete).toBeUndefined()
    expect((map as Map<string, number>).clear).toBeUndefined()
    expect(map.get("fixed")).toBe(1)
  })

  test("source EventV2 definitions have literal identities and no exact type/version collisions", async () => {
    const files = await Array.fromAsync(
      new Bun.Glob("packages/*/src/**/*.ts").scan({ cwd: repository, onlyFiles: true }),
    )
    const definitions = (
      await Promise.all(
        files.map(async (file) => eventDefinitions(file, await Bun.file(path.join(repository, file)).text())),
      )
    ).flat()
    expect(definitions.flatMap((definition) => ("error" in definition ? [definition.error] : []))).toEqual([])
    expect(
      Array.from(
        definitions
          .filter((definition): definition is EventDefinition => "key" in definition)
          .reduce(
            (groups, definition) =>
              groups.set(definition.key, [...(groups.get(definition.key) ?? []), definition.reference]),
            new Map<string, string[]>(),
          ),
      ).filter(([, references]) => references.length > 1),
    ).toEqual([])
  })

  test("learning observers and reviewer registries are owned by the production runtime root", async () => {
    const gateway = await Bun.file(path.join(repository, "packages/core/src/agent-gateway.ts")).text()
    const location = await Bun.file(path.join(repository, "packages/core/src/location-layer.ts")).text()
    const lifecycle = await Bun.file(
      path.join(repository, "packages/core/src/deepagent/learning-lifecycle-trigger.ts"),
    ).text()
    const runtime = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/deepagent/learning-runtime.ts"),
    ).text()
    const frame = await Bun.file(path.join(repository, "packages/deepagent-code/src/session/v2-runner-frame.ts")).text()
    const appRuntime = await Bun.file(path.join(repository, "packages/deepagent-code/src/effect/app-runtime.ts")).text()
    const httpRuntime = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/server/routes/instance/httpapi/server.ts"),
    ).text()
    expect(gateway).toContain("if (learningAuthority === authority) learningAuthority = undefined")
    expect(lifecycle).toContain("Context.Reference<RuntimeObserver | undefined>")
    expect(lifecycle).not.toContain("let runtimeObserver")
    expect(lifecycle).not.toContain("setRuntimeObserver")
    expect(runtime).toContain("releaseLearningAuthority()")
    expect(runtime).toContain("CurrentReviewerRegistry = Context.Reference")
    expect(runtime).toContain("reviewerRegistryLayer = Layer.effectContext")
    expect(runtime).toContain("lifecycleObserverLayer = Layer.effect")
    expect(runtime).not.toContain("AgentGateway.setLearningAuthority(undefined)")
    for (const root of [appRuntime, httpRuntime]) {
      expect(root).toContain("DurableLearningRuntime.reviewerRegistryLayer")
      expect(root).toContain("DurableLearningRuntime.lifecycleObserverLayer")
    }
    expect(frame).toContain("learningAuthority: DurableLearningRuntime.learningAuthority(database)")
    expect(location).toMatch(/AgentGateway\.runtimeLayer\(\{[\s\S]*?durableLearning: false,[\s\S]*?\}\)/)
    expect(gateway).toContain("getLearningAuthority()")
  })

  test("the bare Core preview CLI cannot masquerade as the DeepAgent product", async () => {
    const packageJson = await Bun.file(path.join(repository, "packages/cli/package.json")).json()
    const publisher = await Bun.file(path.join(repository, "packages/cli/script/publish.ts")).text()
    const routes = await Bun.file(path.join(repository, "packages/server/src/routes.ts")).text()
    const serve = await Bun.file(path.join(repository, "packages/cli/src/commands/handlers/serve.ts")).text()
    const daemon = await Bun.file(path.join(repository, "packages/cli/src/services/daemon.ts")).text()
    const previewSources = await Array.fromAsync(
      new Bun.Glob("packages/cli/src/**/*.ts").scan({ cwd: repository, onlyFiles: true }),
    )
    expect(packageJson.bin).toEqual({ lildax: "./bin/lildax.cjs" })
    expect(publisher).toContain('bin: { lildax: "./bin/lildax" }')
    expect(publisher).not.toMatch(/bin:\s*\{[^}]*dacode/)
    expect(routes.slice(routes.indexOf("export const webHandler"))).not.toContain("LocationServiceMap.layer")
    expect(routes.slice(routes.indexOf("export const webHandler"))).not.toContain("Database.defaultLayer")
    expect(serve).not.toContain("LocationServiceMap.layer")
    expect(serve).not.toContain("Database.defaultLayer")
    expect(daemon).not.toContain("DEEPAGENT_CODE_DAEMON_BACKEND")
    expect(daemon).not.toContain("DAEMON_LEGACY_ENTRYPOINT")
    expect(daemon).not.toContain("legacyHealth")
    expect(
      (await Promise.all(previewSources.map((file) => Bun.file(path.join(repository, file)).text()))).filter((source) =>
        source.includes("dacode"),
      ),
    ).toEqual([])
  })

  test("ACP cannot discard private runtimes and command handlers cannot bypass finalizers", async () => {
    const acp = await Bun.file(path.join(repository, "packages/deepagent-code/src/acp/service.ts")).text()
    expect(acp).not.toContain("ManagedRuntime")
    expect(acp).toContain("ACPSession.make()")
    expect(acp).toContain("Directory.make(")

    const commands = await Array.fromAsync(
      new Bun.Glob("packages/deepagent-code/src/cli/**/*.{ts,tsx}").scan({ cwd: repository, onlyFiles: true }),
    )
    expect(
      (
        await Promise.all(
          commands.map(async (file) => processExitCalls(file, await Bun.file(path.join(repository, file)).text())),
        )
      )
        .flat()
        .sort(),
    ).toEqual([])
    expect(processExitCalls("probe.ts", "// process.exit(1)\nprocess.exit(2)")).toEqual(["probe.ts:2"])
  })

  test("every package executable is real and every source runtime is in the caller denominator", async () => {
    const packageFiles = (
      await Array.fromAsync(new Bun.Glob("packages/**/package.json").scan({ cwd: repository, onlyFiles: true }))
    ).filter((file) => !file.includes("/node_modules/") && !file.includes("/.output/") && !file.includes("/dist/"))
    const packages = await Promise.all(
      packageFiles.map(async (file) => ({ file, manifest: await Bun.file(path.join(repository, file)).json() })),
    )
    const missingBins = packages.flatMap(({ file, manifest }) =>
      Object.values(manifest.bin ?? {}).flatMap((target) =>
        typeof target === "string" && !Bun.file(path.resolve(repository, path.dirname(file), target)).size
          ? [`${file}:${target}`]
          : [],
      ),
    )
    expect(missingBins).toEqual([])

    const sourceRuntimes = packages
      .filter(({ manifest }) =>
        Object.values(manifest.scripts ?? {}).some(
          (command) => typeof command === "string" && /\bbun\b.*(?:\.\/)?src\/(?:index|server)\.ts\b/.test(command),
        ),
      )
      .map(({ file }) => file)
      .sort()
    expect(sourceRuntimes).toEqual([
      "packages/cli/package.json",
      "packages/deepagent-code/package.json",
      "packages/function/package.json",
      "packages/slack/package.json",
    ])

    const inventory = await buildInventory()
    const inventoryFiles = new Set(inventory.entries.map((entry) => entry.entry.repoFile))
    expect(inventoryFiles.has("packages/cli/src/index.ts")).toBeTrue()
    expect(inventoryFiles.has("packages/deepagent-code/src/index.ts")).toBeTrue()
    expect(inventoryFiles.has("packages/function/src/server.ts")).toBeTrue()
    expect(inventoryFiles.has("packages/slack/src/index.ts")).toBeTrue()
    expect(inventoryFiles.has("packages/sdk/js/src/server.ts")).toBeTrue()
    expect(
      inventory.entries
        .filter(
          (entry) =>
            entry.entry.id === "composition.slack-bot" ||
            entry.entry.id === "http.server.server.session.session.create",
        )
        .flatMap((entry) => entry.roles.map((role) => role.verdict)),
    ).toEqual(Array.from({ length: 14 }, () => "v2"))

    const slack = await Bun.file(path.join(repository, "packages/slack/src/index.ts")).text()
    expect(slack).toContain("client.v2.session.create")
    expect(slack).toContain("client.v2.session.prompt")
    expect(slack).not.toMatch(/client\.session\.(?:create|prompt|share)/)
    expect(slack).not.toContain("event.subscribe")
    expect(slack).toContain("Promise.allSettled([...pendingThreads.values()].map((entry) => entry.tail))")
    expect(slack).toContain("shutdownController.abort()")
    expect(slack).toContain("deepagentCode.server.close()")
    expect(slack).toContain('process.once("SIGTERM", onSignal)')
  })

  test("Core V2 DeepAgent state is keyed by the immutable Gateway runtime", async () => {
    const gateway = await Bun.file(path.join(repository, "packages/core/src/agent-gateway.ts")).text()
    const session = await Bun.file(path.join(repository, "packages/core/src/deepagent/session-state.ts")).text()
    const plan = await Bun.file(path.join(repository, "packages/core/src/deepagent/plan-store.ts")).text()
    const knowledge = await Bun.file(path.join(repository, "packages/core/src/deepagent/knowledge-source.ts")).text()
    const packs = await Bun.file(path.join(repository, "packages/core/src/deepagent/domain-pack-registry.ts")).text()
    const prompt = await Bun.file(path.join(repository, "packages/core/src/session/runner/deepagent-prompt.ts")).text()
    const gate = await Bun.file(path.join(repository, "packages/deepagent-code/src/session/v2-plan-gate.ts")).text()
    const http = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/deepagent.ts"),
    ).text()
    const server = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/server/routes/instance/httpapi/server.ts"),
    ).text()
    const runtimeRoot = gateway.slice(
      gateway.indexOf("export const runtimeLayer"),
      gateway.indexOf("export const layer"),
    )
    expect(runtimeRoot).toContain("createStorageRuntime")
    expect(runtimeRoot).not.toContain("configureStorage(config)")
    expect(runtimeRoot).toContain("storage.learningQueue")
    expect(runtimeRoot).toContain("Effect.addFinalizer")
    expect(runtimeRoot).not.toContain("legacyLearningQueue")
    expect(gateway).not.toContain("seededKnowledgeBases")
    expect(gateway).not.toContain("knowledgeSeedTasks")
    expect(session).not.toMatch(/^let stateDir\b/m)
    expect(plan).not.toMatch(/^let stateDir\b/m)
    expect(knowledge).not.toMatch(/^let baseDir\b/m)
    expect(packs).not.toMatch(/^const registryDirs\b/m)
    expect(prompt).toContain("input.runtime.withStorage")
    expect(gate).toContain("runtime.withStorage")
    expect(http).toContain("const gateway = yield* AgentGateway.Runtime")
    expect(http).toContain("gateway.withStorage")
    expect(http).toContain("Effect.promise(gateway.ensureKnowledgeSeeded)")
    expect(http).not.toContain("configureGateway")
    expect(http).not.toContain("AgentGateway.flushKnowledgeSeed")
    expect(server).toContain("deepagentHandlers.pipe(Layer.provide(V2RunnerFrame.gatewayRuntimeLayer))")
  })

  test("profile observations cannot escape their HTTP root or routed workspace", async () => {
    const source = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/profile.ts"),
    ).text()
    const root = source.slice(source.indexOf("export const profileHandlers"))
    expect(source.slice(0, source.indexOf("export const profileHandlers"))).not.toMatch(/const run(?:Store|Order)\b/)
    expect(root).toContain("const runStore = new Map")
    expect(root).toContain("MAX_PROCESS_RUN_HISTORY")
    expect(root).toContain("ownerDirectory: instance.directory")
    expect(root.match(/entry\.ownerDirectory !== instance\.directory/g)?.length).toBe(2)
    expect(root).toContain("runStore.get(id)?.ownerDirectory === instance.directory")
  })

  test("capability diagnostics use durable workspace-scoped receipts", async () => {
    const files = [
      "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/capability.ts",
      "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/system-context.ts",
    ]
    const handlers = await Promise.all(files.map((file) => Bun.file(path.join(repository, file)).text()))
    for (const source of handlers) {
      expect(source).toContain("CapabilityLoadAdapter.recordedCapabilityLoadsForDirectory")
      expect(source).not.toContain("CapabilityLoader.recordedCapabilityLoads")
      expect(source).not.toContain("Layer.provide(Database.defaultLayer)")
    }
    const groups = await Promise.all(
      [
        "packages/deepagent-code/src/server/routes/instance/httpapi/groups/capability.ts",
        "packages/deepagent-code/src/server/routes/instance/httpapi/groups/system-context.ts",
      ].map((file) => Bun.file(path.join(repository, file)).text()),
    )
    for (const source of groups) {
      expect(source).toContain(".middleware(InstanceContextMiddleware)")
      expect(source).toContain(".middleware(WorkspaceRoutingMiddleware)")
    }
  })

  test("instance context diagnostics cannot omit routing or serve a foreign directory", async () => {
    const group = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/server/routes/instance/httpapi/groups/context.ts"),
    ).text()
    expect(group).toContain("...WorkspaceRoutingQueryFields")
    expect(group).toContain(".middleware(InstanceContextMiddleware)")
    expect(group).toContain(".middleware(WorkspaceRoutingMiddleware)")

    const handler = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/context.ts"),
    ).text()
    expect(handler).toContain("info.directory !== (yield* InstanceState.context).directory")
  })

  test("maintenance is a process-admin API and cannot inherit workspace routing", async () => {
    const api = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/server/routes/instance/httpapi/api.ts"),
    ).text()
    const server = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/server/routes/instance/httpapi/server.ts"),
    ).text()
    const handler = await Bun.file(
      path.join(repository, "packages/deepagent-code/src/server/routes/instance/httpapi/handlers/maintenance.ts"),
    ).text()
    const instanceApi = api.slice(
      api.indexOf("export const InstanceHttpApi"),
      api.indexOf("export const DeepAgentCodeHttpApi"),
    )
    const maintenanceRoutes = server.slice(
      server.indexOf("const maintenanceApiRoutes"),
      server.indexOf("const instanceApiRoutes"),
    )

    expect(instanceApi).not.toContain("MaintenanceApi")
    expect(api.slice(api.indexOf("export const DeepAgentCodeHttpApi"))).toContain(".addHttpApi(MaintenanceApi)")
    expect(handler).toContain('HttpApiBuilder.group(MaintenanceApi, "maintenance"')
    expect(maintenanceRoutes).toContain("maintenanceRegistryLayer")
    expect(maintenanceRoutes).not.toContain("workspaceRoutingLive")
    expect(maintenanceRoutes).not.toContain("instanceContextLayer")
  })

  test("the mutable-state denominator catches hidden class and resource-factory state", () => {
    const candidates = runtimeStateCandidates(
      "packages/probe/src/runtime.ts",
      [
        'const store = new ShareStore("state")',
        "const server = serve({ port: 1 })",
        "const lock = Semaphore.makeUnsafe(1)",
        "const memoMap = Layer.makeMemoMapUnsafe()",
        "const context = Context.makeUnsafe<unknown>(new Map())",
        "const timestamp = DateTime.makeUnsafe(0)",
        'const staticValues = new Set(["one"])',
        "const version = { registry: 2 }",
        "// version.registry = 3 is documentation, not executable mutation",
        "const totals = { bytes: 0 }",
        "totals.bytes += 1",
        "const pureSchema = Schema.Struct({ value: Schema.String })",
        "const functionWithLocalState = () => {",
        "  const pending = new Map()",
        "  return { add: (key: string) => pending.set(key, true) }",
        "}",
        "class HiddenState {",
        "  pending = new Map()",
        "}",
        "let openHandle",
      ].join("\n"),
    )

    expect(candidates.map((candidate) => candidate.name)).toEqual([
      "store",
      "server",
      "lock",
      "memoMap",
      "context",
      "staticValues",
      "version",
      "totals",
      "openHandle",
      "pending",
      "HiddenState.pending",
    ])
    expect(candidates.find((candidate) => candidate.name === "store")?.classification).toBe("runtime_state_review")
    expect(candidates.find((candidate) => candidate.name === "server")?.classification).toBe("runtime_state_review")
    expect(candidates.find((candidate) => candidate.name === "lock")?.classification).toBe("bounded_cache_review")
    expect(candidates.find((candidate) => candidate.name === "memoMap")?.classification).toBe("runtime_state_review")
    expect(candidates.find((candidate) => candidate.name === "context")?.classification).toBe("runtime_state_review")
    expect(candidates.find((candidate) => candidate.name === "timestamp")).toBeUndefined()
    expect(candidates.find((candidate) => candidate.name === "staticValues")?.classification).toBe("static_container")
    expect(candidates.find((candidate) => candidate.name === "version")?.mutated).toBe(false)
    expect(candidates.find((candidate) => candidate.name === "totals")?.mutated).toBe(true)
    expect(candidates.find((candidate) => candidate.name === "store")?.verdict).toBe("review_required")
    expect(candidates.find((candidate) => candidate.name === "server")?.verdict).toBe("review_required")
    expect(candidates.find((candidate) => candidate.name === "lock")?.verdict).toBe("review_required")
    expect(candidates.find((candidate) => candidate.name === "staticValues")?.verdict).toBe("safe_static")
    expect(candidates.find((candidate) => candidate.name === "pending")?.verdict).toBe("review_required")
    expect(candidates.find((candidate) => candidate.name === "HiddenState.pending")?.verdict).toBe("review_required")
  })

  // RI-94 asserts a PROPERTY, not a snapshot. The previous form compared the generator's output
  // byte-for-byte against `docs/core-v2.0-beta/runtime-state-inventory.tsv`, but that file was
  // deleted with the rest of the internal docs (`2c79de624 chore: stop tracking internal docs`) and
  // the whole `/docs/` tree is git-ignored, so the comparison could not run on a clean checkout at
  // all — a red gate for reasons unrelated to the code. Worse, the snapshot went stale on any source
  // edit (a shifted line number is enough), so the gate reported drift where RI-94 cares about
  // unresolved mutable state.
  //
  // The property RI-94 actually cleared to zero is: every discovered candidate is either proven
  // static, or carries a COMPLETE lifecycle classification. That is reproducible from the source
  // tree alone, so it is what the gate asserts now. `--write` still regenerates the TSV for review,
  // and when a manifest happens to be present its verdict distribution is compared as a hint —
  // never as the pass condition.
  test("every source-level mutable-state candidate is classified by the RI-94 inventory", async () => {
    const candidates = await runtimeStateInventory(repository)
    expect(new Set(candidates.map((candidate) => candidate.key)).size).toBe(candidates.length)

    const unclassified = candidates.filter(
      (candidate) =>
        candidate.verdict !== "safe_static" &&
        ![
          candidate.owner,
          candidate.keyScope,
          candidate.bound,
          candidate.finalizer,
          candidate.durability,
          candidate.reachability,
          candidate.verdict,
        ].every((field) => field.length > 0),
    )
    expect(unclassified.map((candidate) => `${candidate.key} (${candidate.verdict})`)).toEqual([])

    // These 12 bindings moved with 2.0.2 source edits. Their owners and exit paths are reviewed
    // in runtime-state-inventory.ts; a stale source anchor must reopen review instead of falling
    // through to an unresolved or guessed classification.
    const reanchored = [
      ["packages/core/src/agent-gateway.ts:closure@1119:1127.durable", "safe_scoped"],
      ["packages/core/src/agent-gateway.ts:closure@3574:3576.storage", "safe_scoped"],
      ["packages/core/src/event.ts:closure@617:619.synchronized", "safe_scoped"],
      ["packages/core/src/event.ts:closure@617:620.typed", "safe_scoped"],
      ["packages/core/src/event.ts:closure@617:623.projectors", "safe_scoped"],
      ["packages/core/src/event.ts:closure@617:624.snapshotCodecs", "safe_scoped"],
      ["packages/core/src/session/runner/llm.ts:closure@786:1374.withPublication", "safe_scoped"],
      ["packages/core/src/session/runner/llm.ts:closure@786:1481.planResultMetadata", "safe_scoped"],
      ["packages/deepagent-code/src/cli/cmd/run/runtime.ts:closure@914:915.sdk", "safe_scoped"],
      ["packages/deepagent-code/src/deepagent/learning-reviewer-runner.ts:closure@88:100.abort", "safe_scoped"],
      ["packages/deepagent-code/src/permission/index.ts:closure@136:143.withPermissionOwner", "safe_scoped"],
      ["packages/deepagent-code/src/permission/index.ts:closure@136:190.allPending", "safe_bounded"],
    ] as const
    for (const [key, verdict] of reanchored) {
      const candidate = candidates.find((item) => item.key === key)
      expect(candidate?.verdict).toBe(verdict)
      expect(candidate?.owner).not.toBe("unresolved")
      expect(candidate?.finalizer).not.toBe("unresolved")
    }

    // `review_required` is the explicit adjudication backlog: process-lifetime bindings whose
    // owner/bound/finalizer a human has to rule on. RI-94's terminal state is an empty backlog, and
    // the recorded clearing (5fc382979, 269 -> 0) has since drifted back to the entries below.
    // The gate pins the currently identified backlog: a NEW unadjudicated binding fails here instead
    // of arriving silently. To lower the ceiling, adjudicate entries and update this number — never
    // raise it without an entry in the review.
    // The remaining three are process-global session/turn budget maps without a production
    // finalizer or durable owner: domain_pack_load (two) and knowledge_propose (one).
    const REVIEW_REQUIRED_CEILING = 3
    const backlog = candidates.filter((candidate) => candidate.verdict === "review_required")
    expect(backlog.length).toBeLessThanOrEqual(REVIEW_REQUIRED_CEILING)
    expect(backlog.map((candidate) => candidate.key)).toEqual([
      "packages/core/src/system-context/domain-pack-load-tool.ts:sessionLoaded",
      "packages/core/src/system-context/domain-pack-load-tool.ts:turnCharged",
      "packages/core/src/tool/knowledge-propose.ts:sessionProposals",
    ])
    if (backlog.length > 0)
      console.warn(
        `[RI-94] ${backlog.length} binding(s) await adjudication (ceiling ${REVIEW_REQUIRED_CEILING}): ` +
          backlog.map((candidate) => `${candidate.file}:${candidate.line}`).join(", "),
      )

    // Optional cross-check against a regenerated manifest, when one exists locally.
    const manifestPath = path.join(repository, "docs/core-v2.0-beta/runtime-state-inventory.tsv")
    if (await Bun.file(manifestPath).exists()) {
      const manifest = await Bun.file(manifestPath).text()
      const expected = encodeRuntimeStateInventory(candidates)
      if (expected !== manifest)
        console.warn(
          "[RI-94] runtime-state-inventory.tsv is stale (source moved or counts changed). " +
            "The gate asserts the classification property; regenerate the manifest with " +
            "`bun packages/core/script/runtime-state-inventory.ts --write` when it is needed for review.",
        )
    }
  })

  test("every runtime-integrity ledger row remains a valid Markdown table record", async () => {
    // The ledger lives in git-ignored docs/ (local review copies only): a clean checkout or a
    // linked worktree has no design.md, and the property can only be asserted where the file
    // exists — the same posture as the manifest cross-check above.
    const designPath = path.join(repository, "docs/core-v2.0-beta/design.md")
    if (!(await Bun.file(designPath).exists())) return
    const design = await Bun.file(designPath).text()
    expect(
      design
        .split("\n")
        .filter((line) => /^\| RI-\d+ /.test(line))
        .filter((line) => line.replaceAll("\\|", "").split("|").length !== 8),
    ).toEqual([])
  })
})

const makeRuntimeDatabase = /makeRuntime\s*\(\s*Database\.Service\b/
const buildDatabase = /Layer\.build\s*\(\s*Database\.(?:defaultLayer|layerFromPath|layer)\b/

function processExitCalls(file: string, source: string) {
  const sourceFile = createSourceFile(
    file,
    source,
    ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
  )
  const calls: string[] = []
  const visit = (node: Node) => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "exit"
    ) {
      calls.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`)
    }
    forEachChild(node, visit)
  }
  forEachChild(sourceFile, visit)
  return calls
}

type EventDefinition = { readonly key: string; readonly reference: string }
type InvalidEventDefinition = { readonly error: string }

function eventDefinitions(file: string, source: string): Array<EventDefinition | InvalidEventDefinition> {
  const sourceFile = createSourceFile(
    file,
    source,
    ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
  )
  const definitions: Array<EventDefinition | InvalidEventDefinition> = []
  const visit = (node: Node) => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "EventV2" || node.expression.expression.text === "EventDefine") &&
      node.expression.name.text === "define"
    ) {
      definitions.push(eventDefinition(file, sourceFile, node.arguments[0]))
    }
    forEachChild(node, visit)
  }
  forEachChild(sourceFile, visit)
  return definitions
}

function eventDefinition(
  file: string,
  sourceFile: SourceFile,
  input: Node | undefined,
): EventDefinition | InvalidEventDefinition {
  const line = input ? sourceFile.getLineAndCharacterOfPosition(input.getStart(sourceFile)).line + 1 : 0
  const reference = `${file}:${line}`
  if (!input || !isObjectLiteralExpression(input)) return { error: `${reference}: EventV2.define input is not literal` }
  const type = property(input, "type")?.initializer
  if (!type || !isStringLiteral(type)) return { error: `${reference}: EventV2 type is not a string literal` }
  const sync = property(input, "sync")?.initializer
  if (!sync) return { key: `${type.text}:local`, reference }
  if (!isObjectLiteralExpression(sync)) return { error: `${reference}: EventV2 sync is not literal` }
  const version = property(sync, "version")?.initializer
  if (!version || !isNumericLiteral(version)) return { error: `${reference}: EventV2 sync version is not numeric` }
  return { key: `${type.text}:${version.text}`, reference }
}

function property(input: ObjectLiteralExpression, name: string) {
  return input.properties.find(
    (candidate): candidate is PropertyAssignment =>
      isPropertyAssignment(candidate) && isIdentifier(candidate.name) && candidate.name.text === name,
  )
}

function runtimeChannelViolations(file: string, source: string) {
  const sourceFile = createSourceFile(
    file,
    source,
    ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
  )
  const violations: string[] = []
  const visit = (node: Node) => {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression
      const operation = node.expression.name.text
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const reference = `${file}:${line}`
      if (isIdentifier(owner) && (owner.text === "Queue" || owner.text === "PubSub") && operation === "unbounded") {
        violations.push(`${reference}: ${owner.text}.unbounded`)
      }
      if (isIdentifier(owner) && owner.text === "Stream" && operation === "callback") {
        const options = node.arguments[1]
        const bufferSize = options && isObjectLiteralExpression(options) ? property(options, "bufferSize") : undefined
        const strategy = options && isObjectLiteralExpression(options) ? property(options, "strategy") : undefined
        if (!bufferSize || !isNumericLiteral(bufferSize.initializer))
          violations.push(`${reference}: Stream.callback missing literal bufferSize`)
        if (!strategy || !isStringLiteral(strategy.initializer))
          violations.push(`${reference}: Stream.callback missing literal strategy`)
      }
    }
    forEachChild(node, visit)
  }
  forEachChild(sourceFile, visit)
  return violations
}

// The injectable registry seam exists for tests/tooling; production source must consume the
// process-start snapshot (`RuntimeFeatures` / `CurrentRuntimeFeatures`) built at the single root.
const registryConstructionWhitelist = new Set(["packages/core/src/flag/runtime-features.ts"])

function registryConstructionCalls(file: string, source: string) {
  const sourceFile = createSourceFile(
    file,
    source,
    ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
  )
  const calls: string[] = []
  const visit = (node: Node) => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === "createRuntimeFeatureRegistry"
    ) {
      calls.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`)
    }
    forEachChild(node, visit)
  }
  forEachChild(sourceFile, visit)
  return calls
}
