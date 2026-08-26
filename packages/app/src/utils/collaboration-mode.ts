export const collaborationModeNames = ["auto", "loop", "design"] as const
export type CollaborationModeName = (typeof collaborationModeNames)[number]

const collaborationModeSet = new Set<string>(collaborationModeNames)

export const isCollaborationModeName = (name: string): name is CollaborationModeName =>
  collaborationModeSet.has(name)

export const isSelectableCollaborationMode = (agent: { name: string; mode: string; hidden?: boolean }) =>
  agent.mode === "primary" && !agent.hidden && isCollaborationModeName(agent.name)
