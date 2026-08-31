// Node target for the raw SQLite Database (see sqlite-native.bun.ts for the bun
// target). The desktop sidecar runs the server bundle under Electron's Node, so
// a literal "bun:sqlite" import is rejected by the ESM loader. Only the surface
// the database maintenance modules use is implemented: constructor options
// { readonly, readwrite, create }, run/exec, query().get()/.all()/.run() and
// close(). PRAGMA statements are issued through run()/exec().
import { existsSync } from "node:fs"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

interface DatabaseOptions {
  readonly readonly?: boolean
  readonly readwrite?: boolean
  readonly create?: boolean
}

export class Database {
  readonly #db: DatabaseSync

  constructor(filename: string, options: DatabaseOptions = {}) {
    const readOnly = options.readonly ?? false
    if (options.create === false && !existsSync(filename)) {
      throw new Error(`SQLiteDatabase: file does not exist: ${filename}`)
    }
    this.#db = new DatabaseSync(filename, { readOnly })
  }

  run(sql: string): void {
    this.#db.exec(sql)
  }

  exec(sql: string): void {
    this.#db.exec(sql)
  }

  query(sql: string): {
    get: (...params: SQLInputValue[]) => unknown
    all: (...params: SQLInputValue[]) => unknown[]
    run: (...params: SQLInputValue[]) => unknown
  } {
    const statement = this.#db.prepare(sql)
    return {
      get: (...params) => statement.get(...params),
      all: (...params) => statement.all(...params),
      run: (...params) => statement.run(...params),
    }
  }

  close(): void {
    this.#db.close()
  }
}
