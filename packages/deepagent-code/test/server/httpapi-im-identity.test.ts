import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { GroupID } from "@deepagent-code/core/im/id"
import { AppRuntime } from "@/effect/app-runtime"
import { MemberTable } from "@deepagent-code/core/im/sql"
import { Server } from "@/server/server"
import { IMPaths } from "@/server/routes/instance/httpapi/groups/im"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(resetDatabase)

test("HTTP retries preserve request identity, reject conflicts, and re-check current group membership", async () => {
  await using directory = await tmpdir({ git: true })
  await AppRuntime.runPromise(Database.Service)
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const groupResponse = await fetch(
      new URL(`${IMPaths.groups}?directory=${encodeURIComponent(directory.path)}`, listener.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "project", name: "Requests" }),
      },
    )
    expect(groupResponse.status).toBe(200)
    const group = (await groupResponse.json()) as { id: string }
    const url = new URL(
      `${IMPaths.createMessage.replace(":groupId", group.id)}?directory=${encodeURIComponent(directory.path)}`,
      listener.url,
    )
    const send = (content: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ senderType: "user", type: "text", content, clientRequestID: "lost-ack-1" }),
      })
    const first = await send("persisted once")
    expect(first.status).toBe(200)
    const message = (await first.json()) as { id: string }
    const retry = await send("persisted once")
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { id: string }).id).toBe(message.id)
    const changed = await send("changed payload")
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ name: "MESSAGE_IDENTITY_CONFLICT" })
    const listed = await fetch(url)
    expect(((await listed.json()) as { messages: unknown[] }).messages).toHaveLength(1)
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        yield* (yield* Database.Service).db
          .delete(MemberTable)
          .where(and(eq(MemberTable.group_id, GroupID.make(group.id)), eq(MemberTable.member_id, "server")))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    expect((await send("persisted once")).status).toBe(404)
  } finally {
    await listener.stop(true)
  }
}, 60_000)
