import { createSignal, ErrorBoundary } from "solid-js"
import { IMSidebar } from "@/components/im/im-sidebar"
import { GroupChatPanel } from "@/components/im/group-chat-panel"

export default function IMPage() {
  const [selectedGroupID, setSelectedGroupID] = createSignal<string | null>(null)

  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div class="flex h-screen w-full items-center justify-center bg-background p-6">
          <div class="max-w-md rounded-lg border border-border bg-muted/50 p-6">
            <h2 class="text-lg font-semibold text-destructive">IM 页面发生错误</h2>
            <p class="mt-2 text-sm text-muted-foreground">
              {error instanceof Error ? error.message : String(error)}
            </p>
            <button
              type="button"
              class="mt-4 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
              onClick={reset}
            >
              重试
            </button>
          </div>
        </div>
      )}
    >
      <div class="flex h-screen w-full overflow-hidden bg-background">
        <IMSidebar
          selectedGroupID={selectedGroupID()}
          onSelectGroup={setSelectedGroupID}
        />
        {selectedGroupID() ? (
          <GroupChatPanel groupID={selectedGroupID()!} />
        ) : (
          <div class="flex flex-1 items-center justify-center text-muted-foreground">
            Select a group to start chatting
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}
