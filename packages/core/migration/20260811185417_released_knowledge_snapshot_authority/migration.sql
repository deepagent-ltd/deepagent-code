CREATE TABLE `released_knowledge_evaluation` (
	`evaluation_id` text PRIMARY KEY,
	`security_namespace_id` text NOT NULL,
	`project_scope_key` text NOT NULL,
	`matrix_hash` text NOT NULL,
	`matrix_json` text NOT NULL,
	`document_manifest_json` text NOT NULL,
	`baseline_ref` text NOT NULL,
	`repetitions` integer NOT NULL,
	`evaluator_type` text NOT NULL,
	`evaluator_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_released_knowledge_evaluation_security_namespace_id_context_security_namespace_id_fk` FOREIGN KEY (`security_namespace_id`) REFERENCES `context_security_namespace`(`id`),
	CONSTRAINT `fk_released_knowledge_evaluation_security_namespace_id_project_scope_key_context_project_scope_identity_security_namespace_id_project_scope_key_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`) REFERENCES `context_project_scope_identity`(`security_namespace_id`,`project_scope_key`),
	CONSTRAINT "released_knowledge_evaluation_matrix_hash_check" CHECK(length("matrix_hash") = 64 AND "matrix_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "released_knowledge_evaluation_matrix_json_check" CHECK(json_valid("matrix_json")),
	CONSTRAINT "released_knowledge_evaluation_document_manifest_json_check" CHECK(json_valid("document_manifest_json") AND json_type("document_manifest_json") = 'array'),
	CONSTRAINT "released_knowledge_evaluation_repetitions_check" CHECK("repetitions" > 0),
	CONSTRAINT "released_knowledge_evaluation_actor_type_check" CHECK("evaluator_type" IN ('human', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE `released_knowledge_snapshot_document` (
	`snapshot_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`source_store` text NOT NULL,
	`doc_id` text NOT NULL,
	`doc_version` integer NOT NULL,
	`doc_hash` text NOT NULL,
	`doc_type` text NOT NULL,
	`doc_scope` text NOT NULL,
	CONSTRAINT `released_knowledge_snapshot_document_pk` PRIMARY KEY(`snapshot_id`, `source_store`, `doc_id`),
	CONSTRAINT `fk_released_knowledge_snapshot_document_snapshot_id_released_knowledge_snapshot_snapshot_id_fk` FOREIGN KEY (`snapshot_id`) REFERENCES `released_knowledge_snapshot`(`snapshot_id`) ON DELETE CASCADE,
	CONSTRAINT "released_knowledge_snapshot_document_ordinal_check" CHECK("ordinal" >= 0),
	CONSTRAINT "released_knowledge_snapshot_document_source_store_check" CHECK("source_store" IN ('user_global', 'project')),
	CONSTRAINT "released_knowledge_snapshot_document_version_check" CHECK("doc_version" > 0),
	CONSTRAINT "released_knowledge_snapshot_document_hash_check" CHECK(length("doc_hash") = 71 AND substr("doc_hash", 1, 7) = 'sha256:' AND substr("doc_hash", 8) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "released_knowledge_snapshot_document_type_check" CHECK("doc_type" IN ('knowledge', 'strategy', 'methodology', 'memory', 'skill'))
);
--> statement-breakpoint
CREATE TABLE `released_knowledge_snapshot_head` (
	`security_namespace_id` text NOT NULL,
	`project_scope_key` text NOT NULL,
	`snapshot_id` text,
	`generation` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `released_knowledge_snapshot_head_pk` PRIMARY KEY(`security_namespace_id`, `project_scope_key`),
	CONSTRAINT `fk_released_knowledge_snapshot_head_security_namespace_id_context_security_namespace_id_fk` FOREIGN KEY (`security_namespace_id`) REFERENCES `context_security_namespace`(`id`),
	CONSTRAINT `fk_released_knowledge_snapshot_head_security_namespace_id_project_scope_key_context_project_scope_identity_security_namespace_id_project_scope_key_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`) REFERENCES `context_project_scope_identity`(`security_namespace_id`,`project_scope_key`),
	CONSTRAINT `fk_released_knowledge_snapshot_head_security_namespace_id_project_scope_key_snapshot_id_released_knowledge_snapshot_security_namespace_id_project_scope_key_snapshot_id_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`,`snapshot_id`) REFERENCES `released_knowledge_snapshot`(`security_namespace_id`,`project_scope_key`,`snapshot_id`),
	CONSTRAINT "released_knowledge_snapshot_head_generation_check" CHECK(("snapshot_id" IS NULL AND "generation" = 0) OR ("snapshot_id" IS NOT NULL AND "generation" > 0))
);
--> statement-breakpoint
CREATE TABLE `released_knowledge_snapshot` (
	`snapshot_id` text PRIMARY KEY,
	`security_namespace_id` text NOT NULL,
	`project_scope_key` text NOT NULL,
	`legacy_project_id` text NOT NULL,
	`parent_snapshot_id` text,
	`evaluation_id` text NOT NULL,
	`release_kind` text NOT NULL,
	`document_count` integer NOT NULL,
	`published_generation` integer NOT NULL,
	`verdict` text NOT NULL,
	`failure_reason` text,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`finalized_at` integer,
	CONSTRAINT `fk_released_knowledge_snapshot_security_namespace_id_context_security_namespace_id_fk` FOREIGN KEY (`security_namespace_id`) REFERENCES `context_security_namespace`(`id`),
	CONSTRAINT `fk_released_knowledge_snapshot_security_namespace_id_project_scope_key_context_project_scope_identity_security_namespace_id_project_scope_key_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`) REFERENCES `context_project_scope_identity`(`security_namespace_id`,`project_scope_key`),
	CONSTRAINT `fk_released_knowledge_snapshot_security_namespace_id_project_scope_key_parent_snapshot_id_released_knowledge_snapshot_security_namespace_id_project_scope_key_snapshot_id_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`,`parent_snapshot_id`) REFERENCES `released_knowledge_snapshot`(`security_namespace_id`,`project_scope_key`,`snapshot_id`),
	CONSTRAINT `fk_released_knowledge_snapshot_security_namespace_id_project_scope_key_evaluation_id_released_knowledge_evaluation_security_namespace_id_project_scope_key_evaluation_id_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`,`evaluation_id`) REFERENCES `released_knowledge_evaluation`(`security_namespace_id`,`project_scope_key`,`evaluation_id`),
	CONSTRAINT "released_knowledge_snapshot_release_kind_check" CHECK("release_kind" IN ('legacy_baseline', 'evaluated', 'rollback')),
	CONSTRAINT "released_knowledge_snapshot_document_count_check" CHECK("document_count" >= 0),
	CONSTRAINT "released_knowledge_snapshot_published_generation_check" CHECK(("verdict" = 'passed' AND "published_generation" > 0) OR ("verdict" = 'failed' AND "published_generation" >= 0)),
	CONSTRAINT "released_knowledge_snapshot_verdict_check" CHECK("verdict" IN ('passed', 'failed')),
	CONSTRAINT "released_knowledge_snapshot_failure_reason_check" CHECK(("verdict" = 'passed' AND "failure_reason" IS NULL) OR ("verdict" = 'failed' AND length(trim("failure_reason")) > 0)),
	CONSTRAINT "released_knowledge_snapshot_release_chain_check" CHECK(("release_kind" = 'legacy_baseline' AND "parent_snapshot_id" IS NULL AND "verdict" = 'passed') OR ("release_kind" <> 'legacy_baseline' AND "parent_snapshot_id" IS NOT NULL)),
	CONSTRAINT "released_knowledge_snapshot_evaluated_membership_check" CHECK("release_kind" <> 'evaluated' OR "verdict" = 'failed' OR "document_count" > 0),
	CONSTRAINT "released_knowledge_snapshot_actor_type_check" CHECK("actor_type" IN ('human', 'agent', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `released_knowledge_evaluation_scope_identity_idx` ON `released_knowledge_evaluation` (`security_namespace_id`,`project_scope_key`,`evaluation_id`);--> statement-breakpoint
CREATE INDEX `released_knowledge_evaluation_matrix_idx` ON `released_knowledge_evaluation` (`security_namespace_id`,`project_scope_key`,`matrix_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `released_knowledge_snapshot_document_ordinal_idx` ON `released_knowledge_snapshot_document` (`snapshot_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `released_knowledge_snapshot_scope_identity_idx` ON `released_knowledge_snapshot` (`security_namespace_id`,`project_scope_key`,`snapshot_id`);--> statement-breakpoint
CREATE INDEX `released_knowledge_snapshot_parent_idx` ON `released_knowledge_snapshot` (`parent_snapshot_id`);--> statement-breakpoint
CREATE TRIGGER `released_knowledge_evaluation_update_forbidden`
BEFORE UPDATE ON `released_knowledge_evaluation`
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_evaluation_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_evaluation_delete_forbidden`
BEFORE DELETE ON `released_knowledge_evaluation`
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_evaluation_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_scope_guard`
BEFORE INSERT ON `released_knowledge_snapshot`
WHEN NOT EXISTS (
  SELECT 1
  FROM `context_project_scope_identity` AS `project`
  WHERE `project`.`security_namespace_id` = NEW.`security_namespace_id`
    AND `project`.`project_scope_key` = NEW.`project_scope_key`
    AND `project`.`observed_project_id` = NEW.`legacy_project_id`
    AND `project`.`retired_at` IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_legacy_scope_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_publish_guard`
BEFORE INSERT ON `released_knowledge_snapshot`
WHEN NEW.`finalized_at` IS NOT NULL OR NOT EXISTS (
  SELECT 1
  FROM `released_knowledge_snapshot_head` AS `head`
  WHERE `head`.`security_namespace_id` = NEW.`security_namespace_id`
    AND `head`.`project_scope_key` = NEW.`project_scope_key`
    AND `head`.`snapshot_id` IS NEW.`parent_snapshot_id`
    AND (
      (NEW.`verdict` = 'passed' AND NEW.`published_generation` = `head`.`generation` + 1)
      OR (NEW.`verdict` = 'failed' AND NEW.`published_generation` = `head`.`generation`)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_stale_parent');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_document_insert_guard`
BEFORE INSERT ON `released_knowledge_snapshot_document`
WHEN NOT EXISTS (
  SELECT 1
  FROM `released_knowledge_snapshot` AS `snapshot`
  WHERE `snapshot`.`snapshot_id` = NEW.`snapshot_id`
    AND `snapshot`.`finalized_at` IS NULL
    AND (
      (NEW.`source_store` = 'user_global' AND NEW.`doc_scope` = 'durable')
      OR (
        NEW.`source_store` = 'project'
        AND NEW.`doc_scope` = 'durable:project:' || `snapshot`.`legacy_project_id`
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_document_scope_or_state_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_document_update_forbidden`
BEFORE UPDATE ON `released_knowledge_snapshot_document`
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_document_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_document_delete_forbidden`
BEFORE DELETE ON `released_knowledge_snapshot_document`
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_document_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_finalize_guard`
BEFORE UPDATE ON `released_knowledge_snapshot`
WHEN NOT (
  OLD.`finalized_at` IS NULL
  AND NEW.`finalized_at` IS NOT NULL
  AND NEW.`finalized_at` >= OLD.`created_at`
  AND NEW.`snapshot_id` IS OLD.`snapshot_id`
  AND NEW.`security_namespace_id` IS OLD.`security_namespace_id`
  AND NEW.`project_scope_key` IS OLD.`project_scope_key`
  AND NEW.`legacy_project_id` IS OLD.`legacy_project_id`
  AND NEW.`parent_snapshot_id` IS OLD.`parent_snapshot_id`
  AND NEW.`evaluation_id` IS OLD.`evaluation_id`
  AND NEW.`release_kind` IS OLD.`release_kind`
  AND NEW.`document_count` IS OLD.`document_count`
  AND NEW.`published_generation` IS OLD.`published_generation`
  AND NEW.`verdict` IS OLD.`verdict`
  AND NEW.`failure_reason` IS OLD.`failure_reason`
  AND NEW.`actor_type` IS OLD.`actor_type`
  AND NEW.`actor_id` IS OLD.`actor_id`
  AND NEW.`created_at` IS OLD.`created_at`
  AND (
    SELECT count(*)
    FROM `released_knowledge_snapshot_document`
    WHERE `snapshot_id` = OLD.`snapshot_id`
  ) = OLD.`document_count`
    AND (
      OLD.`document_count` = 0
      OR (
      SELECT min(`ordinal`) = 0 AND max(`ordinal`) = OLD.`document_count` - 1
      FROM `released_knowledge_snapshot_document`
        WHERE `snapshot_id` = OLD.`snapshot_id`
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM `released_knowledge_snapshot_document` AS `current_document`
      JOIN `released_knowledge_snapshot_document` AS `previous_document`
        ON `previous_document`.`snapshot_id` = `current_document`.`snapshot_id`
        AND `previous_document`.`ordinal` = `current_document`.`ordinal` - 1
      WHERE `current_document`.`snapshot_id` = OLD.`snapshot_id`
        AND (
          `previous_document`.`source_store` > `current_document`.`source_store`
          OR (
            `previous_document`.`source_store` = `current_document`.`source_store`
            AND `previous_document`.`doc_id` >= `current_document`.`doc_id`
          )
        )
    )
    AND (
      SELECT evaluation.`document_manifest_json` = (
        SELECT COALESCE(json_group_array(json(document_ref)), '[]')
        FROM (
          SELECT json_object(
            'hash', document.`doc_hash`,
            'id', document.`doc_id`,
            'scope', document.`doc_scope`,
            'sourceStore', document.`source_store`,
            'type', document.`doc_type`,
            'version', document.`doc_version`
          ) AS document_ref
          FROM `released_knowledge_snapshot_document` document
          WHERE document.`snapshot_id` = OLD.`snapshot_id`
          ORDER BY document.`ordinal`
        )
      )
      FROM `released_knowledge_evaluation` evaluation
      WHERE evaluation.`evaluation_id` = OLD.`evaluation_id`
        AND evaluation.`security_namespace_id` = OLD.`security_namespace_id`
        AND evaluation.`project_scope_key` = OLD.`project_scope_key`
    )
)
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_illegal_finalize');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_delete_forbidden`
BEFORE DELETE ON `released_knowledge_snapshot`
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_head_insert_guard`
BEFORE INSERT ON `released_knowledge_snapshot_head`
WHEN NEW.`snapshot_id` IS NOT NULL OR NEW.`generation` <> 0
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_head_invalid_initial_state');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_head_update_guard`
BEFORE UPDATE ON `released_knowledge_snapshot_head`
WHEN NOT (
  NEW.`security_namespace_id` IS OLD.`security_namespace_id`
  AND NEW.`project_scope_key` IS OLD.`project_scope_key`
  AND NEW.`snapshot_id` IS NOT NULL
  AND NEW.`snapshot_id` IS NOT OLD.`snapshot_id`
  AND NEW.`generation` = OLD.`generation` + 1
  AND NEW.`updated_at` >= OLD.`updated_at`
  AND EXISTS (
    SELECT 1
    FROM `released_knowledge_snapshot` AS `snapshot`
    WHERE `snapshot`.`security_namespace_id` = NEW.`security_namespace_id`
      AND `snapshot`.`project_scope_key` = NEW.`project_scope_key`
      AND `snapshot`.`snapshot_id` = NEW.`snapshot_id`
      AND `snapshot`.`parent_snapshot_id` IS OLD.`snapshot_id`
      AND `snapshot`.`published_generation` = NEW.`generation`
      AND `snapshot`.`verdict` = 'passed'
      AND `snapshot`.`finalized_at` IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_head_illegal_transition');
END;--> statement-breakpoint
CREATE TRIGGER `released_knowledge_snapshot_head_delete_forbidden`
BEFORE DELETE ON `released_knowledge_snapshot_head`
BEGIN
  SELECT RAISE(ABORT, 'released_knowledge_snapshot_head_immutable');
END;
