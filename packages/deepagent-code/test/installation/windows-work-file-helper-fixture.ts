import { Effect, Exit } from "effect"
import { NativeInstallation } from "../../src/installation/native-installation"
import { NativeWindowsWorkFactory } from "../../src/installation/windows-work-factory"
import { WindowsWorkFileHelper } from "../../src/installation/windows-work-file-helper"
import { WorkFileHelper } from "../../src/installation/work-file-helper"

/** Executed only inside the original sealed Windows utility process. The
 * wrapper supplies the original Root factory; no fixture registers a port. */
export const run = Effect.fn("WindowsWorkFileHelperFixture.run")(function* (directory: string) {
  if (process.platform !== "win32") throw new Error("Windows helper fixture requires Windows")
  const installation = yield* NativeInstallation.current()
  const factory = yield* NativeWindowsWorkFactory.Service
  const original = yield* WindowsWorkFileHelper.asset(installation)
  const copied = yield* Effect.scoped(WindowsWorkFileHelper.launch({ ...original })).pipe(Effect.exit)
  if (!Exit.isFailure(copied)) throw new Error("Copied helper description created a child")
  const root = yield* WorkFileHelper.inspectRoot(directory)
  if (root.helperHash !== original.hash || root.rootIdentity.kind !== "windows")
    throw new Error("Original Windows helper root differs")
  yield* factory.current
  return { originalRootInspected: true, copiedDescriptionRefused: true,
    originalFactoryStillCurrent: true, helperHash: root.helperHash, rootKind: root.rootIdentity.kind, rootIdentity: root.rootIdentity }
})
