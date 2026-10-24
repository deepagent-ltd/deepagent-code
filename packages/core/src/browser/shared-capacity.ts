export * as SharedBrowserCapacity from "./shared-capacity"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { BrowserActionTable, BrowserControlTable } from "./browser.sql"
import { BrowserSchema } from "./schema"

type Reader = Pick<Database.Interface["db"], "select" | "all">

/** One reservation envelope covers v1 and v2. Reducing an existing resource never calls this. */
export const reserve = Effect.fn("SharedBrowserCapacity.reserve")(function* (
  db: Reader,
  kind: "control" | "action" | "resource" | "lease" | "request" | "origin" | "selection" | "shared_action",
) {
  const controls = yield* db
    .select({ n: sql<number>`count(*)` })
    .from(BrowserControlTable)
    .get()
  const actions = yield* db
    .select({ n: sql<number>`count(*)` })
    .from(BrowserActionTable)
    .get()
  const shared = yield* db.all<{
    resources: number
    leases: number
    requests: number
    origins: number
    selections: number
    actions: number
  }>(
    "SELECT (SELECT count(*) FROM browser_shared_resource) resources,(SELECT count(*) FROM browser_shared_lease) leases,(SELECT count(*) FROM browser_shared_request) requests,(SELECT count(*) FROM session_user_input_origin) origins,(SELECT count(*) FROM browser_user_selection) selections,(SELECT count(*) FROM browser_shared_action) actions",
  )
  const c = (controls?.n ?? 0) + (shared[0]?.resources ?? 0) + Number(kind === "control" || kind === "resource")
  const a = (actions?.n ?? 0) + (shared[0]?.actions ?? 0) + Number(kind === "action" || kind === "shared_action")
  const metadata =
    (shared[0]?.leases ?? 0) +
    (shared[0]?.requests ?? 0) +
    (shared[0]?.origins ?? 0) +
    (shared[0]?.selections ?? 0) +
    Number(["lease", "request", "origin", "selection"].includes(kind))
  if (
    ![c, a, metadata].every(Number.isSafeInteger) ||
    c > BrowserSchema.MAX_CONTROLS ||
    a + metadata > BrowserSchema.MAX_ACTIONS ||
    (c + metadata) * (BrowserSchema.MAX_CONTROL_BYTES + BrowserSchema.ROW_OVERHEAD_BYTES) +
      a * (BrowserSchema.MAX_ACTION_BYTES + BrowserSchema.ROW_OVERHEAD_BYTES) >
      BrowserSchema.MAX_RESERVED_BYTES
  )
    return yield* new BrowserSchema.Error({
      code: "BROWSER_CAPACITY",
      message: "Managed browser reservation capacity reached",
    })
})
