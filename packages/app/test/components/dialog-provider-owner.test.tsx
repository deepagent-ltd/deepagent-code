import { afterEach, expect, it } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createContext, useContext } from "solid-js"
import { DialogProvider, useDialog } from "@deepagent-code/ui/context/dialog"

afterEach(cleanup)

const FileScope = createContext("outside-project")

function Probe(props: { name: string }) {
  return <output data-testid={props.name}>{useContext(FileScope)}</output>
}

function fixture() {
  const access: Partial<Record<"settings" | "project", ReturnType<typeof useDialog>>> = {}
  const Capture = (props: { name: "settings" | "project" }) => {
    access[props.name] = useDialog()
    return null
  }
  const mounted = render(() => (
    <DialogProvider>
      <Capture name="settings" />
      <FileScope.Provider value="current-project">
        <Capture name="project" />
      </FileScope.Provider>
    </DialogProvider>
  ))
  const settings = access.settings
  const project = access.project
  if (!settings || !project) throw new Error("Dialog fixture did not mount its callers")
  return { settings, project, unmount: mounted.unmount }
}

it("show during the settings close animation inherits the project caller's context", async () => {
  const api = fixture()
  await api.settings.show(() => <Probe name="settings-dialog" />)
  expect(screen.getByTestId("settings-dialog").textContent).toBe("outside-project")
  api.settings.close()
  expect(api.project.active).toBeUndefined()
  await api.project.show(() => <Probe name="file-dialog" />)
  expect(screen.getByTestId("file-dialog").textContent).toBe("current-project")
  expect(screen.queryByTestId("settings-dialog")).toBeNull()
})

it("push during the final close animation also uses the live caller's context", async () => {
  const api = fixture()
  await api.settings.show(() => <Probe name="settings-dialog" />)
  api.settings.close()
  await api.project.push(() => <Probe name="pushed-file-dialog" />)
  expect(screen.getByTestId("pushed-file-dialog").textContent).toBe("current-project")
  expect(screen.queryByTestId("settings-dialog")).toBeNull()
})

it("a live parent still supplies context when replacing its closing nested dialog", async () => {
  const api = fixture()
  await api.settings.show(() => <Probe name="parent-dialog" />)
  await api.project.push(() => <Probe name="nested-dialog" />)
  expect(screen.getByTestId("nested-dialog").textContent).toBe("outside-project")
  api.project.close()
  expect(api.project.active).toBeDefined()
  await api.project.push(() => <Probe name="next-dialog" />)
  expect(screen.getByTestId("next-dialog").textContent).toBe("outside-project")
  expect(screen.getByTestId("parent-dialog").textContent).toBe("outside-project")
  expect(screen.queryByTestId("nested-dialog")).toBeNull()
})

it("disposing the provider removes active and closing portal roots", async () => {
  const api = fixture()
  await api.settings.show(() => <Probe name="disposed-parent" />)
  await api.project.push(() => <Probe name="disposed-child" />)
  api.project.close()
  api.unmount()
  expect(screen.queryByTestId("disposed-parent")).toBeNull()
  expect(screen.queryByTestId("disposed-child")).toBeNull()
})
