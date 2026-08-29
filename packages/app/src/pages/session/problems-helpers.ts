export type Position = { line: number; character: number }
export type LspDiagnostic = {
  range: { start: Position; end: Position }
  severity?: number
  message: string
  source?: string
  code?: string | number
}

export type ProblemLevel = "error" | "warning" | "information" | "hint"

export type Problem = LspDiagnostic & {
  file: string
  relativeFile: string
  level: ProblemLevel
}

const severityOrder: Record<ProblemLevel, number> = { error: 0, warning: 1, information: 2, hint: 3 }

const severityFor = (severity: number | undefined): ProblemLevel => {
  if (severity === 1 || severity === undefined) return "error"
  if (severity === 2) return "warning"
  if (severity === 3) return "information"
  return "hint"
}

export const parseWorkspaceDiagnostics = (value: unknown, relative: (path: string) => string): Problem[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const output: Problem[] = []
  for (const [file, diagnostics] of Object.entries(value)) {
    if (!Array.isArray(diagnostics)) continue
    for (const diagnostic of diagnostics) {
      if (!diagnostic || typeof diagnostic !== "object") continue
      const item = diagnostic as Partial<LspDiagnostic>
      if (
        typeof item.message !== "string" ||
        !item.range ||
        typeof item.range.start?.line !== "number" ||
        typeof item.range.start?.character !== "number"
      ) {
        continue
      }
      output.push({
        ...(item as LspDiagnostic),
        file,
        relativeFile: relative(file),
        level: severityFor(item.severity),
      })
    }
  }
  return output.sort(
    (a, b) =>
      severityOrder[a.level] - severityOrder[b.level] ||
      a.relativeFile.localeCompare(b.relativeFile) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character,
  )
}
