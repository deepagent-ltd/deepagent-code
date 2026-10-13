export * as WorkWindowsIdentitySql from "./work-windows-identity.sql"

import { sql } from "drizzle-orm"
import type { SQLWrapper } from "drizzle-orm"

/** Locations are fixed schema paths, never request input. IS guards keep absent
 * JSON values from passing SQLite CHECK via its otherwise permissive NULL result. */
export function check(record: SQLWrapper, location: string) {
  return sql`(json_type(${record},${sql.raw(`'${location}'`)}) IS 'object'
    AND json_type(${record},${sql.raw(`'${location}.kind'`)}) IS 'text' AND json_extract(${record},${sql.raw(`'${location}.kind'`)}) IS 'windows'
    AND json_type(${record},${sql.raw(`'${location}.volumeSerial'`)}) IS 'text'
    AND length(json_extract(${record},${sql.raw(`'${location}.volumeSerial'`)}))=16 AND json_extract(${record},${sql.raw(`'${location}.volumeSerial'`)}) NOT GLOB '*[^0-9a-f]*'
    AND json_type(${record},${sql.raw(`'${location}.fileID'`)}) IS 'text'
    AND length(json_extract(${record},${sql.raw(`'${location}.fileID'`)}))=32 AND json_extract(${record},${sql.raw(`'${location}.fileID'`)}) NOT GLOB '*[^0-9a-f]*')`
}
