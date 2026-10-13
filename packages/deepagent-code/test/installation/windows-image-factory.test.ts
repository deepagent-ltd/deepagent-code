import { expect, test } from "bun:test"
import { Effect } from "effect"
import { NativeWindowsImageFactory } from "@/installation/windows-image-factory"

test("missing trusted bootstrap cannot advertise a Windows native target", async () => {
  const result = await Effect.runPromise(NativeWindowsImageFactory.requireRegistered.pipe(Effect.match({
    onSuccess: () => "registered", onFailure: (error) => error.code,
  })))
  expect(result).toBe("WINDOWS_IMAGE_FACTORY_UNAVAILABLE")
})

test("copy and JSON objects cannot reconstruct an original native target capture", () => {
  const foreign = Object.freeze(Object.create(null)) as NativeWindowsImageFactory.TargetCapture
  expect(NativeWindowsImageFactory.describeTarget(foreign)).toBeUndefined()
  expect(NativeWindowsImageFactory.describeTarget({ ...foreign })).toBeUndefined()
})
