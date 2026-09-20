import { describe, expect, test } from "bun:test"
import { toolSuccessResources } from "@/deepagent/learning-runtime"

// Review round 3: attribution reads the STRUCTURED SUCCESS outputs, not the model-supplied
// inputs — `resource` is the mutation-resolved canonical path, and it is the ONLY source for
// apply_patch_chunk commits (the commit call carries no patchText; the assembled patch lives in
// the transaction map, so input-side parsing would systematically miss chunked patches).

describe("toolSuccessResources (finalizer attribution)", () => {
  test("write/edit success yields the resolved resource path", () => {
    expect(toolSuccessResources({ operation: "write", target: "Makefile", resource: "Makefile", existed: false })).toEqual([
      "Makefile",
    ])
    expect(
      toolSuccessResources({ operation: "write", target: "src/a.go", resource: "src/a.go", existed: true, replacements: 2 }),
    ).toEqual(["src/a.go"])
  })

  test("apply_patch success yields one resource per applied hunk", () => {
    const structured = {
      applied: [
        { type: "add", resource: "Makefile", target: "/workspace/Makefile" },
        { type: "update", resource: "src/main.go", target: "/workspace/src/main.go" },
      ],
    }
    expect(toolSuccessResources(structured)).toEqual(["Makefile", "src/main.go"])
  })

  test("apply_patch_chunk COMMIT success carries the assembled applied[] even without patchText", () => {
    // The commit call's own input has only {action:"commit", transactionID, offset} — the
    // attribution must come from THIS structured output, which the tool returns from the
    // assembled transaction.
    const structured = {
      applied: [{ type: "update", resource: "pkg/big/generated.go", target: "/workspace/pkg/big/generated.go" }],
    }
    expect(toolSuccessResources(structured)).toEqual(["pkg/big/generated.go"])
  })

  test("empty / malformed shapes contribute nothing — never guesses", () => {
    expect(toolSuccessResources(null)).toEqual([])
    expect(toolSuccessResources(undefined)).toEqual([])
    expect(toolSuccessResources("string")).toEqual([])
    expect(toolSuccessResources({})).toEqual([])
    expect(toolSuccessResources({ applied: "not-an-array" })).toEqual([])
    expect(toolSuccessResources({ applied: [null, 42, { resource: 7 }] })).toEqual([])
    expect(toolSuccessResources({ resource: "   " })).toEqual([])
  })

  test("bash-style outputs (no resource fields) attribute nothing", () => {
    expect(toolSuccessResources({ exitCode: 0, stdout: "wrote src/x.go somehow" })).toEqual([])
  })

  test("outputPaths-only success (overflow archive) never yields committable paths", () => {
    // Review round 4: the event schema carries outputPaths, but its producer is the
    // tool-output overflow store — those paths point INSIDE the .deepagent data dir, not at
    // workspace files. The extraction reads ONLY structured — by design — so archive paths
    // can never leak into the touched set and pollute the commit; this test pins that
    // contract. The attribution test asserts the anomaly warning separately.
    expect(toolSuccessResources({ ok: true, outputPaths: ["/root/.deepagent/tool_abc.txt"] })).toEqual([])
  })
})
