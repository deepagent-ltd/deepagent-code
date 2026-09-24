import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertReleaseCandidate } from "../../../../script/assert-release-candidate"
import { uploadReleaseAsset } from "../../../../script/upload-release-asset"

test("ID-pinned release upload clobbers, retries a starter asset, and refuses draft drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-release-upload-"))
  const repository = path.join(root, "repo")
  const origin = path.join(root, "origin.git")
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const assets: { id: number; name: string; bytes: Uint8Array; state: string }[] = []
  const requests: { method: string; path: string; contentType?: string; contentLength?: string }[] = []
  let nextID = 200
  let failOnce = false
  let draft = true
  let uploadURLOverride: string | undefined
  let driftOnReleaseRead = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        contentType: request.headers.get("content-type") ?? undefined,
        contentLength: request.headers.get("content-length") ?? undefined,
      })
      if (request.headers.get("authorization") !== "Bearer test-token") return new Response(null, { status: 401 })
      if (request.method === "GET" && url.pathname === "/repos/acme/app/releases/101") {
        if (driftOnReleaseRead > 0 && --driftOnReleaseRead === 0) {
          git(repository, "commit", "--allow-empty", "-m", "drift")
          git(repository, "tag", "-f", "v2.0.2")
          git(repository, "push", "--force", "origin", "refs/tags/v2.0.2")
          git(repository, "reset", "--hard", "HEAD~1")
        }
        return Response.json({
          id: 101,
          tag_name: "v2.0.2",
          draft,
          upload_url: uploadURLOverride ?? `${url.origin}/repos/acme/app/releases/101/assets{?name,label}`,
        })
      }
      if (request.method === "GET" && url.pathname === "/repos/acme/app/releases/101/assets") {
        const page = Number(url.searchParams.get("page"))
        return Response.json(assets.slice((page - 1) * 100, page * 100).map(({ id, name }) => ({ id, name })))
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/repos/acme/app/releases/assets/")) {
        const id = Number(url.pathname.split("/").at(-1))
        const index = assets.findIndex((asset) => asset.id === id)
        if (index < 0) return new Response(null, { status: 404 })
        assets.splice(index, 1)
        return new Response(null, { status: 204 })
      }
      if (request.method === "POST" && url.pathname === "/repos/acme/app/releases/101/assets") {
        const name = url.searchParams.get("name") ?? ""
        const bytes = new Uint8Array(await request.arrayBuffer())
        const asset = { id: nextID++, name, bytes, state: failOnce ? "starter" : "uploaded" }
        assets.push(asset)
        if (failOnce) {
          failOnce = false
          return new Response(null, { status: 502 })
        }
        return Response.json({ id: asset.id, name, size: bytes.byteLength, state: "uploaded" }, { status: 201 })
      }
      return new Response(null, { status: 404 })
    },
  })
  try {
    git(root, "init", "--bare", origin)
    git(root, "init", repository)
    git(repository, "config", "user.email", "test@example.com")
    git(repository, "config", "user.name", "Test")
    await Bun.write(path.join(repository, "candidate.txt"), "candidate")
    git(repository, "add", ".")
    git(repository, "commit", "-m", "candidate")
    const commit = git(repository, "rev-parse", "HEAD")
    const tree = git(repository, "rev-parse", "HEAD^{tree}")
    git(repository, "tag", "v2.0.2")
    git(repository, "remote", "add", "origin", origin)
    git(repository, "push", "origin", "HEAD", "refs/tags/v2.0.2")
    const gh = path.join(root, "gh")
    const view = path.join(root, "view.json")
    await Bun.write(gh, `#!/bin/sh\ncat '${view}'\n`)
    await chmod(gh, 0o755)
    await Bun.write(view, JSON.stringify({ databaseId: 101, isDraft: true, tagName: "v2.0.2" }))
    const file = path.join(root, "owner-authorization.json")
    const checkCandidate = () =>
      assertReleaseCandidate({
        repository,
        commit,
        tree,
        tag: "v2.0.2",
        releaseID: "101",
        releaseRepository: "acme/app",
        ghCommand: gh,
      })
    const input = {
      file,
      releaseID: "101",
      repository: "acme/app",
      tag: "v2.0.2",
      token: "test-token",
      checkCandidate,
      apiBaseURL: server.url.origin,
      uploadOrigin: server.url.origin,
    }

    await Bun.write(file, "first")
    await expect(uploadReleaseAsset(input)).resolves.toBe(200)
    expect(assets).toMatchObject([{ name: "owner-authorization.json", state: "uploaded" }])
    expect(Buffer.from(assets[0]!.bytes).toString()).toBe("first")
    expect(requests.some((request) => request.path.includes("/releases/102/"))).toBe(false)
    expect(requests.find((request) => request.method === "POST")).toMatchObject({
      contentType: "application/octet-stream",
      contentLength: "5",
    })

    await Bun.write(file, "second")
    await expect(uploadReleaseAsset(input)).resolves.toBe(201)
    expect(assets).toHaveLength(1)
    expect(Buffer.from(assets[0]!.bytes).toString()).toBe("second")
    expect(requests.some((request) => request.method === "DELETE" && request.path.endsWith("/200"))).toBe(true)

    failOnce = true
    await expect(uploadReleaseAsset(input)).rejects.toThrow("HTTP 502")
    expect(assets).toMatchObject([{ state: "starter" }])
    await expect(uploadReleaseAsset(input)).resolves.toBe(203)
    expect(assets).toMatchObject([{ state: "uploaded" }])

    const mutations = requests.filter((request) => request.method === "POST" || request.method === "DELETE").length
    await Bun.write(view, JSON.stringify({ databaseId: 102, isDraft: true, tagName: "v2.0.2" }))
    await expect(uploadReleaseAsset(input)).rejects.toThrow("release draft ID changed")
    await Bun.write(view, JSON.stringify({ databaseId: 101, isDraft: true, tagName: "v2.0.2" }))
    draft = false
    await expect(uploadReleaseAsset(input)).rejects.toThrow("release ID, tag or draft state changed")
    draft = true
    uploadURLOverride = "https://wrong.example/repos/acme/app/releases/102/assets{?name,label}"
    await expect(uploadReleaseAsset(input)).rejects.toThrow("upload URL does not belong")
    expect(requests.filter((request) => request.method === "POST" || request.method === "DELETE")).toHaveLength(
      mutations,
    )

    uploadURLOverride = undefined
    driftOnReleaseRead = 2
    const drifted = path.join(root, "ledger.json")
    await Bun.write(drifted, "frozen ledger")
    await expect(uploadReleaseAsset({ ...input, file: drifted })).rejects.toThrow(
      "release tag does not point at candidate commit",
    )
    expect(assets.find((asset) => asset.name === "ledger.json")?.state).toBe("uploaded")
    expect(requests.at(-1)?.path).toContain("/repos/acme/app/releases/101/assets?name=ledger.json")
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
