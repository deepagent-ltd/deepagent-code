// Private integration entry only. The ordinary Node entry never imports this module.
// Public construction coordinates are supplied by the fixture producer, never by runtime input.
declare const DEEPAGENT_CODE_OWNED_IM_FIXTURE_PUBLIC_PARAMETERS: string

if (typeof DEEPAGENT_CODE_OWNED_IM_FIXTURE_PUBLIC_PARAMETERS !== "string")
  throw new Error("Owned IM Native fixture requires explicit producer parameters")

// Keep the real Native bootstrap and all public Node exports before composing custody.
const node = await import("../node")
const { Schema } = await import("effect")
const { default: path } = await import("node:path")
const parameters = Schema.decodeUnknownSync(
  Schema.UnknownFromJsonString.pipe(
    Schema.decodeTo(
      Schema.Struct({
        profile: Schema.Literal("dac.owned-im-native-fixture.v1"),
        service: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/)),
        directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
        publicJkt: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
      }),
    ),
  ),
  { onExcessProperty: "error" },
)(DEEPAGENT_CODE_OWNED_IM_FIXTURE_PUBLIC_PARAMETERS)
if (process.platform !== "darwin" || !path.isAbsolute(parameters.directory) || typeof process.getuid !== "function")
  throw new Error("Owned IM Native fixture requires its original local custody")

export const Config = node.Config
export const bootstrap = node.bootstrap
export const runLocalOperator = node.runLocalOperator
export const Log = node.Log
export const Database = node.Database
export const BrowserNativeHost = node.BrowserNativeHost
export const NativeWindowsBootstrap = node.NativeWindowsBootstrap
export const Server = {
  ...node.Server,
  listen: async (options: Parameters<typeof node.Server.listen>[0]) =>
    node.Server.listen({ ...options, imDeviceStore: await existingDeviceLayer() }),
}

async function existingDeviceLayer() {
  const { Layer } = await import("effect")
  const { IMDeviceStore } = await import("../im/device-store")
  const { IMDeviceProof } = await import("../im/device-proof")
  const { SecretStore } = await import("../mcp/secret-store")
  const { lstat, open, realpath } = await import("node:fs/promises")
  const { constants } = await import("node:fs")
  const { userInfo } = await import("node:os")
  const unavailable = () => new IMDeviceStore.Error({ code: "im_device_store_unavailable" })
  const installation = "installation-p256-v1"

  async function requireCustody() {
    const directory = await lstat(parameters.directory, { bigint: true })
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== BigInt(process.getuid!()) ||
      (directory.mode & 0o077n) !== 0n ||
      (await realpath(parameters.directory)) !== parameters.directory
    )
      throw unavailable()
    const filename = path.join(parameters.directory, "identity.json")
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat({ bigint: true })
      if (
        !before.isFile() ||
        before.uid !== directory.uid ||
        (before.mode & 0o022n) !== 0n ||
        before.size < 1n ||
        before.size > 8192n
      )
        throw unavailable()
      const bytes = Buffer.alloc(8193)
      const read = await file.read(bytes, 0, bytes.length, 0)
      if (read.bytesRead > 8192 || read.bytesRead !== Number(before.size)) throw unavailable()
      const marker = Schema.decodeUnknownSync(
        Schema.UnknownFromJsonString.pipe(
          Schema.decodeTo(
            Schema.Struct({
              profile: Schema.Literal(IMDeviceProof.profile),
              jkt: Schema.Literal(parameters.publicJkt),
              publicJwk: Schema.Unknown,
            }),
          ),
        ),
        { onExcessProperty: "error" },
      )(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read.bytesRead)))
      const after = await file.stat({ bigint: true })
      const current = await lstat(filename, { bigint: true })
      if (
        IMDeviceProof.thumbprint(IMDeviceProof.publicJwk(marker.publicJwk)) !== parameters.publicJkt ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        current.dev !== after.dev ||
        current.ino !== after.ino ||
        current.isSymbolicLink()
      )
        throw unavailable()
    } finally {
      await file.close()
    }
  }

  await requireCustody().catch(() => {
    throw unavailable()
  })
  const credential = userInfo()
  if (credential.uid !== process.getuid!() || !path.isAbsolute(credential.homedir)) throw unavailable()
  const home = await lstat(credential.homedir, { bigint: true }).catch(() => {
    throw unavailable()
  })
  if (
    !home.isDirectory() ||
    home.isSymbolicLink() ||
    home.uid !== BigInt(credential.uid) ||
    (await realpath(credential.homedir).catch(() => {
      throw unavailable()
    })) !== credential.homedir
  )
    throw unavailable()
  const native = SecretStore.macOsKeychainBackend(parameters.service, true, { home: credential.homedir })
  if (!(await native.available())) throw unavailable()
  const diagnostic: {
    stage: "before_marker" | "native_get" | "identity_validate" | "after_marker"
    code:
      | "owned_marker_unavailable"
      | "owned_native_read_failed"
      | "owned_installation_missing"
      | "owned_identity_invalid"
      | "owned_identity_mismatch"
  } = { stage: "before_marker", code: "owned_marker_unavailable" }
  const guarded: import("../mcp/secret-store").SecretStore.Backend = {
    id: native.id,
    available: native.available,
    validateScoped: native.validateScoped,
    get: async (account) => {
      if (account !== installation) return native.get(account)
      try {
        diagnostic.stage = "before_marker"
        diagnostic.code = "owned_marker_unavailable"
        await requireCustody()
        diagnostic.stage = "native_get"
        diagnostic.code = "owned_native_read_failed"
        const saved = await native.get(account)
        // Missing or changed custody must never reach make().identity's creation branch.
        diagnostic.stage = "identity_validate"
        diagnostic.code = "owned_installation_missing"
        if (!saved) throw unavailable()
        diagnostic.code = "owned_identity_invalid"
        const identity = IMDeviceProof.identity(saved)
        diagnostic.code = "owned_identity_mismatch"
        if (identity.jkt !== parameters.publicJkt) throw unavailable()
        diagnostic.stage = "after_marker"
        diagnostic.code = "owned_marker_unavailable"
        await requireCustody()
        return saved
      } catch {
        // Neither malformed native material nor parser diagnostics leave this custody boundary.
        throw unavailable()
      }
    },
    put: async (account, value) => {
      if (account === installation) throw unavailable()
      await native.put(account, value)
    },
    remove: async (account) => {
      if (account === installation) throw unavailable()
      await native.remove(account)
    },
  }
  // Read-only preflight precedes the original store constructor and Layer build.
  await guarded.get(installation).catch(() => {
    // Only fixed stage/code literals leave this fixture's initial read boundary.
    console.error("DAC_OWNED_IM_CUSTODY_BOOTSTRAP_FAILURE", JSON.stringify(diagnostic))
    throw unavailable()
  })
  return Layer.succeed(IMDeviceStore.Service, IMDeviceStore.make({ backend: guarded, directory: parameters.directory }))
}
