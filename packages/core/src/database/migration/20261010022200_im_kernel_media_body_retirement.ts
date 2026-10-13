import { randomUUID } from "node:crypto"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { IMKernelDeliveryTable } from "../../im/kernel-delivery.sql"
import { KernelMediaRetirement } from "../../im/kernel-media-retirement"
import { KernelMediaRetirementModel } from "../../im/kernel-media-retirement.model"
import { MessageTable } from "../../im/sql"

// A body lifecycle, never a transport retry or new execution authority. All old
// receipt bytes and transport facts survive this FK-on, single-TX migration.
export default {
  id: "20261010022200_im_kernel_media_body_retirement",
  up(tx) {
    return Effect.gen(function* () {
      const foreign = yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys")
      const deferred = yield* tx.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys")
      if (foreign?.foreign_keys !== 1 || deferred?.defer_foreign_keys !== 0)
        return yield* Effect.die("Media body migration requires its own FK-on, non-deferred transaction")
      if (yield* tx.get("SELECT * FROM pragma_foreign_key_check LIMIT 1"))
        return yield* Effect.die("Media body migration refuses pre-existing foreign key errors")
      if (yield* tx.get(`SELECT 1 unsafe FROM sqlite_master source JOIN pragma_foreign_key_list(source.name) reference
        WHERE source.type='table' AND reference."table"='im_kernel_delivery'
        AND reference.on_delete NOT IN ('NO ACTION','RESTRICT') LIMIT 1`))
        return yield* Effect.die("Media body migration refuses destructive incoming references")
      const guards = yield* tx.all<{ type: string; name: string; sql: string }>("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='im_kernel_delivery' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name LIMIT 129")
      if (guards.length > 128) return yield* Effect.die("Media body migration has too many schema guards")
      const count = yield* tx.get<{ total: number }>(`SELECT count(*) total FROM
        (SELECT 1 FROM im_kernel_delivery WHERE json_extract(binding,'$.version')=2 LIMIT 33334)`)
      if (!count || 1+3*count.total>KernelMediaRetirementModel.RECORD_LIMIT)
        return yield* Effect.die("Media body migration exceeds its independent logical record quota")
      const present = yield* tx.get<{ total: number; bytes: number }>(sql`SELECT count(*) total,
        coalesce(sum(${KernelMediaRetirement.legacyReceiptMessageBytes}),0) bytes
        FROM im_kernel_delivery d JOIN im_messages m ON m.id=d.message_id WHERE json_extract(d.binding,'$.version')=2`)
      if (!present || present.total!==count.total || present.bytes>KernelMediaRetirementModel.BYTE_LIMIT-KernelMediaRetirement.METER_BYTES)
        return yield* Effect.die("Media body migration refuses missing custody or excessive body copies")
      // DROP/recreate leaves SQLite's old deferred-parent counter pending even
      // once identical parent keys are restored. We own this deferral window;
      // full FK/custody checks must pass before its counter is normalized.
      yield* tx.run("PRAGMA defer_foreign_keys=ON")
      return yield* Effect.gen(function* () {
        yield* tx.run("CREATE TABLE `__new_im_kernel_delivery` (\n\t`message_id` text PRIMARY KEY,\n\t`binding` text,\n\t`body_state` text DEFAULT 'live' NOT NULL,\n\t`binding_hash` text NOT NULL,\n\t`wire_id` text NOT NULL,\n\t`state` text NOT NULL,\n\t`dispatch_owner` text,\n\t`kernel_message_id` text,\n\t`reason` text,\n\t`created_at` integer NOT NULL,\n\t`dispatched_at` integer,\n\t`acknowledged_at` integer,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT \"im_kernel_delivery_identity_check\" CHECK(\"message_id\" IS NOT NULL AND length(\"message_id\") BETWEEN 1 AND 2048 AND length(\"wire_id\") BETWEEN 1 AND 2048 AND (\"dispatch_owner\" IS NULL OR length(\"dispatch_owner\") BETWEEN 1 AND 2048) AND (\"kernel_message_id\" IS NULL OR length(\"kernel_message_id\") BETWEEN 1 AND 2048)),\n\tCONSTRAINT \"im_kernel_delivery_time_check\" CHECK(\"created_at\" >= 0 AND \"created_at\" <= 9007199254740991 AND \"updated_at\" >= \"created_at\" AND \"updated_at\" <= 9007199254740991 AND (\"dispatched_at\" IS NULL OR (\"dispatched_at\" >= \"created_at\" AND \"dispatched_at\" <= \"updated_at\")) AND (\"acknowledged_at\" IS NULL OR (\"acknowledged_at\" >= \"dispatched_at\" AND \"acknowledged_at\" <= \"updated_at\"))),\n\tCONSTRAINT \"im_kernel_delivery_binding_check\" CHECK((\"body_state\" = 'live' AND \"binding\" IS NOT NULL AND json_valid(\"binding\") AND json_type(\"binding\") = 'object') OR (\"body_state\" = 'retired' AND \"binding\" IS NULL AND \"state\" = 'acknowledged')),\n\tCONSTRAINT \"im_kernel_delivery_hash_check\" CHECK(length(\"binding_hash\") = 64 AND \"binding_hash\" NOT GLOB '*[^0-9a-f]*'),\n\tCONSTRAINT \"im_kernel_delivery_state_check\" CHECK(\"state\" IN ('prepared','dispatched','acknowledged','unknown')),\n\tCONSTRAINT \"im_kernel_delivery_dispatch_check\" CHECK((\"state\" = 'prepared' AND \"dispatch_owner\" IS NULL AND \"dispatched_at\" IS NULL) OR (\"state\" <> 'prepared' AND \"dispatch_owner\" IS NOT NULL AND \"dispatched_at\" IS NOT NULL)),\n\tCONSTRAINT \"im_kernel_delivery_ack_check\" CHECK((\"state\" = 'acknowledged' AND \"kernel_message_id\" IS NOT NULL AND \"acknowledged_at\" IS NOT NULL) OR (\"state\" <> 'acknowledged' AND \"kernel_message_id\" IS NULL AND \"acknowledged_at\" IS NULL))\n);")
        yield* tx.run("INSERT INTO `__new_im_kernel_delivery`(`message_id`,`binding`,`binding_hash`,`wire_id`,`state`,`dispatch_owner`,`kernel_message_id`,`reason`,`created_at`,`dispatched_at`,`acknowledged_at`,`updated_at`) SELECT `message_id`,`binding`,`binding_hash`,`wire_id`,`state`,`dispatch_owner`,`kernel_message_id`,`reason`,`created_at`,`dispatched_at`,`acknowledged_at`,`updated_at` FROM `im_kernel_delivery`;")
        yield* tx.run("DROP TABLE `im_kernel_delivery`;")
        yield* tx.run("ALTER TABLE `__new_im_kernel_delivery` RENAME TO `im_kernel_delivery`;")
        yield* tx.run("CREATE TABLE `im_kernel_media_meter` (\n\t`meter_id` integer PRIMARY KEY,\n\t`version` integer NOT NULL,\n\t`custody_id` text NOT NULL,\n\t`revision` integer NOT NULL,\n\t`used_records` integer NOT NULL,\n\t`used_bytes` integer NOT NULL,\n\tCONSTRAINT \"im_kernel_media_meter_identity_check\" CHECK(typeof(\"meter_id\") = 'integer' AND \"meter_id\" BETWEEN 1 AND 1 AND typeof(\"version\") = 'integer' AND \"version\" BETWEEN 1 AND 1 AND length(\"custody_id\") = 36 AND length(CAST(\"custody_id\" AS BLOB)) = 36 AND \"custody_id\" NOT GLOB '*[^0-9a-f-]*' AND substr(\"custody_id\",9,1)='-' AND substr(\"custody_id\",14,1)='-' AND substr(\"custody_id\",15,1)='4' AND substr(\"custody_id\",19,1)='-' AND substr(\"custody_id\",20,1) IN ('8','9','a','b') AND substr(\"custody_id\",24,1)='-'),\n\tCONSTRAINT \"im_kernel_media_meter_capacity_check\" CHECK(typeof(\"revision\") = 'integer' AND \"revision\" BETWEEN 1 AND 9007199254740991 AND typeof(\"used_records\") = 'integer' AND \"used_records\" BETWEEN 1 AND 100000 AND typeof(\"used_bytes\") = 'integer' AND \"used_bytes\" BETWEEN 76 AND 268435456)\n);")
        yield* tx.run("CREATE TABLE `im_kernel_media_body` (\n\t`message_id` text PRIMARY KEY,\n\t`meter_id` integer NOT NULL,\n\t`version` integer NOT NULL,\n\t`workspace_id` text NOT NULL,\n\t`group_id` text NOT NULL,\n\t`source_hash` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`body_state` text NOT NULL,\n\t`local_revision` integer NOT NULL,\n\t`retired_at` integer,\n\t`record` text NOT NULL,\n\t`record_hash` text NOT NULL,\n\t`identity_hash` text NOT NULL,\n\t`accounted_records` integer NOT NULL,\n\t`accounted_bytes` integer NOT NULL,\n\tCONSTRAINT `fk_im_kernel_media_body_meter_id_im_kernel_media_meter_meter_id_fk` FOREIGN KEY (`meter_id`) REFERENCES `im_kernel_media_meter`(`meter_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,\n\tCONSTRAINT `fk_im_kernel_media_body_message_id_im_kernel_delivery_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `im_kernel_delivery`(`message_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,\n\tCONSTRAINT `fk_im_kernel_media_body_message_id_im_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `im_messages`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,\n\tCONSTRAINT `fk_im_kernel_media_body_group_id_im_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `im_groups`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,\n\tCONSTRAINT \"im_kernel_media_body_identity_check\" CHECK(typeof(\"meter_id\") = 'integer' AND \"meter_id\" BETWEEN 1 AND 1 AND typeof(\"version\") = 'integer' AND \"version\" BETWEEN 1 AND 1 AND typeof(\"local_revision\") = 'integer' AND \"local_revision\" BETWEEN 1 AND 9007199254740991 AND typeof(\"source_hash\") = 'text' AND length(\"source_hash\") = 64 AND length(CAST(\"source_hash\" AS BLOB)) = 64 AND \"source_hash\" NOT GLOB '*[^0-9a-f]*' AND typeof(\"record_hash\") = 'text' AND length(\"record_hash\") = 64 AND length(CAST(\"record_hash\" AS BLOB)) = 64 AND \"record_hash\" NOT GLOB '*[^0-9a-f]*' AND typeof(\"identity_hash\") = 'text' AND length(\"identity_hash\") = 64 AND length(CAST(\"identity_hash\" AS BLOB)) = 64 AND \"identity_hash\" NOT GLOB '*[^0-9a-f]*' AND length(\"message_id\") BETWEEN 1 AND 2048 AND length(\"group_id\") BETWEEN 1 AND 2048 AND length(\"workspace_id\") BETWEEN 1 AND 2048),\n\tCONSTRAINT \"im_kernel_media_body_lifecycle_check\" CHECK(typeof(\"expires_at\") = 'integer' AND \"expires_at\" BETWEEN 0 AND 9007199254740991 AND ((\"body_state\"='live' AND \"retired_at\" IS NULL) OR (\"body_state\"='retired' AND typeof(\"retired_at\") = 'integer' AND \"retired_at\" BETWEEN 0 AND 9007199254740991 AND \"retired_at\">=\"expires_at\"))),\n\tCONSTRAINT \"im_kernel_media_body_accounting_check\" CHECK(typeof(\"accounted_records\") = 'integer' AND \"accounted_records\" BETWEEN 3 AND 3 AND typeof(\"accounted_bytes\") = 'integer' AND \"accounted_bytes\" BETWEEN 1 AND 268435456),\n\tCONSTRAINT \"im_kernel_media_body_record_check\" CHECK(CASE WHEN typeof(\"record\")='text' AND length(CAST(\"record\" AS BLOB)) BETWEEN 1 AND 65536 AND json_valid(\"record\") THEN coalesce(json_type(\"record\")='object' AND json_type(\"record\",'$.version')='integer' AND json_extract(\"record\",'$.version')=1 AND json_extract(\"record\",'$.identity.originalBindingVersion')=2 AND json_extract(\"record\",'$.identity.messageID')=\"message_id\" AND json_extract(\"record\",'$.identity.groupID')=\"group_id\" AND json_extract(\"record\",'$.identity.workspaceID')=\"workspace_id\" AND json_extract(\"record\",'$.identity.sourceHash')=\"source_hash\" AND json_extract(\"record\",'$.identity.expiresAt')=\"expires_at\" AND json_extract(\"record\",'$.identityHash')=\"identity_hash\" AND json_extract(\"record\",'$.bodyState')=\"body_state\" AND json_extract(\"record\",'$.retiredAt') IS \"retired_at\",0) ELSE 0 END)\n);")
        yield* tx.run(sql`INSERT INTO im_kernel_media_meter(meter_id,version,custody_id,revision,used_records,used_bytes)
          VALUES(1,1,${randomUUID()},1,1,${KernelMediaRetirement.METER_BYTES})`)
        const backfill = (after?: string): Effect.Effect<number, unknown> => Effect.gen(function* () {
          const rows = yield* tx.select({ receipt: IMKernelDeliveryTable, message: MessageTable }).from(IMKernelDeliveryTable)
            .innerJoin(MessageTable, sql`${MessageTable.id}=${IMKernelDeliveryTable.message_id}`)
            .where(and(sql`json_extract(${IMKernelDeliveryTable.binding},'$.version')=2`,
              after === undefined ? undefined : gt(IMKernelDeliveryTable.message_id, after)))
            .orderBy(asc(IMKernelDeliveryTable.message_id)).limit(32).all()
          yield* Effect.forEach(rows, (row) => KernelMediaRetirement.initialize(tx, row.receipt, row.message), { discard: true })
          if (rows.length<32) return rows.length
          return rows.length+(yield* backfill(rows.at(-1)!.receipt.message_id))
        })
        if ((yield* backfill())!==count.total) return yield* Effect.die("Media body migration changed original custody during backfill")
        if (!guards.some((guard) => guard.type === "index" && guard.name === "im_kernel_delivery_wire_idx"))
          yield* tx.run("CREATE UNIQUE INDEX `im_kernel_delivery_wire_idx` ON `im_kernel_delivery` (`wire_id`);")
        if (!guards.some((guard) => guard.type === "index" && guard.name === "im_kernel_delivery_prepared_idx"))
          yield* tx.run("CREATE INDEX `im_kernel_delivery_prepared_idx` ON `im_kernel_delivery` (`state`,`created_at`,`message_id`);")
        if (!guards.some((guard) => guard.type === "index" && guard.name === "im_kernel_delivery_result_lookup_idx"))
          yield* tx.run("CREATE INDEX `im_kernel_delivery_result_lookup_idx` ON `im_kernel_delivery` (`kernel_message_id`,`state`);")
        if (!guards.some((guard) => guard.type === "index" && guard.name === "im_kernel_media_body_expiry_idx"))
          yield* tx.run("CREATE INDEX `im_kernel_media_body_expiry_idx` ON `im_kernel_media_body` (`body_state`,`expires_at`,`message_id`);")
        if (!guards.some((guard) => guard.type === "index" && guard.name === "im_kernel_media_body_scope_idx"))
          yield* tx.run("CREATE INDEX `im_kernel_media_body_scope_idx` ON `im_kernel_media_body` (`workspace_id`,`source_hash`,`body_state`,`expires_at`,`message_id`);")
        if (!guards.some((guard) => guard.type === "index" && guard.name === "im_kernel_media_meter_custody_idx"))
          yield* tx.run("CREATE UNIQUE INDEX `im_kernel_media_meter_custody_idx` ON `im_kernel_media_meter` (`custody_id`);")
        yield* Effect.forEach(guards, (guard) => Effect.gen(function* () {
          const existing = yield* tx.get<{ tbl_name: string }>(sql`SELECT tbl_name FROM sqlite_master WHERE type=${guard.type} AND name=${guard.name}`)
          if (existing && existing.tbl_name!=="im_kernel_delivery") return yield* Effect.die("Media body migration found conflicting schema guard custody")
          if (existing) return
          yield* tx.run(guard.sql)
        }), { discard: true })
        const actual = yield* tx.get<{ records: number; bytes: number }>(`SELECT
          1+coalesce(sum(accounted_records),0) records,76+coalesce(sum(accounted_bytes),0) bytes FROM im_kernel_media_body`)
        const meter = yield* KernelMediaRetirement.currentMeter(tx)
        if (!actual || actual.records!==meter.used_records || actual.bytes!==meter.used_bytes ||
          actual.records!==1+count.total*3 || (yield* tx.get("SELECT * FROM pragma_foreign_key_check LIMIT 1")) ||
          (yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys!==1)
          return yield* Effect.die("Media body migration custody or foreign key reconciliation failed")
        yield* tx.run("PRAGMA defer_foreign_keys=OFF")
      }).pipe(Effect.ensuring(tx.run("PRAGMA defer_foreign_keys=OFF").pipe(Effect.ignore)))
    })
  },
} satisfies DatabaseMigration.Migration
