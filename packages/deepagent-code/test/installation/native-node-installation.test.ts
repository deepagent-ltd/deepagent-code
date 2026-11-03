import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { NativeInstallationSchema } from "../../src/installation/native-installation.schema"
import { signNativeNodeArtifact } from "../../script/sign-native-node"
import { buildWindowsNativeBootstrap } from "../../script/build-windows-native-bootstrap"
import { WindowsNativeNodeCohort } from "../fixture/windows-native-node-cohort"

test(
  "sealed Node entry verifies its actual runtime, immutable handles and adjacent assets",
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-native-node-module-")))
    const key = generateKeyPairSync("ed25519")
    const runtimeProbe = Bun.spawn(["node", "-p", "process.execPath"], { stdout: "pipe", stderr: "pipe" })
    const runtimeSource = (await new Response(runtimeProbe.stdout).text()).trim()
    expect(await runtimeProbe.exited).toBe(0)
    // Hosted Linux Node installations can be hard-linked or group-writable. Verify
    // an owned copy with the normal publisher checks; macOS Node may need adjacent dylibs.
    const runtime = process.platform === "linux" ? path.join(root, "node") : await fs.realpath(runtimeSource)
    if (process.platform === "linux") {
      await fs.copyFile(await fs.realpath(runtimeSource), runtime)
      await fs.chmod(runtime, 0o700)
    }
    const repository = path.resolve(import.meta.dir, "../../../..")
    const bootstrap =
      process.platform === "win32"
        ? await buildWindowsNativeBootstrap({
            repository,
            staging: path.join(root, "native-bootstrap"),
            publicKey: key.publicKey,
          })
        : undefined
    if (bootstrap)
      await fs.writeFile(
        path.join(root, "publisher-key.pem"),
        key.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      )
    const fixture = path.join(import.meta.dir, "fixture/native-node-installation-process.ts")
    const source = await fs.readFile(fixture)
    const components = new NativeInstallationSchema.Components({
      schemaVersion: "dac.native-components.v1",
      target: `${process.platform}-${process.arch}`,
      sourceCommit: "a".repeat(40),
      sourceTree: "b".repeat(40),
      components: [
        new NativeInstallationSchema.Component({
          path: "packages/deepagent-code/test/installation/fixture/native-node-installation-process.ts",
          bytes: source.length,
          sha256: createHash("sha256").update(source).digest("hex"),
        }),
        ...(bootstrap ? [bootstrap, ...bootstrap.assets, ...bootstrap.licenses] : []),
      ].toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    })
    const metadata = CanonicalJson.stringify(components)
    const make = async (name: string, sealed = true) => {
      const directory = path.join(root, name)
      await fs.mkdir(directory, { mode: 0o700 })
      const module = path.join(directory, "node.js")
      const build = await Bun.build({
        entrypoints: [fixture],
        target: "node",
        format: "esm",
        conditions: ["node"],
        outdir: directory,
        naming: "node.js",
        define: {
          DEEPAGENT_CODE_NATIVE_RUNTIME_PUBLIC_KEY: JSON.stringify(
            key.publicKey.export({ type: "spki", format: "pem" }).toString(),
          ),
          DEEPAGENT_CODE_NATIVE_COMPONENT_MANIFEST: JSON.stringify(metadata),
          DEEPAGENT_CODE_NATIVE_NODE_ARTIFACT: String(sealed),
        },
      })
      expect(build.success).toBe(true)
      await fs.writeFile(`${module}.native-components.json`, metadata)
      if (bootstrap) {
        const files = [
          "native-image-factory.node",
          "deepagent-work-process-supervisor.exe",
          "bun-command-runtime.exe",
          "ed25519-dalek.LICENSE",
          "curve25519-dalek.LICENSE",
          "NOTICE",
        ]
        await Promise.all(
          files.map((file) =>
            fs.copyFile(path.join(path.dirname(bootstrap.filename), file), path.join(directory, file)),
          ),
        )
        const child = Bun.spawn(
          [
            process.execPath,
            path.join(repository, "packages/deepagent-code/script/sign-native-node.ts"),
            "--module",
            module,
            "--runtime",
            runtime,
            "--key",
            path.join(root, "publisher-key.pem"),
            "--release",
            "private-node-module",
          ],
          {
            cwd: repository,
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code, stdout + stderr).toBe(0)
        const signed = (await Bun.file(`${module}${NativeInstallationSchema.SIDECAR_SUFFIX}`).json()) as Awaited<
          ReturnType<typeof signNativeNodeArtifact>
        >
        return { module, signed }
      }
      const signed = await signNativeNodeArtifact({
        module,
        runtime,
        releaseID: "private-node-module",
        privateKey: key.privateKey,
      })
      return { module, signed }
    }
    const run = async (module: string, mode = "inspect") => {
      const child = Bun.spawn([runtime, module, mode], {
        env: { HOME: root, TMPDIR: root, XDG_DATA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      return {
        code: await child.exited,
        value: JSON.parse(stdout) as {
          ok: boolean
          result?: { cloneRejected: boolean; assets?: string; changed?: boolean; invalidated?: boolean }
          error?: { code: string }
        },
        stderr,
      }
    }
    if (process.platform === "win32") {
      const runner = process.env.RUNNER_TEMP
      if (!runner || path.win32.parse(runner).root.toUpperCase() !== "D:\\")
        throw new Error("Native installation tests require D: scratch space")
      await fs.mkdir(runner, { recursive: true })
    }
    const cohort =
      process.platform === "win32"
        ? await WindowsNativeNodeCohort.build({
            directory: await fs.mkdtemp(path.join(process.env.RUNNER_TEMP!, "dac-native-node-install-")),
            nodeEntry: fixture,
          })
        : undefined
    try {
      const good = cohort ? undefined : await make("good")
      const inspected = cohort ? await cohort.run() : await run(good!.module)
      expect(inspected.code, "stderr" in inspected ? inspected.stderr : "").toBe(0)
      const admitted = "stdout" in inspected ? JSON.parse(inspected.stdout) : inspected.value
      expect(admitted.result?.assets).toBe(path.dirname(cohort?.module ?? good!.module))
      expect(admitted.result?.cloneRejected).toBe(true)
      const unsealed = await make("unsealed", false)
      expect((await run(unsealed.module)).value.error?.code).toBe("NATIVE_INSTALLATION_UNAVAILABLE")
      if (cohort) {
        const wrongRuntime = await WindowsNativeNodeCohort.build({
          directory: await fs.mkdtemp(path.join(process.env.RUNNER_TEMP!, "dac-native-node-runtime-")),
          nodeEntry: fixture,
          tamper: { field: "runtime", sha256: "0".repeat(64) },
        })
        const wrong = await wrongRuntime.run()
        expect(JSON.parse(wrong.stdout).error.code).toBe("NATIVE_BYTES_MISMATCH")
        await wrongRuntime.dispose()
        const changed = await WindowsNativeNodeCohort.build({
          directory: await fs.mkdtemp(path.join(process.env.RUNNER_TEMP!, "dac-native-node-changed-")),
          nodeEntry: fixture,
          tamper: { field: "executable", sha256: "0".repeat(64) },
        })
        const rejected = await changed.run()
        expect(JSON.parse(rejected.stdout).error.code).toBe("NATIVE_BYTES_MISMATCH")
        await changed.dispose()
      } else {
        const wrongRuntime = await make("wrong-runtime")
        const payload = new NativeInstallationSchema.NodePayload({
          ...wrongRuntime.signed.payload,
          runtime: new NativeInstallationSchema.Executable({
            bytes: wrongRuntime.signed.payload.runtime.bytes,
            sha256: "0".repeat(64),
          }),
        })
        await fs.writeFile(
          `${wrongRuntime.module}${NativeInstallationSchema.SIDECAR_SUFFIX}`,
          CanonicalJson.stringify(
            new NativeInstallationSchema.NodeManifest({
              payload,
              signature: sign(null, Buffer.from(CanonicalJson.stringify(payload)), key.privateKey).toString("hex"),
            }),
          ),
        )
        expect((await run(wrongRuntime.module)).value.error?.code).toBe("NATIVE_BYTES_MISMATCH")
        const changed = await make("changed")
        await fs.appendFile(changed.module, "\n// changed before admission\n")
        expect((await run(changed.module)).value.error?.code).toBe("NATIVE_BYTES_MISMATCH")
      }
      const mutated = cohort ? await cohort.run("mutate") : await run((await make("late")).module, "mutate")
      expect(mutated.code, "stderr" in mutated ? mutated.stderr : "").toBe(0)
      const result = "stdout" in mutated ? JSON.parse(mutated.stdout) : mutated.value
      expect(result.result).toEqual(
        cohort
          ? { changed: false, rejected: true, invalidated: false, cloneRejected: true }
          : { changed: true, rejected: false, invalidated: true, cloneRejected: true },
      )
    } finally {
      await cohort?.dispose()
      await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 })
    }
  },
  process.platform === "win32" ? 240_000 : 30_000,
)
