import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { KernelDeliverySchema } from "./kernel-delivery.schema"

// One durable transport attempt, not an execution claim or a retry lease.
export const IMKernelDeliveryTable = sqliteTable(
  "im_kernel_delivery",
  {
    message_id: text().primaryKey().notNull(),
    binding: text({ mode: "json" }).$type<KernelDeliverySchema.Binding>(),
    body_state: text().$type<"live" | "retired">().notNull().default("live"),
    binding_hash: text().notNull(),
    wire_id: text().notNull(),
    state: text().$type<KernelDeliverySchema.State>().notNull(),
    dispatch_owner: text(),
    kernel_message_id: text(),
    reason: text(),
    created_at: integer().notNull(),
    dispatched_at: integer(),
    acknowledged_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    check(
      "im_kernel_delivery_identity_check",
      sql`${table.message_id} IS NOT NULL AND length(${table.message_id}) BETWEEN 1 AND 2048 AND length(${table.wire_id}) BETWEEN 1 AND 2048 AND (${table.dispatch_owner} IS NULL OR length(${table.dispatch_owner}) BETWEEN 1 AND 2048) AND (${table.kernel_message_id} IS NULL OR length(${table.kernel_message_id}) BETWEEN 1 AND 2048)`,
    ),
    check(
      "im_kernel_delivery_time_check",
      sql`${table.created_at} >= 0 AND ${table.created_at} <= 9007199254740991 AND ${table.updated_at} >= ${table.created_at} AND ${table.updated_at} <= 9007199254740991 AND (${table.dispatched_at} IS NULL OR (${table.dispatched_at} >= ${table.created_at} AND ${table.dispatched_at} <= ${table.updated_at})) AND (${table.acknowledged_at} IS NULL OR (${table.acknowledged_at} >= ${table.dispatched_at} AND ${table.acknowledged_at} <= ${table.updated_at}))`,
    ),
    uniqueIndex("im_kernel_delivery_wire_idx").on(table.wire_id),
    index("im_kernel_delivery_prepared_idx").on(table.state, table.created_at, table.message_id),
    index("im_kernel_delivery_result_lookup_idx").on(table.kernel_message_id, table.state),
    check(
      "im_kernel_delivery_binding_check",
      sql`(${table.body_state} = 'live' AND ${table.binding} IS NOT NULL AND json_valid(${table.binding}) AND json_type(${table.binding}) = 'object') OR (${table.body_state} = 'retired' AND ${table.binding} IS NULL AND ${table.state} = 'acknowledged')`,
    ),
    check(
      "im_kernel_delivery_hash_check",
      sql`length(${table.binding_hash}) = 64 AND ${table.binding_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("im_kernel_delivery_state_check", sql`${table.state} IN ('prepared','dispatched','acknowledged','unknown')`),
    check(
      "im_kernel_delivery_dispatch_check",
      sql`(${table.state} = 'prepared' AND ${table.dispatch_owner} IS NULL AND ${table.dispatched_at} IS NULL) OR (${table.state} <> 'prepared' AND ${table.dispatch_owner} IS NOT NULL AND ${table.dispatched_at} IS NOT NULL)`,
    ),
    check(
      "im_kernel_delivery_ack_check",
      sql`(${table.state} = 'acknowledged' AND ${table.kernel_message_id} IS NOT NULL AND ${table.acknowledged_at} IS NOT NULL) OR (${table.state} <> 'acknowledged' AND ${table.kernel_message_id} IS NULL AND ${table.acknowledged_at} IS NULL)`,
    ),
  ],
)
