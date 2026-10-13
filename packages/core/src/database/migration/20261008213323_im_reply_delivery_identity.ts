import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Hash } from "../../util/hash"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008213323_im_reply_delivery_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE im_reply_outbox ADD COLUMN delivery_message_id TEXT
        CHECK (delivery_message_id IS NULL OR (typeof(delivery_message_id)='text'
          AND length(CAST(delivery_message_id AS BLOB))=51
          AND substr(delivery_message_id,1,11)='imsg_reply_'
          AND substr(delivery_message_id,12) NOT GLOB '*[^0-9a-f]*'))`)
      const invalid = yield* tx.get<{ count: number }>(`SELECT count(*) AS count FROM im_reply_outbox
        WHERE typeof(id)!='text' OR length(CAST(id AS BLOB)) NOT BETWEEN 1 AND 512`)
      if (invalid?.count !== 0) return yield* Effect.fail(new Error("Original IM outbox identity is invalid"))
      // This frozen recipe is the original contentDigest(string) encoding. It only
      // derives an index; no message, authority, receipt or execution is synthesized.
      let after: string | undefined
      while (true) {
        const rows = yield* tx.all<{ id: string }>(after === undefined
          ? sql`SELECT id FROM im_reply_outbox ORDER BY id COLLATE BINARY LIMIT 256`
          : sql`SELECT id FROM im_reply_outbox WHERE id COLLATE BINARY > ${after}
              ORDER BY id COLLATE BINARY LIMIT 256`)
        if (!rows.length) break
        yield* Effect.forEach(rows, (row) => tx.run(sql`UPDATE im_reply_outbox
          SET delivery_message_id=${`imsg_reply_${Hash.sha256(JSON.stringify(row.id)).slice(0, 40)}`}
          WHERE id=${row.id}`), { discard: true })
        after = rows[rows.length - 1].id
      }
      yield* tx.run(`CREATE UNIQUE INDEX im_reply_outbox_delivery_message_idx
        ON im_reply_outbox (delivery_message_id)`)
    })
  },
} satisfies DatabaseMigration.Migration
