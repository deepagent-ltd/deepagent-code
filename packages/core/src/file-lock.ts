export * as FileLock from "./file-lock"

/**
 * FileLockService — 人/Agent 编辑锁 (V3.7 Phase 4.1C)
 *
 * 进程内内存锁。人锁（human）优先于 Agent 锁：
 *   - human 锁存在时 agent acquire 返回 null（被阻止）
 *   - human 可强制获取已有 agent 锁的文件
 *
 * TTL: human 30s（前端每15s心跳续租）, agent 按写操作持续时间
 */
import { randomUUID } from "node:crypto"
import { Context, Layer } from "effect"

export type LockKind = "human" | "agent"

export interface FileLockEntry {
  readonly lockId: string
  readonly path: string       // 规范化绝对路径
  readonly kind: LockKind
  readonly expiresAt: number  // Date.now() + TTL ms
}

export const HUMAN_LOCK_TTL_MS = 30_000
export const AGENT_LOCK_TTL_MS = 60_000  // 单次写操作上限

export interface Interface {
  /** 获取锁。human 锁覆盖 agent 锁；同类锁冲突返回 null。 */
  acquire(path: string, kind: LockKind): FileLockEntry | null
  /** 续租。lockId 不匹配返回 false（锁已被释放/覆盖）。 */
  renew(lockId: string): boolean
  /** 释放锁。lockId 不匹配时无副作用。 */
  release(lockId: string): void
  /** 查询当前锁状态（已过期自动返回 null 并清理）。 */
  status(path: string): FileLockEntry | null
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/FileLock") {}

export const layer = Layer.succeed(
  Service,
  (() => {
    /** path → FileLockEntry */
    const locks = new Map<string, FileLockEntry>()
    /** lockId → path (反向索引，用于 renew / release 快速查找) */
    const byId = new Map<string, string>()

    const gc = () => {
      const now = Date.now()
      for (const [path, entry] of locks) {
        if (entry.expiresAt <= now) {
          locks.delete(path)
          byId.delete(entry.lockId)
        }
      }
    }

    const status = (path: string): FileLockEntry | null => {
      const entry = locks.get(path)
      if (!entry) return null
      if (entry.expiresAt <= Date.now()) {
        locks.delete(path)
        byId.delete(entry.lockId)
        return null
      }
      return entry
    }

    const acquire = (path: string, kind: LockKind): FileLockEntry | null => {
      gc()
      const existing = status(path)
      if (existing) {
        // human 可以强制覆盖 agent 锁；其余情况拒绝
        if (kind === "human" && existing.kind === "agent") {
          // 覆盖：清理旧锁
          byId.delete(existing.lockId)
        } else {
          return null
        }
      }
      const ttl = kind === "human" ? HUMAN_LOCK_TTL_MS : AGENT_LOCK_TTL_MS
      const entry: FileLockEntry = {
        lockId: randomUUID(),
        path,
        kind,
        expiresAt: Date.now() + ttl,
      }
      locks.set(path, entry)
      byId.set(entry.lockId, path)
      return entry
    }

    const renew = (lockId: string): boolean => {
      const path = byId.get(lockId)
      if (!path) return false
      const entry = locks.get(path)
      if (!entry || entry.lockId !== lockId) return false
      const ttl = entry.kind === "human" ? HUMAN_LOCK_TTL_MS : AGENT_LOCK_TTL_MS
      const renewed: FileLockEntry = { ...entry, expiresAt: Date.now() + ttl }
      locks.set(path, renewed)
      return true
    }

    const release = (lockId: string): void => {
      const path = byId.get(lockId)
      if (!path) return
      const entry = locks.get(path)
      if (entry?.lockId === lockId) locks.delete(path)
      byId.delete(lockId)
    }

    return Service.of({ acquire, renew, release, status })
  })(),
)
