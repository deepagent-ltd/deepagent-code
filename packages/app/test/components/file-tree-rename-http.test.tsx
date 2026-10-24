import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { createServer } from "node:http"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import type { FileNode } from "@deepagent-code/sdk"
import FileTree from "@/components/file-tree"
import { resolveTemplate } from "@solid-primitives/i18n"
import { dict } from "@/i18n/zh"

const runtime = vi.hoisted(() => ({
  directory: (): string => "",
  scope: (): string => "",
  nodes: () => [] as FileNode[],
  refreshes: [] as string[],
  toasts: [] as { variant?: string; title: string }[],
}))
vi.mock("@/context/file", () => ({
  useFile: () => ({
    directory: () => runtime.directory(),
    isLocalSidecar: () => true,
    normalize: (value: string) => value,
    tree: {
      state: () => ({ loaded: true, expanded: false }),
      children: () => runtime.nodes(),
      refresh: (value: string) => runtime.refreshes.push(value),
    },
  }),
}))
vi.mock("@/context/server", () => ({ useServer: () => ({ scope: () => runtime.scope() }) }))
vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) =>
      key === "fileTree.deleteConfirm" ? resolveTemplate(dict[key], params) : key,
  }),
}))
vi.mock("@deepagent-code/ui/context/dialog", () => ({ useDialog: () => ({ show: () => {} }) }))
vi.mock("@/utils/toast", () => ({
  showToast: (value: { variant?: string; title: string }) => runtime.toasts.push(value),
}))
afterEach(cleanup)

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dac-rename-once-"))
  await writeFile(path.join(root, "original.txt"), "owned rename marker")
  const [directory, setDirectory] = createSignal(root)
  const [scope, setScope] = createSignal("original-server")
  const [nodes, setNodes] = createSignal<FileNode[]>([
    {
      name: "original.txt",
      path: "original.txt",
      absolute: path.join(root, "original.txt"),
      type: "file",
      ignored: false,
    },
  ])
  const [renaming, setRenaming] = createSignal<string | null>("original.txt")
  runtime.directory = directory
  runtime.scope = scope
  runtime.nodes = nodes
  runtime.refreshes = []
  runtime.toasts = []
  const requests: { directory: string; from: string; to: string }[] = []
  const invocations: { root: string; target: string; name: string }[] = []
  const pending: Promise<unknown>[] = []
  const remove = vi.fn()
  const control = { fail: false, hold: undefined as Promise<void> | undefined }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,x-deepagent-code-directory")
    response.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as (typeof requests)[number]
    requests.push(body)
    await control.hold
    const result = control.fail
      ? { ok: false, path: body.from, error: "locked_by_human" }
      : await rename(body.from, body.to).then(
          () => ({ ok: true, path: body.to }),
          () => ({ ok: false, path: body.from, error: "already_exists" }),
        )
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(result))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing owned HTTP peer")
  const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
  const originalApi = Object.getOwnPropertyDescriptor(window, "api")
  // The production Native bridge is IPC. Only that boundary is adapted to the
  // actual generated SDK + loopback HTTP; the real FileTree/InlineInput run here.
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      fileOps: {
        remove,
        rename: (root: string, target: string, name: string) => {
          invocations.push({ root, target, name })
          const result = client.file
            .rename({
              fileRenameBody: { directory: root, from: target, to: path.join(path.dirname(target), name) },
            })
            .then((result) => result.data)
          pending.push(result)
          return result
        },
      },
    },
  })
  render(() => <FileTree path="" _renaming={renaming} _setRenaming={setRenaming} />)
  return {
    root,
    control,
    invocations,
    requests,
    remove,
    settle: () => Promise.allSettled(pending),
    setDirectory,
    setScope,
    setNodes,
    setRenaming,
    async close() {
      await Promise.allSettled(pending)
      cleanup()
      if (originalApi) Object.defineProperty(window, "api", originalApi)
      if (!originalApi) Reflect.deleteProperty(window, "api")
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

it("renames once when Enter removes the focused editor and its blur follows", async () => {
  const owned = await fixture()
  try {
    const input = screen.getByRole("textbox")
    fireEvent.input(input, { target: { value: "renamed.txt" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    await waitFor(() => expect(runtime.toasts.some((item) => item.title === "fileTree.renamed")).toBe(true))
    expect(owned.invocations).toHaveLength(1)
    expect(owned.requests).toEqual([
      { directory: owned.root, from: path.join(owned.root, "original.txt"), to: path.join(owned.root, "renamed.txt") },
    ])
    expect(await readFile(path.join(owned.root, "renamed.txt"), "utf8")).toBe("owned rename marker")
    expect(runtime.toasts).toEqual([{ variant: "success", title: "fileTree.renamed" }])
    expect(runtime.refreshes).toEqual([""])
  } finally {
    await owned.close()
  }
})

it("permits an explicit retry after a real failed response, without retrying its blur", async () => {
  const owned = await fixture()
  owned.control.fail = true
  try {
    const input = screen.getByRole("textbox")
    fireEvent.input(input, { target: { value: "retry.txt" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.blur(input)
    await waitFor(() => expect(runtime.toasts[0]?.title).toBe("fileTree.renameFailed"))
    expect(owned.invocations).toHaveLength(1)
    expect(await readFile(path.join(owned.root, "original.txt"), "utf8")).toBe("owned rename marker")
    owned.control.fail = false
    owned.setRenaming("original.txt")
    const retry = screen.getByRole("textbox")
    fireEvent.input(retry, { target: { value: "retry.txt" } })
    fireEvent.keyDown(retry, { key: "Enter" })
    fireEvent.blur(retry)
    await waitFor(() => expect(runtime.toasts[1]?.title).toBe("fileTree.renamed"))
    expect(owned.invocations).toHaveLength(2)
    expect(await readFile(path.join(owned.root, "retry.txt"), "utf8")).toBe("owned rename marker")
  } finally {
    await owned.close()
  }
})

it("ignores a completed rename after the same-directory server scope retires", async () => {
  const owned = await fixture()
  const pending = Promise.withResolvers<void>()
  owned.control.hold = pending.promise
  try {
    const input = screen.getByRole("textbox")
    fireEvent.input(input, { target: { value: "retired.txt" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(owned.requests).toHaveLength(1))
    owned.setScope("replacement-server")
    pending.resolve()
    await waitFor(async () =>
      expect(await readFile(path.join(owned.root, "retired.txt"), "utf8")).toBe("owned rename marker"),
    )
    await owned.settle()
    expect(owned.invocations).toHaveLength(1)
    expect(runtime.toasts).toEqual([])
    expect(runtime.refreshes).toEqual([])
  } finally {
    pending.resolve()
    await owned.close()
  }
})

it("shows the actual filename in the delete confirmation and preserves it on Cancel", async () => {
  const owned = await fixture()
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
  try {
    owned.setRenaming(null)
    fireEvent.contextMenu(screen.getByText("original.txt"))
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "common.delete" }), { key: "Enter" })
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledWith("确定要删除“original.txt”吗？")
    expect(confirm.mock.calls[0]?.[0]).not.toContain("{name}")
    expect(owned.remove).not.toHaveBeenCalled()
    expect(owned.requests).toEqual([])
    expect(await readFile(path.join(owned.root, "original.txt"), "utf8")).toBe("owned rename marker")
  } finally {
    await owned.close()
  }
})
