import { describe, expect, test } from "bun:test"
import { LLM, LLMClient, Provider } from "@deepagent-code/llm"
import { Route, Protocol } from "@deepagent-code/llm/route"
import { Provider as ProviderSubpath } from "@deepagent-code/llm/provider"
import { Anthropic, OpenAI, OpenAICompatible } from "@deepagent-code/llm/providers"
import {
  CloudflareAIGateway,
  CloudflareWorkersAI,
  OpenRouter,
  XAI,
  GitHubCopilot,
  AmazonBedrock,
  Azure,
  Google,
} from "@deepagent-code/llm/providers/compat"
import * as MainProviders from "@deepagent-code/llm/providers"
import { OpenAIChat, OpenAICompatibleChat, OpenAIResponses } from "@deepagent-code/llm/protocols"
import * as AnthropicMessages from "@deepagent-code/llm/protocols/anthropic-messages"

describe("public exports", () => {
  test("root exposes app-facing runtime APIs", () => {
    expect(LLM.request).toBeFunction()
    expect(LLMClient.Service).toBeFunction()
    expect(LLMClient.layer).toBeDefined()
    expect(Provider.make).toBeFunction()
    expect(ProviderSubpath.make).toBe(Provider.make)
  })

  test("route barrel exposes route-authoring APIs", () => {
    expect(Route.make).toBeFunction()
    expect(Protocol.make).toBeFunction()
  })

  test("provider barrels expose user-facing facades", () => {
    expect(OpenAI.model).toBeFunction()
    expect("OpenRouter" in MainProviders).toBe(false)
    expect("XAI" in MainProviders).toBe(false)
    expect("GitHubCopilot" in MainProviders).toBe(false)
    expect(OpenAI.provider.model).toBe(OpenAI.model)
    expect(OpenAI.provider.responses).toBe(OpenAI.responses)
    expect(OpenAI.provider.responsesWebSocket).toBe(OpenAI.responsesWebSocket)
    expect(OpenAI.configure({ apiKey: "fixture" }).responses).toBeFunction()
    expect(OpenAICompatible.deepseek.model).toBeFunction()
    expect(Anthropic.model).toBeFunction()
    expect(CloudflareAIGateway.configure).toBeFunction()
    expect(CloudflareAIGateway.configure({ accountId: "fixture", gatewayApiKey: "fixture" }).model).toBeFunction()
    expect(CloudflareWorkersAI.configure).toBeFunction()
    expect(CloudflareWorkersAI.configure({ accountId: "fixture", apiKey: "fixture" }).model).toBeFunction()
    expect(OpenRouter.model).toBeFunction()
    expect(OpenRouter.provider.model).toBe(OpenRouter.model)
    expect(XAI.model).toBeFunction()
    expect(XAI.provider.model).toBe(XAI.model)
    expect(XAI.provider.responses).toBe(XAI.responses)
    expect(XAI.provider.chat).toBe(XAI.chat)
    expect(XAI.configure({ apiKey: "fixture" }).responses("grok-4.3").route.id).toBe("openai-responses")
    expect(XAI.configure({ apiKey: "fixture" }).chat("grok-4.3").route.id).toBe("openai-compatible-chat")
    expect(
      GitHubCopilot.configure({ baseURL: "https://api.githubcopilot.test", apiKey: "fixture" }).model,
    ).toBeFunction()
    expect(AmazonBedrock.configure).toBeFunction()
    expect(Azure.configure).toBeFunction()
    expect(CloudflareAIGateway.configure).toBeFunction()
    expect(CloudflareWorkersAI.configure).toBeFunction()
    expect(Google.configure).toBeFunction()
  })

  test("protocol barrels expose supported low-level routes", () => {
    expect(OpenAIChat.route.id).toBe("openai-chat")
    expect(OpenAICompatibleChat.route.id).toBe("openai-compatible-chat")
    expect(OpenAIResponses.route.id).toBe("openai-responses")
    expect(OpenAIResponses.webSocketRoute.id).toBe("openai-responses-websocket")
    expect(AnthropicMessages.route.id).toBe("anthropic-messages")
  })
})
