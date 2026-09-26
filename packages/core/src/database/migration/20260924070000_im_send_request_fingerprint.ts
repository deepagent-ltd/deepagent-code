import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260924070000_im_send_request_fingerprint",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE im_agent_push_logs ADD COLUMN request_fingerprint TEXT
        CHECK (request_fingerprint IS NULL OR (
          length(request_fingerprint) = 64 AND
          request_fingerprint NOT GLOB '*[^0-9a-f]*'
        ));
      `)
      yield* tx.run(`
        CREATE TRIGGER im_agent_push_logs_request_fingerprint_immutable
        BEFORE UPDATE OF request_fingerprint ON im_agent_push_logs
        WHEN NEW.request_fingerprint IS NOT OLD.request_fingerprint
        BEGIN
          SELECT RAISE(ABORT, 'im_send request fingerprint is immutable');
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
