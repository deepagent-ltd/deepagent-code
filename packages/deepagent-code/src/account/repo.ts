import { randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import { Effect, Layer, Option, Schema, Context, Semaphore } from "effect"

import { Database } from "@deepagent-code/core/database/database"
import { AccountStateTable, AccountTable } from "@deepagent-code/core/account/sql"
import { AccessToken, AccountID, AccountRepoError, Info, OrgID, RefreshToken } from "./schema"
import { normalizeServerUrl } from "./url"

export type AccountRow = (typeof AccountTable)["$inferSelect"]

export type Authority = Readonly<{
  selectionRevision: number
  account: Readonly<AccountRow> | null
  orgID: OrgID | null
}>

const ACCOUNT_STATE_ID = 1

export interface Interface {
  readonly authority: () => Effect.Effect<Authority, AccountRepoError>
  /** Serializes identity mutation and the synchronous admission of an external request.
   * Do not hold this gate while waiting for network I/O. */
  readonly withIdentityGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountRepoError>
  readonly list: () => Effect.Effect<Info[], AccountRepoError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountRepoError>
  readonly use: (
    accountID: AccountID,
    orgID: Option.Option<OrgID>,
    expected: AccountRow,
  ) => Effect.Effect<void, AccountRepoError>
  readonly getRow: (accountID: AccountID) => Effect.Effect<Option.Option<AccountRow>, AccountRepoError>
  readonly persistToken: (input: {
    accountID: AccountID
    expected: AccountRow
    accessToken: AccessToken
    refreshToken: RefreshToken
    expiry: Option.Option<number>
  }) => Effect.Effect<void, AccountRepoError>
  readonly persistAccount: (input: {
    id: AccountID
    email: string
    url: string
    accessToken: AccessToken
    refreshToken: RefreshToken
    expiry: number
    orgID: Option.Option<OrgID>
  }) => Effect.Effect<void, AccountRepoError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/AccountRepo") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decode = Schema.decodeUnknownSync(Info)
    const gate = yield* Semaphore.make(1)

    const query = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((cause) => new AccountRepoError({ message: "Database operation failed", cause })))

    const authority = Effect.fn("AccountRepo.authority")(() =>
      query(
        Effect.gen(function* () {
          const row = yield* db
            .select({ state: AccountStateTable, account: AccountTable })
            .from(AccountStateTable)
            .leftJoin(AccountTable, eq(AccountTable.id, AccountStateTable.active_account_id))
            .where(eq(AccountStateTable.id, ACCOUNT_STATE_ID))
            .get()
          if (!row) return { selectionRevision: 0, account: null, orgID: null }
          if (
            !Number.isSafeInteger(row.state.selection_revision) ||
            row.state.selection_revision < 0 ||
            (row.state.active_account_id !== null && !row.account)
          )
            return yield* new AccountRepoError({ message: "Account identity state is unavailable" })
          return Object.freeze({
            selectionRevision: row.state.selection_revision,
            account: row.account ? Object.freeze(row.account) : null,
            orgID: row.state.active_org_id,
          })
        }),
      ),
    )

    const current = () =>
      authority().pipe(
        Effect.map((value) => (value.account ? { ...value.account, active_org_id: value.orgID } : undefined)),
      )

    const state = (
      tx: Pick<Database.Interface["db"], "select" | "insert">,
      accountID: AccountID | null,
      orgID: OrgID | null,
    ) =>
      Effect.gen(function* () {
        const before = yield* tx
          .select()
          .from(AccountStateTable)
          .where(eq(AccountStateTable.id, ACCOUNT_STATE_ID))
          .get()
        const revision = before?.selection_revision ?? 0
        if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
          return yield* new AccountRepoError({ message: "Account selection revision is exhausted" })
        yield* tx
          .insert(AccountStateTable)
          .values({
            id: ACCOUNT_STATE_ID,
            active_account_id: accountID,
            active_org_id: orgID,
            selection_revision: revision + 1,
          })
          .onConflictDoUpdate({
            target: AccountStateTable.id,
            set: { active_account_id: accountID, active_org_id: orgID, selection_revision: revision + 1 },
          })
          .run()
      })

    const active = Effect.fn("AccountRepo.active")(() =>
      query(current()).pipe(Effect.map((row) => (row ? Option.some(decode(row)) : Option.none()))),
    )

    const list = Effect.fn("AccountRepo.list")(() =>
      query(
        db
          .select()
          .from(AccountTable)
          .all()
          .pipe(Effect.map((rows) => rows.map((row: AccountRow) => decode({ ...row, active_org_id: null })))),
      ),
    )

    const remove = Effect.fn("AccountRepo.remove")((accountID: AccountID) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const before = yield* tx
              .select()
              .from(AccountStateTable)
              .where(eq(AccountStateTable.id, ACCOUNT_STATE_ID))
              .get()
            // Retain and advance the local-principal epoch even when the last account is removed.
            yield* state(
              tx,
              before?.active_account_id === accountID ? null : (before?.active_account_id ?? null),
              before?.active_account_id === accountID ? null : (before?.active_org_id ?? null),
            )
            yield* tx.delete(AccountTable).where(eq(AccountTable.id, accountID)).run()
          }),
        ),
      ).pipe(gate.withPermit, Effect.asVoid),
    )

    const use = Effect.fn("AccountRepo.use")(
      (accountID: AccountID, orgID: Option.Option<OrgID>, expected: AccountRow) =>
        query(
          db.transaction((tx) =>
            Effect.gen(function* () {
              const row = yield* tx.select().from(AccountTable).where(eq(AccountTable.id, accountID)).get()
              if (!row || !sameAccount(row, expected))
                return yield* new AccountRepoError({ message: "Account changed during verification" })
              if (row.identity_generation === null)
                yield* tx
                  .update(AccountTable)
                  .set({ identity_generation: randomBytes(32).toString("hex") })
                  .where(eq(AccountTable.id, accountID))
                  .run()
              yield* state(tx, accountID, Option.getOrNull(orgID))
            }),
          ),
        ).pipe(gate.withPermit, Effect.asVoid),
    )

    const getRow = Effect.fn("AccountRepo.getRow")((accountID: AccountID) =>
      query(db.select().from(AccountTable).where(eq(AccountTable.id, accountID)).get()).pipe(
        Effect.map(Option.fromNullishOr),
      ),
    )

    const persistToken = Effect.fn("AccountRepo.persistToken")((input) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(AccountTable).where(eq(AccountTable.id, input.accountID)).get()
            if (!row || !sameAccount(row, input.expected))
              return yield* new AccountRepoError({ message: "Account changed during token refresh" })
            yield* tx
              .update(AccountTable)
              .set({
                access_token: input.accessToken,
                refresh_token: input.refreshToken,
                token_expiry: Option.getOrNull(input.expiry),
              })
              .where(eq(AccountTable.id, input.accountID))
              .run()
          }),
        ),
      ).pipe(gate.withPermit, Effect.asVoid),
    )

    const persistAccount = Effect.fn("AccountRepo.persistAccount")((input) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const url = normalizeServerUrl(input.url)
            const existing = yield* tx.select().from(AccountTable).where(eq(AccountTable.id, input.id)).get()
            if (existing && existing.url !== url)
              return yield* new AccountRepoError({ message: "Account ID is already bound to another server" })
            const generation = randomBytes(32).toString("hex")

            yield* tx
              .insert(AccountTable)
              .values({
                id: input.id,
                email: input.email,
                url,
                access_token: input.accessToken,
                refresh_token: input.refreshToken,
                token_expiry: input.expiry,
                identity_generation: generation,
              })
              .onConflictDoUpdate({
                target: AccountTable.id,
                set: {
                  email: input.email,
                  url,
                  access_token: input.accessToken,
                  refresh_token: input.refreshToken,
                  token_expiry: input.expiry,
                  identity_generation: generation,
                },
              })
              .run()
            yield* state(tx, input.id, Option.getOrNull(input.orgID))
          }),
        ),
      ).pipe(gate.withPermit, Effect.asVoid),
    )

    return Service.of({
      authority,
      withIdentityGate: gate.withPermit,
      active,
      list,
      remove,
      use,
      getRow,
      persistToken,
      persistAccount,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as AccountRepo from "./repo"

function sameAccount(row: AccountRow, expected: AccountRow) {
  return (
    row.id === expected.id &&
    row.url === expected.url &&
    row.identity_generation === expected.identity_generation &&
    row.refresh_token === expected.refresh_token &&
    row.access_token === expected.access_token
  )
}
