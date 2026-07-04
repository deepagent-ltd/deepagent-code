import { createSignal, createEffect, Show, For } from "solid-js"
import { useIMClient } from "@/utils/im-client"
import type { IMGroup } from "./types"

interface IMSidebarProps {
  selectedGroupID: string | null
  onSelectGroup: (groupID: string) => void
}

export function IMSidebar(props: IMSidebarProps) {
  const client = useIMClient()
  const [groups, setGroups] = createSignal<IMGroup[]>([])
  const [loading, setLoading] = createSignal(true)
  const [creating, setCreating] = createSignal(false)

  const loadGroups = () => {
    setLoading(true)
    client
      .listGroups()
      .then((data) => {
        setGroups(data)
        setLoading(false)
      })
      .catch((error) => {
        console.error("Failed to load groups:", error)
        setLoading(false)
      })
  }

  createEffect(() => {
    loadGroups()
  })

  const handleCreateGroup = async () => {
    const name = window.prompt("New group name")?.trim()
    if (!name) return
    setCreating(true)
    try {
      const group = await client.createGroup({ name, type: "project" })
      setGroups((prev) => [...prev, group])
      props.onSelectGroup(group.id)
    } catch (error) {
      console.error("Failed to create group:", error)
      alert("Failed to create group")
    } finally {
      setCreating(false)
    }
  }

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="w-64 border-r border-border bg-muted/50 p-4">
          <div class="text-sm text-muted-foreground">Loading groups...</div>
        </div>
      }
    >
      <div class="w-64 border-r border-border bg-muted/50 flex flex-col">
        <div class="p-4 border-b border-border flex items-center justify-between">
          <h2 class="text-lg font-semibold">IM Groups</h2>
          <button
            type="button"
            disabled={creating()}
            onClick={handleCreateGroup}
            title="Create group"
            class="rounded-md px-2 py-1 text-sm text-primary hover:bg-muted disabled:opacity-50"
          >
            +
          </button>
        </div>

        <div class="flex-1 overflow-y-auto">
          <Show
            when={groups().length > 0}
            fallback={
              <div class="p-4 text-sm text-muted-foreground">No groups yet</div>
            }
          >
            <div class="space-y-1 p-2">
              <For each={groups()}>
                {(group) => (
                  <button
                    onClick={() => props.onSelectGroup(group.id)}
                    class={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                      props.selectedGroupID === group.id
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    }`}
                  >
                    <div class="font-medium truncate">{group.name}</div>
                    <div class="text-xs text-muted-foreground truncate">{group.type}</div>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}
