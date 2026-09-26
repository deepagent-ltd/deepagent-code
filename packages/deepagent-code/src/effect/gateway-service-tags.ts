import { LLMClient } from "@deepagent-code/llm/route"
import { Database } from "@deepagent-code/core/database/database"
import { ModelsDev } from "@deepagent-code/core/models-dev"
import { SessionV2 } from "@deepagent-code/core/session"
import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "./runtime-flags"

// Keep the digest's live service proof and the gateway handler's dependencies in one inventory.
export const gatewayServiceTags = {
  database: Database.Service,
  store: InstanceStore.Service,
  provider: Provider.Service,
  auth: Auth.Service,
  client: LLMClient.Service,
  events: EventV2Bridge.Service,
  modelsDev: ModelsDev.Service,
  sessions: SessionV2.Service,
  flags: RuntimeFlags.Service,
} as const
