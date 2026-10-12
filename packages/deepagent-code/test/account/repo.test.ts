import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { sql } from "drizzle-orm"

import { AccountRepo } from "../../src/account/repo"
import { AccessToken, AccountID, OrgID, RefreshToken } from "../../src/account/schema"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "../lib/effect"

const truncate = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`DELETE FROM account_state`)
    yield* db.run(sql`DELETE FROM account`)
  }),
).pipe(Layer.provide(Database.defaultLayer))

const it = testEffect(Layer.mergeAll(AccountRepo.defaultLayer, truncate, Database.defaultLayer))

it.live("list returns empty when no accounts exist", () =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo.use.list()
    expect(accounts).toEqual([])
  }),
)

it.live("active returns none when no accounts exist", () =>
  Effect.gen(function* () {
    const active = yield* AccountRepo.use.active()
    expect(Option.isNone(active)).toBe(true)
  }),
)

it.live("persistAccount inserts and getRow retrieves", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")
    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_123"),
        refreshToken: RefreshToken.make("rt_456"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    const row = yield* AccountRepo.use.getRow(id)
    expect(Option.isSome(row)).toBe(true)
    const value = Option.getOrThrow(row)
    expect(value.id).toBe(AccountID.make("user-1"))
    expect(value.email).toBe("test@example.com")

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-1"))
  }),
)

it.live("persistAccount normalizes trailing slashes in stored server URLs", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com/",
        accessToken: AccessToken.make("at_123"),
        refreshToken: RefreshToken.make("rt_456"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    const row = yield* AccountRepo.use.getRow(id)
    const active = yield* AccountRepo.use.active()
    const list = yield* AccountRepo.use.list()

    expect(Option.getOrThrow(row).url).toBe("https://control.example.com")
    expect(Option.getOrThrow(active).url).toBe("https://control.example.com")
    expect(list[0]?.url).toBe("https://control.example.com")
  }),
)

it.live("persistAccount sets the active account and org", () =>
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id1,
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id2,
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    // Last persisted account is active with its org
    const active = yield* AccountRepo.use.active()
    expect(Option.isSome(active)).toBe(true)
    expect(Option.getOrThrow(active).id).toBe(AccountID.make("user-2"))
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-2"))
  }),
)

it.live("list returns all accounts", () =>
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id1,
        email: "a@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id2,
        email: "b@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    const accounts = yield* AccountRepo.use.list()
    expect(accounts.length).toBe(2)
    expect(accounts.map((a) => a.email).sort()).toEqual(["a@example.com", "b@example.com"])
  }),
)

it.live("remove deletes an account", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.use.remove(id)

    const row = yield* AccountRepo.use.getRow(id)
    expect(Option.isNone(row)).toBe(true)
  }),
)

it.live("use stores the selected org and marks the account active", () =>
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id1,
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id: id2,
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_2"),
        refreshToken: RefreshToken.make("rt_2"),
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    const expected = Option.getOrThrow(yield* AccountRepo.use.getRow(id1))
    yield* AccountRepo.Service.use((r) => r.use(id1, Option.some(OrgID.make("org-99")), expected))
    const active1 = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active1).id).toBe(id1)
    expect(Option.getOrThrow(active1).active_org_id).toBe(OrgID.make("org-99"))

    yield* AccountRepo.Service.use((r) => r.use(id1, Option.none(), expected))
    const active2 = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active2).active_org_id).toBeNull()
  }),
)

it.live("persistToken updates token fields", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("old_token"),
        refreshToken: RefreshToken.make("old_refresh"),
        expiry: 1000,
        orgID: Option.none(),
      }),
    )

    const expiry = Date.now() + 7200_000
    const expected = Option.getOrThrow(yield* AccountRepo.use.getRow(id))
    yield* AccountRepo.Service.use((r) =>
      r.persistToken({
        accountID: id,
        expected,
        accessToken: AccessToken.make("new_token"),
        refreshToken: RefreshToken.make("new_refresh"),
        expiry: Option.some(expiry),
      }),
    )

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("new_token"))
    expect(value.refresh_token).toBe(RefreshToken.make("new_refresh"))
    expect(value.token_expiry).toBe(expiry)
  }),
)

it.live("persistToken with no expiry sets token_expiry to null", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("old_token"),
        refreshToken: RefreshToken.make("old_refresh"),
        expiry: 1000,
        orgID: Option.none(),
      }),
    )

    const expected = Option.getOrThrow(yield* AccountRepo.use.getRow(id))
    yield* AccountRepo.Service.use((r) =>
      r.persistToken({
        accountID: id,
        expected,
        accessToken: AccessToken.make("new_token"),
        refreshToken: RefreshToken.make("new_refresh"),
        expiry: Option.none(),
      }),
    )

    const row = yield* AccountRepo.use.getRow(id)
    expect(Option.getOrThrow(row).token_expiry).toBeNull()
  }),
)

it.live("persistAccount upserts on conflict", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_v1"),
        refreshToken: RefreshToken.make("rt_v1"),
        expiry: 1000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_v2"),
        refreshToken: RefreshToken.make("rt_v2"),
        expiry: 2000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    const accounts = yield* AccountRepo.use.list()
    expect(accounts.length).toBe(1)

    const row = yield* AccountRepo.use.getRow(id)
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe(AccessToken.make("at_v2"))

    const active = yield* AccountRepo.use.active()
    expect(Option.getOrThrow(active).active_org_id).toBe(OrgID.make("org-2"))
  }),
)

it.live("remove clears active state when deleting the active account", () =>
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.Service.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: AccessToken.make("at_1"),
        refreshToken: RefreshToken.make("rt_1"),
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    yield* AccountRepo.use.remove(id)

    const active = yield* AccountRepo.use.active()
    expect(Option.isNone(active)).toBe(true)
  }),
)

it.live("getRow returns none for nonexistent account", () =>
  Effect.gen(function* () {
    const row = yield* AccountRepo.Service.use((r) => r.getRow(AccountID.make("nope")))
    expect(Option.isNone(row)).toBe(true)
  }),
)

it.live("identity generations and selection epochs fence stale refresh and verified selection", () =>
  Effect.gen(function* () {
    const repo = yield* AccountRepo.Service
    const id = AccountID.make("identity-fence")
    const login = {
      id,
      email: "fixture@example.invalid",
      url: "https://identity.example.invalid",
      accessToken: AccessToken.make("first"),
      refreshToken: RefreshToken.make("refresh-first"),
      expiry: Date.now() + 3600000,
      orgID: Option.some(OrgID.make("org-a")),
    }
    yield* repo.persistAccount(login)
    const first = yield* repo.authority()
    expect(first.account?.identity_generation).toMatch(/^[a-f0-9]{64}$/)
    expect(first.selectionRevision).toBe(1)
    const captured = Option.getOrThrow(yield* repo.getRow(id))
    yield* repo.persistAccount({
      ...login,
      accessToken: AccessToken.make("second"),
      refreshToken: RefreshToken.make("refresh-second"),
    })
    const second = yield* repo.authority()
    expect(second.selectionRevision).toBe(2)
    expect(second.account?.identity_generation).not.toBe(first.account?.identity_generation)
    expect(
      (yield* repo
        .persistToken({
          accountID: id,
          expected: captured,
          accessToken: AccessToken.make("late"),
          refreshToken: RefreshToken.make("late"),
          expiry: Option.none(),
        })
        .pipe(Effect.exit))._tag,
    ).toBe("Failure")
    expect((yield* repo.use(id, Option.none(), captured).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* repo.authority()).toEqual(second)
    expect(
      (yield* repo.persistAccount({ ...login, url: "https://another.example.invalid" }).pipe(Effect.exit))._tag,
    ).toBe("Failure")
    expect(yield* repo.authority()).toEqual(second)
    yield* repo.remove(id)
    expect(yield* repo.authority()).toEqual({ selectionRevision: 3, account: null, orgID: null })
  }),
)

it.live("a failed epoch increment rolls back account insertion in the same transaction", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.run(sql`INSERT INTO account_state(id,selection_revision) VALUES(1,9007199254740991)`)
    const result = yield* AccountRepo.use
      .persistAccount({
        id: AccountID.make("overflow"),
        email: "fixture@example.invalid",
        url: "https://identity.example.invalid",
        accessToken: AccessToken.make("token"),
        refreshToken: RefreshToken.make("refresh"),
        expiry: 1,
        orgID: Option.none(),
      })
      .pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(yield* AccountRepo.use.list()).toEqual([])
    expect((yield* AccountRepo.use.authority()).selectionRevision).toBe(Number.MAX_SAFE_INTEGER)
  }),
)
