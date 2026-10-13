import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007175745_im_reader_new_action",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`im_kernel_reader_read_intent_pending_idx\`;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_read_intent_inflight_idx\` ON \`im_kernel_reader_read_intent\` (\`reader_key\`,\`projection_key\`) WHERE "im_kernel_reader_read_intent"."phase" IN ('prepared','dispatched');`)
      yield* tx.run(`CREATE INDEX \`im_kernel_reader_read_intent_unknown_idx\` ON \`im_kernel_reader_read_intent\` (\`reader_key\`,\`projection_key\`,\`binding_key\`,\`created_at\`,\`cut_index\`,\`action_id\`) WHERE "im_kernel_reader_read_intent"."phase" = 'unknown';`)
      yield* tx.run(`CREATE INDEX \`im_kernel_reader_read_intent_root_idx\` ON \`im_kernel_reader_read_intent\` (\`reader_key\`,\`binding_key\`,\`projection_key\`,\`created_at\`,\`action_id\`) WHERE "im_kernel_reader_read_intent"."cut_index" = 0;`)
      yield* tx.run(`
        CREATE TRIGGER im_reader_action_capacity_insert BEFORE INSERT ON im_kernel_reader_read_intent
        WHEN NEW.phase IN ('prepared','dispatched','unknown')
        BEGIN
          SELECT CASE WHEN (
            SELECT COUNT(*) FROM im_kernel_reader_read_intent
            WHERE reader_key=NEW.reader_key AND projection_key=NEW.projection_key
              AND phase IN ('prepared','dispatched','unknown')
          ) >= 8 THEN RAISE(ABORT,'im_reader_action_capacity') END;
          SELECT CASE WHEN NEW.phase IN ('prepared','dispatched') AND EXISTS (
            SELECT 1 FROM im_kernel_reader_read_intent
            WHERE reader_key=NEW.reader_key AND projection_key=NEW.projection_key AND phase='unknown'
              AND (length(original_target_admitted)>length(NEW.original_target_admitted)
                OR (length(original_target_admitted)=length(NEW.original_target_admitted)
                  AND original_target_admitted>=NEW.original_target_admitted))
          ) THEN RAISE(ABORT,'im_reader_action_new_target_required') END;
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER im_reader_action_capacity_update BEFORE UPDATE OF phase ON im_kernel_reader_read_intent
        WHEN NEW.phase IN ('prepared','dispatched','unknown')
        BEGIN
          SELECT CASE WHEN (
            SELECT COUNT(*) FROM im_kernel_reader_read_intent
            WHERE reader_key=NEW.reader_key AND projection_key=NEW.projection_key
              AND action_id<>OLD.action_id AND phase IN ('prepared','dispatched','unknown')
          ) >= 8 THEN RAISE(ABORT,'im_reader_action_capacity') END;
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
