import { expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { IMKernelSync } from "@/im/kernel/sync"
import { bodies, cases, ready } from "./fixture/kernel-sync-current"

cases(import.meta.path, [
  {
    id: "org-current-group",
    name: "an inspected current workspace reader provisions the org group and seats its local operator",
    run: (state) =>
      Effect.gen(function* () {
        expect(yield* state.database.db.get(sql`SELECT count(*) n FROM im_groups`)).toEqual({ n: 0 })
        const groupID = yield* state.lease.reader.pending({
          conversationType: 2,
          conversationID: "org7",
          name: "全员群",
        })
        expect(
          yield* state.database.db.get(
            sql`SELECT id,name,workspace_id,kernel_conv_id FROM im_groups WHERE id=${groupID}`,
          ),
        ).toMatchObject({ id: groupID, name: "全员群", workspace_id: state.lease.workspaceID })
        expect((yield* state.repo.getGroupByID(groupID))?.kernelConvID).toStartWith("kr1:")
        yield* state.lease.reader.withOutput(
          { workspaceID: state.lease.workspaceID, userID: "server", groupIDs: [groupID] },
          Effect.gen(function* () {
            expect((yield* state.repo.getGroup({ groupID, userID: "server" }))?.id).toBe(groupID)
          }),
        )
        expect(state.inspected).toContainEqual({ conversationType: 2, conversationID: "org7", senderID: "receiver" })
        expect(
          yield* state.database.db.get(
            sql`SELECT count(*) n FROM im_members WHERE group_id=${groupID} AND member_id='server'`,
          ),
        ).toEqual({ n: 1 })
      }),
  },
  {
    id: "org-idempotent",
    name: "repeated authenticated org-group provisioning preserves one group, one membership and original creation time",
    run: (state) =>
      Effect.gen(function* () {
        const first = yield* state.lease.reader.pending({ conversationType: 2, conversationID: "org7", name: "全员群" })
        const before = yield* state.repo.getGroupByID(first)
        const second = yield* state.lease.reader.pending({
          conversationType: 2,
          conversationID: "org7",
          name: "全员群",
        })
        expect(second).toBe(first)
        expect((yield* state.repo.getGroupByID(second))?.createdAt).toBe(before?.createdAt)
        expect(
          yield* state.database.db.get(
            sql`SELECT count(*) n FROM im_groups WHERE workspace_id=${state.lease.workspaceID}`,
          ),
        ).toEqual({ n: 1 })
        expect(
          yield* state.database.db.get(
            sql`SELECT count(*) n FROM im_members WHERE group_id=${first} AND member_id='server'`,
          ),
        ).toEqual({ n: 1 })
      }),
  },
  {
    id: "org-inbound",
    name: "an authenticated org projection binds the pending group and broadcasts its actual incoming body",
    run: (state) =>
      Effect.gen(function* () {
        const groupID = yield* state.lease.reader.pending({
          conversationType: 2,
          conversationID: "org7",
          name: "全员群",
        })
        state.remote.add(2, "org7", "org-message", { sender: "member-bob" })
        yield* ready(state)
        expect(yield* bodies(state)).toMatchObject([
          {
            message_id: "org-message",
            sender_id: "member-bob",
            content: JSON.stringify({ content: "original org-message" }),
            local_group_id: groupID,
          },
        ])
        expect(state.broadcasts).toContainEqual({ groupID, type: "reader_changed" })
        expect(
          (yield* KernelReader.projection(state.lease.reader.runtime, state.remote.conversation(2, "org7").key))
            ?.local_group_id,
        ).toBe(groupID)
      }),
  },
  {
    id: "org-retired-global",
    name: "retired global org provisioning and catch-up cannot manufacture a workspace mirror or admit work",
    run: (state) =>
      Effect.gen(function* () {
        yield* IMKernelSync.provisionOrgAllGroup(state.repo, state.config.identity!, state.lease.workspaceID)
        yield* IMKernelSync.provisionOrgAllGroup(state.repo, state.config.identity!, state.lease.workspaceID)
        yield* state.sync.catchUp
        expect(yield* state.database.db.get(sql`SELECT count(*) n FROM im_groups`)).toEqual({ n: 0 })
        expect(yield* bodies(state)).toEqual([])
        expect(state.legacy.reads).toBe(0)
        expect(state.remote.sent).toHaveLength(0)
      }),
  },
])
