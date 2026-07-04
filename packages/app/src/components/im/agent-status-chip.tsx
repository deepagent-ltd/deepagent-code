import { createMemo } from "solid-js"

interface AgentStatusChipProps {
  agentID: string
  status: string
}

export function AgentStatusChip(props: AgentStatusChipProps) {
  const getStatusColor = createMemo(() => {
    switch (props.status) {
      case "started":
      case "running":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
      case "success":
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
      case "failed":
        return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
      case "timeout":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200"
    }
  })

  const getStatusIcon = createMemo(() => {
    switch (props.status) {
      case "started":
      case "running":
        return "⏳"
      case "success":
        return "✓"
      case "failed":
        return "✗"
      case "timeout":
        return "⏱"
      default:
        return "•"
    }
  })

  return (
    <div class={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getStatusColor()}`}>
      <span>{getStatusIcon()}</span>
      <span>Agent {props.agentID}</span>
      <span>•</span>
      <span>{props.status}</span>
    </div>
  )
}
