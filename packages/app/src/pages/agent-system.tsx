import { For, Show } from "solid-js"
import { useSync } from "@/context/sync"

const statusTone = {
  covered: "bg-icon-success-base",
  planned: "bg-icon-warning-base",
  blocked: "bg-icon-critical-base",
} as const

const connectionTone = {
  connected: "bg-icon-success-base",
  available: "bg-icon-warning-base",
  unavailable: "bg-icon-critical-base",
} as const
type ConnectionStatus = keyof typeof connectionTone

const providerOrder = [
  { id: "openai", label: "OpenAI" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "anthropic", label: "Anthropic" },
] as const

function ValueRow(props: { label: string; value: string }) {
  return (
    <div class="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-2 text-12-regular">
      <div class="text-text-weak">{props.label}</div>
      <div class="min-w-0 truncate font-mono text-text-strong">{props.value || "-"}</div>
    </div>
  )
}

export default function AgentSystem() {
  const sync = useSync()
  const agent = () => sync.data.path.agent
  const directories = () => agent().directories
  const providers = () => sync.data.provider
  const providerRows = () => {
    const connected = new Set(providers().connected)
    return providerOrder.map((provider) => {
      const item = providers().all.get(provider.id)
      const status: ConnectionStatus = connected.has(provider.id) ? "connected" : item ? "available" : "unavailable"
      return { ...provider, status }
    })
  }
  const mcpRows = () =>
    Object.entries(sync.data.mcp ?? {})
      .map(([name, info]) => ({ name, status: info.status }))
      .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div class="h-full min-h-0 overflow-auto bg-background-base">
      <main class="mx-auto flex w-full max-w-[1080px] flex-col gap-5 px-6 py-6">
        <section class="flex flex-wrap items-start justify-between gap-4 border-b border-border-weak-base pb-5">
          <div class="min-w-0">
            <h1 class="text-20-medium text-text-strong">DeepAgent Runtime</h1>
            <div class="mt-2 flex flex-wrap items-center gap-2 text-12-regular text-text-base">
              <span class="rounded-md border border-border-weak-base px-2 py-1">Mode: {agent().mode}</span>
              <span class="rounded-md border border-border-weak-base px-2 py-1">
                Agent mode: {agent().agentMode}
              </span>
              <span class="rounded-md border border-border-weak-base px-2 py-1">
                Knowledge: {agent().knowledgeEnabled ? "enabled" : "disabled"}
              </span>
              <span class="rounded-md border border-border-weak-base px-2 py-1">
                Runtime: {agent().implementation}
              </span>
              <span class="rounded-md border border-border-weak-base px-2 py-1">
                Provider tools: {agent().providerExecutedToolPolicy}
              </span>
            </div>
          </div>
          <div class="grid min-w-[220px] grid-cols-2 gap-2 text-12-regular">
            <div class="rounded-md border border-border-weak-base px-3 py-2">
              <div class="text-text-weak">Runtime mode</div>
              <div class="mt-1 text-14-medium text-text-strong">{agent().agentMode}</div>
            </div>
            <div class="rounded-md border border-border-weak-base px-3 py-2">
              <div class="text-text-weak">Knowledge</div>
              <div class="mt-1 text-14-medium text-text-strong">{agent().knowledgeEnabled ? "enabled" : "disabled"}</div>
            </div>
          </div>
        </section>

        <section class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div class="rounded-md border border-border-weak-base bg-background-strong p-4">
            <h2 class="text-14-medium text-text-strong">Coverage</h2>
            <div class="mt-3 flex flex-col divide-y divide-border-weak-base">
              <For each={agent().coverage}>
                {(item) => (
                  <div class="grid grid-cols-[minmax(0,1fr)_96px] gap-4 py-3">
                    <div class="min-w-0">
                      <div class="truncate text-13-medium text-text-strong">{item.surface}</div>
                      <div class="mt-1 text-12-regular text-text-weak">{item.note}</div>
                    </div>
                    <div class="flex items-center justify-end gap-2 text-12-regular text-text-base">
                      <span class={`size-2 rounded-full ${statusTone[item.status]}`} />
                      <span>{item.status}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="rounded-md border border-border-weak-base bg-background-strong p-4">
            <h2 class="text-14-medium text-text-strong">Model Backends</h2>
            <div class="mt-3 flex flex-col divide-y divide-border-weak-base">
              <For each={providerRows()}>
                {(item) => (
                  <div class="grid grid-cols-[minmax(0,1fr)_96px] gap-4 py-3">
                    <div class="min-w-0 truncate text-13-medium text-text-strong">{item.label}</div>
                    <div class="flex items-center justify-end gap-2 text-12-regular text-text-base">
                      <span class={`size-2 rounded-full ${connectionTone[item.status]}`} />
                      <span>{item.status}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </section>

        <section class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div class="rounded-md border border-border-weak-base bg-background-strong p-4">
            <h2 class="text-14-medium text-text-strong">MCP Servers</h2>
            <div class="mt-3 flex flex-col divide-y divide-border-weak-base">
              <Show
                when={mcpRows().length > 0}
                fallback={<div class="py-3 text-12-regular text-text-weak">No MCP servers configured</div>}
              >
                <For each={mcpRows()}>
                  {(item) => (
                    <div class="grid grid-cols-[minmax(0,1fr)_120px] gap-4 py-3">
                      <div class="min-w-0 truncate text-13-medium text-text-strong">{item.name}</div>
                      <div class="text-right text-12-regular text-text-base">{item.status}</div>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>

          <div class="rounded-md border border-border-weak-base bg-background-strong p-4">
            <h2 class="text-14-medium text-text-strong">Storage</h2>
            <div class="mt-3 divide-y divide-border-weak-base">
              <ValueRow label="data" value={directories().data} />
              <ValueRow label="cache" value={directories().cache} />
              <ValueRow label="state" value={directories().state} />
              <ValueRow label="tmp" value={directories().tmp} />
              <ValueRow label="runs" value={directories().runs} />
              <ValueRow label="artifacts" value={directories().artifacts} />
              <ValueRow label="output" value={directories().output} />
              <ValueRow label="log" value={directories().log} />
            </div>
          </div>
        </section>

        <section class="rounded-md border border-border-weak-base bg-background-strong p-4">
          <h2 class="text-14-medium text-text-strong">Workspace</h2>
          <div class="mt-3 grid gap-x-6 lg:grid-cols-2">
            <ValueRow label="directory" value={sync.data.path.directory} />
            <ValueRow label="worktree" value={sync.data.path.worktree} />
            <ValueRow label="global data" value={sync.data.path.data} />
            <ValueRow label="global cache" value={sync.data.path.cache} />
            <ValueRow label="global state" value={sync.data.path.state} />
            <ValueRow label="global config" value={sync.data.path.config} />
          </div>
          <Show when={!agent().agentManaged}>
            <div class="mt-4 rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-12-regular text-text-weak">
              General mode uses the default runtime path. Model providers remain backend configuration only.
            </div>
          </Show>
          <Show when={agent().agentManaged}>
            <div class="mt-4 rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-12-regular text-text-weak">
              DeepAgent mode is active. Providers supply model access; tool, MCP, session, and approval execution remain
              owned by deepagent-code while DeepAgent writes control-plane artifacts around the model turn.
            </div>
          </Show>
        </section>
      </main>
    </div>
  )
}
