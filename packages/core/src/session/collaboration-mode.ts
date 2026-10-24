export const collaborationModeNames = ["auto", "plan", "loop", "design"] as const

export type CollaborationModeName = (typeof collaborationModeNames)[number]

export const isCollaborationModeName = (value: unknown): value is CollaborationModeName =>
  typeof value === "string" && collaborationModeNames.some((mode) => mode === value)

export const configuredCollaborationMode = (name?: string) => (name === "build" ? "auto" : (name ?? "auto"))

export const isSelectableCollaborationMode = (agent: { name: string; mode: string; hidden?: boolean }) =>
  agent.mode === "primary" && !agent.hidden && isCollaborationModeName(agent.name)

export * as CollaborationMode from "./collaboration-mode"
