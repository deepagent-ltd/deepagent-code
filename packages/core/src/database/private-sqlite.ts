// Reuse the package's Bun/Node condition without opening the business database or
// acquiring its runtime owner. Private stores own their schema and lifecycle.
export { Database } from "#sqlite-native"

export * as PrivateSqlite from "./private-sqlite"
