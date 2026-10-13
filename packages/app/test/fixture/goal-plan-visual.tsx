import { render } from "solid-js/web"
import { AppBaseProviders } from "@/app"
import { PlatformProvider } from "@/context/platform"
import { ServerConnection, ServerProvider } from "@/context/server"
import { useDialog } from "@deepagent-code/ui/context/dialog"
import { Button } from "@deepagent-code/ui/button"
import { GoalPlanEditDialog } from "@/components/deepagent/goal-plan-edit-dialog"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import "@/index.css"

// This entry is served only by the isolated fixture Vite configuration; it uses the
// real editor, portal, SDK, HTTP endpoint and browser IndexedDB with an offline Goal.
const fixture = import.meta.env.VITE_GOAL_FIXTURE as {
  directory: string
  sessionID: string
  goalID: string
  username: string
  password: string
}
const url = window.location.origin
const server: ServerConnection.Http = {
  type: "http",
  http: { url, username: fixture.username, password: fixture.password },
}
const client = createDeepAgentCodeClient({
  baseUrl: url,
  headers: { Authorization: `Basic ${btoa(`${fixture.username}:${fixture.password}`)}` },
})
function Page() {
  const dialog = useDialog()
  return (
    <main class="p-4 flex flex-col gap-3">
      <h1>Goal 计划编辑 · 隔离验收</h1>
      <p>真实本地 API、离线暂停的 Goal、无模型请求</p>
      <Button
        onClick={() =>
          dialog.show(() => (
            <GoalPlanEditDialog
              scope={{
                server: url,
                url,
                directory: fixture.directory,
                sessionID: fixture.sessionID,
                goalID: fixture.goalID,
              }}
              client={client}
              current={() => true}
              onClose={() => dialog.close()}
            />
          ))
        }
      >
        编辑当前计划
      </Button>
    </main>
  )
}
render(
  () => (
    <PlatformProvider
      value={{
        platform: "web",
        openLink() {},
        restart: async () => {},
        back() {},
        forward() {},
        notify: async () => {},
      }}
    >
      <AppBaseProviders locale="zh">
        <ServerProvider defaultServer={ServerConnection.key(server)} servers={[server]}>
          <Page />
        </ServerProvider>
      </AppBaseProviders>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
