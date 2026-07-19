import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@deepagent-code/ui/context"
import type { PermissionRequest } from "@deepagent-code/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "./server-sync"
import { useParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  isDirectoryReadOnly,
  isMutatingPermission,
  autoRespondsPermission,
} from "./permission-auto-respond"

export type DirectoryApprovalMode = "read-only" | "request" | "full-access"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const params = useParams()
    const serverSDK = useServerSDK()
    const serverSync = useServerSync()

    const permissionsEnabled = createMemo(() => {
      const directory = decode64(params.dir)
      if (!directory) return false
      const [store] = serverSync.child(directory)
      return hasPermissionPromptRules(store.config.permission)
    })

    // Tri-state Read-Only / Request / Full-Access: v4 adds a parallel `readOnly` directory map
    // alongside the pre-existing `autoAccept` map (the two are mutually exclusive per directory).
    // Back-compat: the live persisted key is "permission" (the "v3"/"v4" naming lives in the shape,
    // not the storage key — the real key was never "permission.v3"). We keep the key unchanged so
    // existing data is read in place, and version the shape additively: `migrate` back-fills the new
    // `readOnly` map and `merge` supplies the default, so an existing auto-accepting directory keeps
    // its `autoAccept` entry and reads back as "full-access" with no data loss.
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.serverGlobal(serverSDK.scope, "permission", ["permission.v3"]),
        migrate(value) {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value

          const data = value as Record<string, unknown>
          const withAutoAccept = data.autoAccept
            ? data
            : {
                ...data,
                autoAccept:
                  typeof data.autoAcceptEdits === "object" &&
                  data.autoAcceptEdits &&
                  !Array.isArray(data.autoAcceptEdits)
                    ? data.autoAcceptEdits
                    : {},
              }

          if (
            (withAutoAccept as Record<string, unknown>).readOnly &&
            typeof (withAutoAccept as Record<string, unknown>).readOnly === "object"
          ) {
            return withAutoAccept
          }

          return { ...withAutoAccept, readOnly: {} }
        },
      },
      createStore({
        autoAccept: {} as Record<string, boolean>,
        readOnly: {} as Record<string, boolean>,
      }),
    )

    // When config has permission: "allow", auto-enable directory-level auto-accept
    createEffect(() => {
      if (!ready()) return
      const directory = decode64(params.dir)
      if (!directory) return
      const [childStore] = serverSync.child(directory)
      const perm = childStore.config.permission
      if (typeof perm === "string" && perm === "allow") {
        const key = directoryAcceptKey(directory)
        if (store.autoAccept[key] === undefined) {
          setStore(
            produce((draft) => {
              draft.autoAccept[key] = true
            }),
          )
        }
      }
    })

    const MAX_RESPONDED = 1000
    const RESPONDED_TTL_MS = 60 * 60 * 1000
    const responded = new Map<string, number>()
    const enableVersion = new Map<string, number>()

    function pruneResponded(now: number) {
      for (const [id, ts] of responded) {
        if (now - ts < RESPONDED_TTL_MS) break
        responded.delete(id)
      }

      for (const id of responded.keys()) {
        if (responded.size <= MAX_RESPONDED) break
        responded.delete(id)
      }
    }

    const respond: PermissionRespondFn = (input) => {
      serverSDK.client.permission.respond(input).catch(() => {
        responded.delete(input.permissionID)
      })
    }

    function respondOnce(permission: PermissionRequest, directory?: string) {
      const now = Date.now()
      const hit = responded.has(permission.id)
      responded.delete(permission.id)
      responded.set(permission.id, now)
      pruneResponded(now)
      if (hit) return
      respond({
        sessionID: permission.sessionID,
        permissionID: permission.id,
        response: "once",
        directory,
      })
    }

    function isAutoAccepting(sessionID: string, directory?: string) {
      const session = directory ? serverSync.child(directory, { bootstrap: false })[0].session : []
      return autoRespondsPermission(store.autoAccept, session, { sessionID }, directory)
    }

    function isAutoAcceptingDirectory(directory: string) {
      return isDirectoryAutoAccepting(store.autoAccept, directory)
    }

    function isDirectoryReadOnlyMode(directory: string) {
      return isDirectoryReadOnly(store.readOnly, directory)
    }

    function shouldAutoRespond(permission: PermissionRequest, directory?: string) {
      const session = directory ? serverSync.child(directory, { bootstrap: false })[0].session : []
      return autoRespondsPermission(store.autoAccept, session, permission, directory)
    }

    // Read-only is a directory-level guard: auto-REJECT any mutating tool (edit/write/bash/…)
    // while leaving read-style tools to the normal flow. The mirror image of full-access
    // auto-approve. Directory-scoped only (session-lineage overrides are auto-accept's concern).
    function shouldAutoReject(permission: PermissionRequest, directory?: string) {
      if (!directory) return false
      if (!isDirectoryReadOnlyMode(directory)) return false
      return isMutatingPermission(permission.permission)
    }

    function respondReject(permission: PermissionRequest, directory?: string) {
      const now = Date.now()
      const hit = responded.has(permission.id)
      responded.delete(permission.id)
      responded.set(permission.id, now)
      pruneResponded(now)
      if (hit) return
      respond({
        sessionID: permission.sessionID,
        permissionID: permission.id,
        response: "reject",
        directory,
      })
    }

    function bumpEnableVersion(sessionID: string, directory?: string) {
      const key = acceptKey(sessionID, directory)
      const next = (enableVersion.get(key) ?? 0) + 1
      enableVersion.set(key, next)
      return next
    }

    const unsubscribe = serverSDK.event.listen((e) => {
      const event = e.details
      if (event?.type !== "permission.asked") return

      const perm = event.properties
      if (shouldAutoReject(perm, e.name)) {
        respondReject(perm, e.name)
        return
      }
      if (!shouldAutoRespond(perm, e.name)) return

      respondOnce(perm, e.name)
    })
    onCleanup(unsubscribe)

    function enableDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = true
          // full-access and read-only are mutually exclusive.
          draft.readOnly[key] = false
        }),
      )

      serverSDK.client.permission
        .list({ directory })
        .then((x) => {
          if (!isAutoAcceptingDirectory(directory)) return
          for (const perm of x.data ?? []) {
            if (!perm?.id) continue
            if (!shouldAutoRespond(perm, directory)) continue
            respondOnce(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function disableDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = false
        }),
      )
    }

    // Read-only directory mode: mirror of enableDirectory, but eagerly REJECTS the pending
    // mutating requests instead of approving them.
    function enableReadOnlyDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.readOnly[key] = true
          // read-only and full-access are mutually exclusive.
          draft.autoAccept[key] = false
        }),
      )

      serverSDK.client.permission
        .list({ directory })
        .then((x) => {
          if (!isDirectoryReadOnlyMode(directory)) return
          for (const perm of x.data ?? []) {
            if (!perm?.id) continue
            if (!shouldAutoReject(perm, directory)) continue
            respondReject(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function disableReadOnlyDirectory(directory: string) {
      const key = directoryAcceptKey(directory)
      setStore(
        produce((draft) => {
          draft.readOnly[key] = false
        }),
      )
    }

    function directoryApprovalMode(directory: string): DirectoryApprovalMode {
      if (isAutoAcceptingDirectory(directory)) return "full-access"
      if (isDirectoryReadOnlyMode(directory)) return "read-only"
      return "request"
    }

    function setDirectoryApprovalMode(directory: string, mode: DirectoryApprovalMode) {
      if (directoryApprovalMode(directory) === mode) return
      switch (mode) {
        case "full-access":
          disableReadOnlyDirectory(directory)
          enableDirectory(directory)
          return
        case "read-only":
          disableDirectory(directory)
          enableReadOnlyDirectory(directory)
          return
        default:
          disableDirectory(directory)
          disableReadOnlyDirectory(directory)
      }
    }

    function enable(sessionID: string, directory: string) {
      const key = acceptKey(sessionID, directory)
      const version = bumpEnableVersion(sessionID, directory)
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = true
          delete draft.autoAccept[sessionID]
        }),
      )

      serverSDK.client.permission
        .list({ directory })
        .then((x) => {
          if (enableVersion.get(key) !== version) return
          if (!isAutoAccepting(sessionID, directory)) return
          for (const perm of x.data ?? []) {
            if (!perm?.id) continue
            if (!shouldAutoRespond(perm, directory)) continue
            respondOnce(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function disable(sessionID: string, directory?: string) {
      bumpEnableVersion(sessionID, directory)
      const key = directory ? acceptKey(sessionID, directory) : sessionID
      setStore(
        produce((draft) => {
          draft.autoAccept[key] = false
          if (!directory) return
          delete draft.autoAccept[sessionID]
        }),
      )
    }

    return {
      ready,
      respond,
      autoResponds(permission: PermissionRequest, directory?: string) {
        return shouldAutoRespond(permission, directory)
      },
      autoRejects(permission: PermissionRequest, directory?: string) {
        return shouldAutoReject(permission, directory)
      },
      isAutoAccepting,
      isAutoAcceptingDirectory,
      // Tri-state directory approval mode (Read-Only / Request / Full-Access).
      // isAutoAcceptingDirectory / toggleAutoAcceptDirectory remain valid: full-access == auto-accept.
      directoryApprovalMode,
      setDirectoryApprovalMode,
      isDirectoryReadOnly: isDirectoryReadOnlyMode,
      toggleAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) {
          disable(sessionID, directory)
          return
        }

        enable(sessionID, directory)
      },
      toggleAutoAcceptDirectory(directory: string) {
        if (isAutoAcceptingDirectory(directory)) {
          disableDirectory(directory)
          return
        }
        enableDirectory(directory)
      },
      enableAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) return
        enable(sessionID, directory)
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        disable(sessionID, directory)
      },
      permissionsEnabled,
      isPermissionAllowAll(directory: string) {
        const [childStore] = serverSync.child(directory)
        const perm = childStore.config.permission
        return typeof perm === "string" && perm === "allow"
      },
    }
  },
})
