export * as ProcessStopUnknown from "./process-stop-unknown"

/** Sending a kill signal is not proof of exit or closed inherited streams. Keep this a
 * defect so the tool-effect admission remains unresolved instead of recording a failed
 * command as a known terminal effect. The ordinary recovery path retains its custody. */
export class Error extends globalThis.Error {
  readonly _tag = "ProcessStopUnknown"
  constructor(readonly pid: number) {
    super("The launched process could not confirm exit and stream cleanup; its execution outcome is unknown.")
    this.name = "ProcessStopUnknown"
  }
}
