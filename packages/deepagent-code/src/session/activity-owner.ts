import { randomUUID } from "node:crypto"

export const processOwnerToken = `${process.pid}:${randomUUID()}`

export * as SessionActivityOwner from "./activity-owner"
