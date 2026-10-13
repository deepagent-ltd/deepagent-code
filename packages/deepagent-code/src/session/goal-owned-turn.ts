export * as GoalOwnedTurn from "./goal-owned-turn"

import path from "node:path"
import { Effect, Exit, Option, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { GoalChild } from "@deepagent-code/core/deepagent/goal-child"
import { GoalChildSchema } from "@deepagent-code/core/deepagent/goal-child.schema"
import { GoalChildExecution } from "@deepagent-code/core/deepagent/goal-child-execution"
import { GoalChildPolicy } from "@deepagent-code/core/deepagent/goal-child-policy"
import { GoalChildResult } from "@deepagent-code/core/deepagent/goal-child-result"
import { GoalTickCheckpoint } from "@deepagent-code/core/deepagent/goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalTickExecution } from "./goal-tick-execution"
import { GoalChildPolicyHost } from "./goal-child-policy"
import { OwnedValidation } from "../deepagent/owned-validation"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { Location } from "@deepagent-code/core/location"
import { LocationMutation } from "@deepagent-code/core/location-mutation"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { AgentV2 } from "@deepagent-code/core/agent"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Policy } from "@deepagent-code/core/policy"
import { ServerCapabilities } from "@deepagent-code/core/server-capabilities"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { ShellScan } from "@deepagent-code/core/shell/scan"
import { BashTool } from "@deepagent-code/core/tool/bash"

const localEffects = GoalTickCheckpointV2.localEffectAuthority<OwnedValidation.Handle>({
  snapshot: (handle) => {
    const value = OwnedValidation.snapshot(handle)
    return value
      ? {
          instanceID: value.instanceID,
          handleID: value.handleID,
          commandHash: value.commandHash,
          cwdHash: value.cwdHash,
          profileHash: value.profileHash,
          containment:
            value.profile === "darwin-single-process-v1" ? ("single-process" as const) : ("posix-group" as const),
        }
      : undefined
  },
  inspect: (handle) => {
    const value = OwnedValidation.inspect(handle)
    if (!value) return
    const output = (stream: OwnedValidation.Output, name: "stdout" | "stderr") => ({
      // A stable field reference in this durable effect receipt, not a promise of retained full stdout.
      ref: `validation_${value.snapshot.handleID}_${name}`,
      hash: stream.hash,
      bytes: stream.bytes,
      truncated: stream.truncated,
    })
    return {
      instanceID: value.snapshot.instanceID,
      handleID: value.snapshot.handleID,
      commandHash: value.snapshot.commandHash,
      cwdHash: value.snapshot.cwdHash,
      profileHash: value.snapshot.profileHash,
      containment: value.containment,
      state: value.state,
      outcome: value.state === "unknown" ? null : value.outcome,
      stopProof: value.state === "unknown" ? ("unconfirmed" as const) : value.stopProof,
      exitCode: value.exitCode,
      signal: value.signal,
      stdout: value.state === "cancelled_before_dispatch" ? null : output(value.stdout, "stdout"),
      stderr: value.state === "cancelled_before_dispatch" ? null : output(value.stderr, "stderr"),
      startedAt: value.startedAt ?? 0,
      endedAt: value.endedAt,
    }
  },
})

/** This is the same tick fiber as owned roles. Cancellation preserves its cause after native cleanup,
 * and unknown effects halt the program before another command, grade, panel or rollback. */
export const validate = (input: {
  permitID: string
  frame: GoalTickExecution.Frame
  ordinal: number
  timeoutMs?: number
}) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const frames = yield* GoalTickExecution.Service
    yield* frames.current(input.frame)
    const source = yield* GoalTickCheckpoint.currentPermit(db, input.permitID)
    const commands = source.goal.initialization.spec.criteria.flatMap((criterion) =>
      criterion.kind === "tests_pass" ? criterion.commands : [],
    )
    const command = commands[input.ordinal]
    if (command === undefined) return yield* failure()
    const parent = yield* GoalControl.session(db, source.goal.session_id)
    const location = (yield* LocationServiceMap).get({
      directory: AbsolutePath.make(parent.directory),
      ...(parent.workspace_id ? { workspaceID: WorkspaceV2.ID.make(parent.workspace_id) } : {}),
    })
    const roster = yield* Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const journal = yield* GoalTickCheckpointV2.read(db, input.permitID)
      const worker = journal?.journal.program.roles[0]
      if (!agents.snapshot || worker?.kind !== "worker") return yield* failure()
      return {
        parent: yield* agents.snapshot(parent.agent ?? undefined),
        child: yield* agents.snapshot(worker.agent),
        policyHash: worker.policyHash,
      }
    }).pipe(Effect.provide(location))
    const currentRoster = Effect.gen(function* () {
      if (GoalChildPolicy.roleHash(roster.parent, roster.child) !== roster.policyHash) return yield* failure()
    })
    const authorize = Effect.gen(function* () {
      yield* frames.current(input.frame)
      yield* GoalTickCheckpointV2.requireParent(db, (yield* GoalTickCheckpointV2.read(db, input.permitID))!)
      yield* currentRoster
      const permission = yield* PermissionV2.Service
      const mutation = yield* LocationMutation.Service
      const fs = yield* FSUtil.Service
      const placement = yield* Location.Service
      const target = yield* mutation.resolve({ path: source.goal.directory, kind: "directory" })
      const principal = {
        sessionID: SessionSchema.ID.make(parent.id),
        agent: parent.agent ? AgentV2.ID.make(parent.agent) : undefined,
      }
      if (target.externalDirectory)
        yield* permission.assert({
          ...principal,
          ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
        })
      const root = yield* fs.realPath(placement.directory).pipe(Effect.catch(() => Effect.succeed(placement.directory)))
      const scanned = yield* Effect.scoped(
        Effect.gen(function* () {
          const tree = yield* Effect.acquireRelease(ShellScan.parse(command, false), (tree) =>
            Effect.sync(() => tree.delete()),
          )
          return yield* ShellScan.collect(
            {
              isDir: (file) => fs.isDir(file),
              // The fixed POSIX validation profile never needs Windows cygpath subprocess probes.
              lines: () => Effect.die("Validation permission scan cannot spawn a platform probe"),
            },
            tree.rootNode,
            target.canonical,
            false,
            "/bin/sh",
            (candidate) => FSUtil.contains(root, candidate),
          )
        }),
      ).pipe(Effect.option)
      const external = (Option.isSome(scanned) ? [...scanned.value.dirs] : [])
        .map((directory) => path.join(directory, "*").replaceAll("\\", "/"))
        .filter((resource) => resource !== target.externalDirectory?.resource)
      if (external.length)
        yield* permission.assert({ ...principal, action: "external_directory", resources: external, save: external })
      const patterns = Option.isSome(scanned) && scanned.value.patterns.size ? [...scanned.value.patterns] : [command]
      if (patterns.length)
        yield* permission.assert({
          ...principal,
          action: "bash",
          resources: patterns,
          save: Option.isSome(scanned) && scanned.value.always.size ? [...scanned.value.always] : [command],
        })
      const policy = yield* Policy.Service
      if (
        policy.hasStatements() &&
        ((yield* policy.evaluate(ServerCapabilities.Actions.shell, command, "allow")) === "deny" ||
          (BashTool.isGitPush(command) &&
            (yield* policy.evaluate(ServerCapabilities.Actions.gitPush, command, "allow")) === "deny"))
      )
        return yield* failure()
      // An approval can suspend this fiber. Recheck the actual parent/control after it resumes.
      yield* frames.current(input.frame)
      yield* GoalTickCheckpointV2.requireParent(db, (yield* GoalTickCheckpointV2.read(db, input.permitID))!)
      yield* currentRoster
    }).pipe(Effect.provide(location))
    const handle = yield* OwnedValidation.prepare({
      cwd: source.goal.directory,
      command,
      profile: "darwin-single-process-v1",
      timeoutMs: input.timeoutMs,
    })
    const proof = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const run = yield* restore(
          OwnedValidation.run(handle, {
            onPrepared: () =>
              frames
                .current(input.frame)
                .pipe(Effect.andThen(localEffects.prepare(db, { ...input, handle })), Effect.asVoid),
            onDispatch: () =>
              authorize.pipe(
                Effect.andThen(localEffects.dispatch(db, { ...input, handle })),
                Effect.andThen(currentRoster),
                Effect.asVoid,
              ),
          }),
        ).pipe(Effect.exit)
        // Native cleanup completes before this observation. Persist known stop facts even when the
        // body was interrupted; recording never restores the frame's permission to execute.
        const proof = OwnedValidation.inspect(handle)
        const journal = yield* GoalTickCheckpointV2.read(db, input.permitID)
        const prepared = journal?.journal.localEffects.some(
          (item) => item.handleID === OwnedValidation.snapshot(handle)?.handleID,
        )
        const recorded = yield* (proof && prepared ? localEffects.settle(db, { ...input, handle }) : Effect.void).pipe(
          Effect.exit,
        )
        if (Exit.isFailure(run)) return yield* Effect.failCause(run.cause)
        if (Exit.isFailure(recorded)) return yield* Effect.failCause(recorded.cause)
        return proof
      }),
    )
    if (
      !proof ||
      proof.state !== "exited" ||
      proof.containment !== "single-process" ||
      proof.snapshot.profile !== "darwin-single-process-v1" ||
      proof.stopProof !== "not_requested" ||
      proof.outcome === null ||
      proof.exitCode === null ||
      !proof.stdout.complete ||
      !proof.stderr.complete
    )
      return yield* failure()
    yield* frames.current(input.frame)
    return { pass: proof.outcome === "passed", receipt: proof }
  }).pipe(Effect.scoped)

const failure = () =>
  new GoalChildSchema.Error({
    code: "GOAL_CHILD_RECOVERY_REQUIRED",
    message: "Owned Goal stage did not produce a verified terminal result",
  })

/** Every role and finalizer uses the existing shared Session runner, never a model loop here. */
export const run = (input: {
  permitID: string
  frame: GoalTickExecution.Frame
  role: number
  text: string
  resultSchema?: Schema.Top & Schema.Decoder<unknown>
}) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessions = yield* SessionV2.Service
    const frames = yield* GoalTickExecution.Service
    const owned = yield* SessionExecution.requireOwned(yield* SessionExecution.Service)
    yield* frames.current(input.frame)
    const initial = yield* GoalTickCheckpointV2.read(db, input.permitID)
    if (!initial) return yield* failure()
    const activated = yield* GoalTickCheckpointV2.activate(db, {
      permitID: input.permitID,
      revision: initial.revision,
      role: input.role,
      text: input.text,
    })
    const role = activated.journal.program.roles[input.role]
    const policyFrame = frames.policy(input.frame)
    if (!policyFrame) return yield* failure()
    const policy = yield* GoalChildPolicyHost.prepare({
      version: 3,
      frame: policyFrame,
      permitID: input.permitID,
      roleKey: role.key,
      agent: role.agent,
      mode: role.mode,
      resultSchema: input.resultSchema,
    })
    const policyView = GoalChildPolicy.inspect(policy)
    if (!policyView) return yield* failure()
    const evidence: Array<Effect.Success<ReturnType<typeof GoalChildResult.recheck>>> = []
    const stages: GoalChildSchema.Stage[] =
      role.mode === "plain" ? ["plain"] : ["research", "finalizer.1", "finalizer.2"]
    for (const stage of stages) {
      yield* frames.current(input.frame)
      const before = (yield* GoalTickCheckpointV2.read(db, input.permitID))!
      if (before.journal.cursor.role !== input.role || before.journal.cursor.stage !== stage) return yield* failure()
      const text =
        stage === "plain" || stage === "research"
          ? input.text
          : `Return only a JSON value matching this schema. Do not execute tools or perform new research.\n${JSON.stringify(Schema.toJsonSchemaDocument(input.resultSchema!))}\n` +
            `Verified research result:\n${evidence[0].text}\n` +
            (stage === "finalizer.2"
              ? `The first finalizer was invalid. Correct its JSON without new work:\n${evidence[1].text}`
              : "")
      const admitted = yield* GoalChild.admitV2(db, sessions, {
        permitID: input.permitID,
        permitToken: (yield* GoalTickCheckpoint.currentPermit(db, input.permitID)).permit.token,
        roleKey: role.key,
        mode: role.mode,
        steeringHash: policyView.steeringHash,
        promptPolicyHash: policyView.promptPolicyHash,
        stage,
        text,
        policy,
      })
      if (role.scratch && stage === "plain") yield* GoalChildPolicyHost.prepareScratch(admitted.unit.unit_id, policy)
      yield* frames.current(input.frame)
      const started = yield* owned.run(GoalChildExecution.target(admitted.unit), {
        registered: (receipt) => frames.registered(input.frame, receipt),
      })
      if (started.status !== "started" && started.status !== "joined") return yield* failure()
      const settled = yield* owned.await(started.receipt)
      if (settled.status !== "settled") return yield* failure()
      if (Exit.isFailure(settled.exit)) return yield* Effect.failCause(settled.exit.cause)
      const proof = yield* GoalChildResult.inspect(db, admitted.unit.unit_id, stage)
      const facts = yield* GoalChildResult.recheck(db, proof)
      const recorded = yield* GoalTickCheckpointV2.recordResult(db, proof)
      evidence.push(facts)
      if (recorded.state === "recovery_required") return yield* failure()
      if (recorded.journal.cursor.role !== input.role) {
        yield* GoalChildPolicy.releaseRole(db, policyFrame, admitted.unit.unit_id)
        return { ...facts, stages: evidence }
      }
    }
    return yield* failure()
  })
