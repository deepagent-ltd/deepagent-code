import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: IM System V3.8 Tables
 *
 * Creates tables for the IM (Instant Messaging) system:
 * - im_groups: Chat groups (project-based or system-wide)
 * - im_members: Group membership tracking
 * - im_messages: Messages with mentions and metadata
 *
 * Features:
 * - Soft delete support (deleted_at column)
 * - Foreign key constraints with cascade delete
 * - Optimized indexes for common queries
 * - JSON metadata for extensibility
 */
export default {
  id: "20260704000000_im_system_tables",
  up(tx) {
    return Effect.gen(function* () {
      // Create im_groups table.
      //
      // `workspace_id` is a grouping key, NOT a foreign key. In the single-user /
      // directory-routed deployment model there is frequently no row in the
      // `workspace` table (that table is only populated under experimental
      // workspaces), yet IM groups must still be creatable. So `workspace_id`
      // holds whatever identity the server routed the request with — an
      // experimental workspace id when present, otherwise the working directory.
      // Project scoping is expressed by the `project_id` FK, which always exists.
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`im_groups\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`project_id\` text,
          \`type\` text NOT NULL,
          \`name\` text NOT NULL,
          \`created_by\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`deleted_at\` integer,
          FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)

      // Create indexes for im_groups
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`im_groups_workspace_idx\` ON \`im_groups\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`im_groups_project_idx\` ON \`im_groups\` (\`project_id\`);`)

      // Create im_members table
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`im_members\` (
          \`group_id\` text NOT NULL,
          \`member_id\` text NOT NULL,
          \`member_type\` text NOT NULL,
          \`role\` text NOT NULL,
          \`last_read_at\` integer,
          \`joined_at\` integer NOT NULL,
          FOREIGN KEY (\`group_id\`) REFERENCES \`im_groups\`(\`id\`) ON DELETE CASCADE
        );
      `)

      // Create indexes for im_members
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`im_members_unique_idx\`
        ON \`im_members\` (\`group_id\`, \`member_id\`, \`member_type\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_members_unread\`
        ON \`im_members\` (\`member_id\`, \`group_id\`, \`last_read_at\`);
      `)

      // Create im_messages table
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`im_messages\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`group_id\` text NOT NULL,
          \`sender_id\` text NOT NULL,
          \`sender_type\` text NOT NULL,
          \`type\` text NOT NULL,
          \`content\` text NOT NULL,
          \`mentions\` text,
          \`metadata\` text,
          \`reply_to_id\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`deleted_at\` integer,
          FOREIGN KEY (\`group_id\`) REFERENCES \`im_groups\`(\`id\`) ON DELETE CASCADE
        );
      `)

      // Create index for im_messages (partial index for active messages)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_messages_active\`
        ON \`im_messages\` (\`group_id\`, \`created_at\`, \`id\`)
        WHERE \`deleted_at\` IS NULL;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
