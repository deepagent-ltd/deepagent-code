export type Value = string | number | bigint | Uint8Array | null

export interface Connection {
  readonly exec: (sql: string) => void
  readonly run: (sql: string, parameters?: readonly Value[]) => void
  readonly get: <A>(sql: string, parameters?: readonly Value[]) => A | undefined
  readonly all: <A>(sql: string, parameters?: readonly Value[]) => A[]
  readonly transaction: <A>(use: () => A) => A
  readonly close: () => void
}
