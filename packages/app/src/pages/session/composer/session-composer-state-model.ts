import type { Todo } from "@deepagent-code/sdk/v2"

export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "clear" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live) return "clear"
  if (!input.done) return "open"
  return "close"
}

export const planStepTodoStatus = (status: string): Todo["status"] => {
  const value = status.trim().toLowerCase()
  if (value === "active" || value === "in_progress") return "in_progress"
  if (value === "done" || value === "completed") return "completed"
  if (value === "cancelled" || value === "canceled") return "cancelled"
  return "pending"
}
