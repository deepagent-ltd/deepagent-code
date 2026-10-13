import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import type { Stats } from "node:fs"
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Configuration } from "electron-builder"

// This integration check consumes original compiler output, never a substitute
// sidecar. The override is a QA input for an already-built isolated cohort.
const directory = path.resolve(
  process.env.DEEPAGENT_CODE_ASAR_FIXTURE_DIRECTORY ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../out/main"),
)

test.skipIf(!existsSync(path.join(directory, "sidecar.js")))(
  "packs the original sidecar adjacent import into its physical ASAR namespace",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dac-sidecar-asar-"))
    try {
      const sidecar = await readFile(path.join(directory, "sidecar.js"))
      const references = Array.from(sidecar.toString("utf8").matchAll(/from\s+["'](\.\/[^"']+\.js)["']/g),
        (match) => match[1])
      expect(references).toHaveLength(1)
      expect(references[0]).toMatch(/^\.\/renderer-origin-[A-Za-z0-9_-]+\.js$/)
      const mainChunks = (await readdir(directory)).filter((name) => /^startup-[A-Za-z0-9_-]+\.js$/.test(name))
      expect(mainChunks).toHaveLength(1)
      const names = ["sidecar.js", path.basename(references[0]), mainChunks[0]]
      const input = path.join(root, "input")
      await mkdir(path.join(input, "out/main"), { recursive: true })
      await Promise.all(names.map((name) => copyFile(path.join(directory, name), path.join(input, "out/main", name))))

      // Use the same matcher and packer as PlatformPackager.copyAppFiles.
      const configuration = createRequire(import.meta.url)("../electron-builder.config").default as Configuration
      const builder = createRequire(createRequire(import.meta.url).resolve("electron-builder"))
      const { getFileMatchers } = builder("app-builder-lib/out/fileMatcher") as {
        getFileMatchers(
          config: Configuration,
          name: "asarUnpack",
          destination: string,
          options: { macroExpander: (pattern: string) => string; customBuildOptions: object; globalOutDir: string; defaultSrc: string },
        ): Array<{ createFilter(): (file: string, stat: Stats) => boolean }>
      }
      const { AsarPackager } = builder("app-builder-lib/out/asar/asarUtil") as {
        AsarPackager: new (
          packager: { info: { getWorkspaceRoot(): Promise<string> } },
          config: { defaultDestination: string; resourcePath: string; options: { smartUnpack: false }; unpackPattern: (file: string, stat: Stats) => boolean },
        ) => { pack(fileSets: Array<{ src: string; destination: string; files: string[]; metadata: Map<string, Stats> }>): Promise<void> }
      }
      const { statFile } = createRequire(builder.resolve("app-builder-lib"))("@electron/asar") as {
        statFile(archive: string, name: string): { unpacked?: boolean }
      }
      const files = names.map((name) => path.join(input, "out/main", name))
      const metadata = new Map(await Promise.all(files.map(async (file) => [file, await lstat(file)] as const)))
      const patterns = configuration.asarUnpack
      expect(Array.isArray(patterns)).toBe(true)
      if (!Array.isArray(patterns)) throw new Error("Expected the original ASAR unpack rules")

      for (const mode of ["before", "after"] as const) {
        const resources = path.join(root, mode)
        await mkdir(resources)
        const destination = path.join(resources, "app")
        const matcher = getFileMatchers({ ...configuration, asarUnpack: mode === "before"
          ? patterns.filter((pattern) => pattern !== "out/main/renderer-origin-*.js")
          : patterns }, "asarUnpack", destination, {
          macroExpander: (pattern) => pattern,
          customBuildOptions: {},
          globalOutDir: resources,
          defaultSrc: input,
        })[0]
        await new AsarPackager({ info: { getWorkspaceRoot: async () => input } }, {
          defaultDestination: destination,
          resourcePath: resources,
          options: { smartUnpack: false },
          unpackPattern: matcher.createFilter(),
        }).pack([{ src: input, destination, files, metadata }])
        const archive = path.join(resources, "app.asar")
        const physical = path.join(`${archive}.unpacked`, "out/main/sidecar.js")
        const resolve = () => createRequire(pathToFileURL(physical)).resolve(references[0])
        expect(await readFile(physical)).toEqual(sidecar)
        expect(statFile(archive, "out/main/sidecar.js").unpacked).toBe(true)
        expect(statFile(archive, `out/main/${mainChunks[0]}`).unpacked).not.toBe(true)
        expect(existsSync(path.join(`${archive}.unpacked`, "out/main", mainChunks[0]))).toBe(false)
        if (mode === "before") {
          expect(resolve).toThrow("Cannot find module")
          expect(statFile(archive, `out/main/${names[1]}`).unpacked).not.toBe(true)
          continue
        }
        expect(resolve()).toBe(path.join(`${archive}.unpacked`, "out/main", names[1]))
        expect(statFile(archive, `out/main/${names[1]}`).unpacked).toBe(true)
        expect(await readFile(resolve())).toEqual(await readFile(path.join(directory, names[1])))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
