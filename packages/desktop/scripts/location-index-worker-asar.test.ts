import { expect, test } from "bun:test"
import type { Stats } from "node:fs"
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Configuration } from "electron-builder"

test("the original ASAR matcher unpacks the actual semantic compiler worker beside the Node sidecar", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dac-index-worker-asar-"))
  try {
    const root = path.join(directory, "workspace")
    await mkdir(root)
    const content = "export const retainedSemantic = 1\n"
    const source = path.join(root, "source.ts")
    await writeFile(source, content)
    const input = {
      root,
      files: [
        {
          path: "source.ts",
          absolutePath: source,
          content,
          mtimeNs: String((await lstat(source, { bigint: true })).mtimeNs),
        },
      ],
    }
    const request = path.join(directory, "request.json")
    await writeFile(request, JSON.stringify(input))
    const output = path.join(directory, "build")
    const build = await Bun.build({
      entrypoints: [
        path.resolve(import.meta.dir, "../../deepagent-code/test/location-index/fixture/typescript-index-packaged.ts"),
        path.resolve(import.meta.dir, "../../deepagent-code/src/location-index/typescript-index.worker.ts"),
      ],
      target: "node",
      outdir: output,
      naming: "[name].[ext]",
      format: "esm",
    })
    expect(build.success).toBe(true)
    if (!build.success) throw new AggregateError(build.logs)
    const original = Bun.spawn(
      [process.env.NODE_BINARY ?? "node", path.join(output, "typescript-index-packaged.js"), request],
      {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const originalOutput = new Response(original.stdout).text()
    const originalError = new Response(original.stderr).text()
    expect(await original.exited, await originalError).toBe(0)
    const expected: unknown = JSON.parse(await originalOutput)
    const app = path.join(directory, "input")
    const chunks = path.join(app, "out/main/chunks")
    await mkdir(chunks, { recursive: true })
    await copyFile(path.join(output, "typescript-index-packaged.js"), path.join(chunks, "node.js"))
    await copyFile(path.join(output, "typescript-index.worker.js"), path.join(chunks, "typescript-index.worker.js"))
    const configuration = createRequire(import.meta.url)("../electron-builder.config").default as Configuration
    const builder = createRequire(createRequire(import.meta.url).resolve("electron-builder"))
    const { getFileMatchers } = builder("app-builder-lib/out/fileMatcher") as {
      getFileMatchers(
        config: Configuration,
        name: "asarUnpack",
        destination: string,
        options: {
          macroExpander: (pattern: string) => string
          customBuildOptions: object
          globalOutDir: string
          defaultSrc: string
        },
      ): Array<{ createFilter(): (file: string, stat: Stats) => boolean }>
    }
    const { AsarPackager } = builder("app-builder-lib/out/asar/asarUtil") as {
      AsarPackager: new (
        packager: { info: { getWorkspaceRoot(): Promise<string> } },
        config: {
          defaultDestination: string
          resourcePath: string
          options: { smartUnpack: false }
          unpackPattern: (file: string, stat: Stats) => boolean
        },
      ) => {
        pack(
          sets: Array<{ src: string; destination: string; files: string[]; metadata: Map<string, Stats> }>,
        ): Promise<void>
      }
    }
    const { statFile } = createRequire(builder.resolve("app-builder-lib"))("@electron/asar") as {
      statFile(archive: string, filename: string): { unpacked?: boolean }
    }
    const files = ["node.js", "typescript-index.worker.js"].map((name) => path.join(chunks, name))
    const metadata = new Map(await Promise.all(files.map(async (file) => [file, await lstat(file)] as const)))
    const patterns = configuration.asarUnpack
    expect(Array.isArray(patterns)).toBe(true)
    if (!Array.isArray(patterns)) throw new Error("The actual package has no ASAR unpack matcher")
    for (const mode of ["before", "after"] as const) {
      const resources = path.join(directory, mode)
      await mkdir(resources)
      const destination = path.join(resources, "app")
      const matcher = getFileMatchers(
        {
          ...configuration,
          asarUnpack:
            mode === "before"
              ? patterns.filter((pattern) => pattern !== "out/main/chunks/typescript-index.worker.js")
              : patterns,
        },
        "asarUnpack",
        destination,
        {
          macroExpander: (pattern) => pattern,
          customBuildOptions: {},
          globalOutDir: resources,
          defaultSrc: app,
        },
      )[0]
      await new AsarPackager(
        { info: { getWorkspaceRoot: async () => app } },
        {
          defaultDestination: destination,
          resourcePath: resources,
          options: { smartUnpack: false },
          unpackPattern: matcher.createFilter(),
        },
      ).pack([{ src: app, destination, files, metadata }])
      const archive = path.join(resources, "app.asar")
      expect(statFile(archive, "out/main/chunks/node.js").unpacked).toBe(true)
      expect(statFile(archive, "out/main/chunks/typescript-index.worker.js").unpacked).toBe(
        mode === "after" ? true : undefined,
      )
      const child = Bun.spawn(
        [process.env.NODE_BINARY ?? "node", path.join(`${archive}.unpacked`, "out/main/chunks/node.js"), request],
        {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const status = await child.exited
      if (mode === "before") {
        expect(status).not.toBe(0)
        expect(await stderr).toContain("Semantic index worker did not complete")
        await stdout
        continue
      }
      expect(status, await stderr).toBe(0)
      expect(JSON.parse(await stdout)).toEqual(expected)
      expect(await readFile(path.join(`${archive}.unpacked`, "out/main/chunks/typescript-index.worker.js"))).toEqual(
        await readFile(path.join(output, "typescript-index.worker.js")),
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
