CREATE TABLE `session_mcp_app_effect` (
	`invocation_id` text PRIMARY KEY,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`owner_nonce` text,
	`session_claim_token` integer,
	`permission` text,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`dispatched_at` integer,
	`terminal_at` integer,
	`result` text,
	`result_hash` text,
	`result_bytes` integer DEFAULT 0 NOT NULL,
	`result_retired_at` integer,
	`error_code` text,
	CONSTRAINT `fk_session_mcp_app_effect_invocation_id_session_mcp_app_invocation_invocation_id_fk` FOREIGN KEY (`invocation_id`) REFERENCES `session_mcp_app_invocation`(`invocation_id`) ON DELETE RESTRICT,
	CONSTRAINT "session_mcp_app_effect_state_check" CHECK("state" IN ('queued','awaiting_permission','dispatching','settled','failed','cancelled_before_dispatch','unknown') AND "revision">0 AND "reserved_bytes" BETWEEN 0 AND 8388608 AND "result_bytes" BETWEEN 0 AND 8388608),
	CONSTRAINT "session_mcp_app_effect_dispatch_check" CHECK(("state" IN ('queued','awaiting_permission','cancelled_before_dispatch') AND "dispatched_at" IS NULL AND "owner_nonce" IS NULL AND "session_claim_token" IS NULL) OR ("state" IN ('dispatching','settled','failed','unknown') AND "dispatched_at" IS NOT NULL AND "owner_nonce" IS NOT NULL AND "session_claim_token">0)),
	CONSTRAINT "session_mcp_app_effect_result_check" CHECK(("result" IS NULL AND "result_bytes"=0) OR ("result" IS NOT NULL AND json_valid("result") AND json_type("result")='object' AND length(CAST("result" AS BLOB))="result_bytes" AND length("result_hash")=64 AND "state" IN ('settled','failed') AND "result_retired_at" IS NULL)),
	CONSTRAINT "session_mcp_app_effect_custody_check" CHECK(("state" IN ('queued','awaiting_permission','cancelled_before_dispatch') AND "reserved_bytes"=0 AND "result_hash" IS NULL AND "result_retired_at" IS NULL) OR ("state"='dispatching' AND "reserved_bytes"=8388608 AND "result_hash" IS NULL AND "result_retired_at" IS NULL) OR ("state"='unknown' AND "reserved_bytes"=8388608 AND "result" IS NULL AND "result_hash" IS NULL AND "result_retired_at" IS NULL) OR ("state" IN ('settled','failed') AND "reserved_bytes"=0 AND ("result_hash" IS NULL OR length("result_hash")=64) AND ("result_retired_at" IS NULL OR ("result" IS NULL AND "result_hash" IS NOT NULL)))),
	CONSTRAINT "session_mcp_app_effect_permission_check" CHECK("permission" IS NULL OR (json_valid("permission") AND json_type("permission")='object' AND length(CAST("permission" AS BLOB)) BETWEEN 1 AND 4096)),
	CONSTRAINT "session_mcp_app_effect_terminal_check" CHECK(("state" IN ('queued','awaiting_permission','dispatching') AND "terminal_at" IS NULL) OR ("state" IN ('settled','failed','cancelled_before_dispatch','unknown') AND "terminal_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `session_mcp_app_invocation` (
	`invocation_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`view_id` text NOT NULL,
	`rpc_id` text NOT NULL,
	`admitted_seq` integer NOT NULL,
	`source_kind` text NOT NULL,
	`source` text NOT NULL,
	`source_hash` text NOT NULL,
	`input_hash` text NOT NULL,
	`arguments` text,
	`arguments_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`arguments_retired_at` integer,
	CONSTRAINT `fk_session_mcp_app_invocation_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "session_mcp_app_invocation_source_check" CHECK("source_kind"='mcp_app' AND json_valid("source") AND length(CAST("source" AS BLOB)) BETWEEN 1 AND 16384 AND json_extract("source", '$.kind')='mcp_app' AND json_extract("source", '$.sessionID')="session_id" AND json_extract("source", '$.viewID')="view_id" AND length("source_hash")=64 AND length("input_hash")=64 AND "expires_at">"created_at" AND "expires_at"<=json_extract("source", '$.expiresAt') AND "admitted_seq">=0),
	CONSTRAINT "session_mcp_app_invocation_body_check" CHECK(("arguments" IS NOT NULL AND json_valid("arguments") AND json_type("arguments")='object' AND length(CAST("arguments" AS BLOB))="arguments_bytes" AND "arguments_bytes" BETWEEN 2 AND 32768 AND "arguments_retired_at" IS NULL) OR ("arguments" IS NULL AND "arguments_bytes"=0 AND "arguments_retired_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `session_mcp_app_effect_pending_idx` ON `session_mcp_app_effect` (`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_mcp_app_invocation_rpc_idx` ON `session_mcp_app_invocation` (`view_id`,`rpc_id`);--> statement-breakpoint
CREATE INDEX `session_mcp_app_invocation_session_idx` ON `session_mcp_app_invocation` (`session_id`,`admitted_seq`);