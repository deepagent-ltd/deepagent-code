import { ProviderID, type ModelID } from "../schema"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"
import * as OpenAICompatibleResponses from "../protocols/openai-compatible-responses"
import type { RouteDefaultsInput } from "../route/client"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { profiles, type OpenAICompatibleProfile } from "./openai-compatible-profile"

export const id = ProviderID.make("openai-compatible")

type GenericModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly provider?: string
    readonly baseURL: string
  }

export type FamilyModelOptions = RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
  }

export const routes = [OpenAICompatibleResponses.route, OpenAICompatibleChat.route]

export const configure = (input: GenericModelOptions) => {
  const provider = input.provider ?? "openai-compatible"
  const { provider: _, baseURL, apiKey: _apiKey, auth: _auth, ...rest } = input
  const patch = {
    ...rest,
    provider,
    endpoint: { baseURL },
    auth: AuthOptions.bearer(input, []),
  }
  const chatRoute = OpenAICompatibleChat.route.with(patch)
  const responsesRoute = OpenAICompatibleResponses.route.with(patch)
  const chat = (modelID: string | ModelID) =>
    chatRoute.model({ id: modelID, provider: ProviderID.make(provider) })
  const responses = (modelID: string | ModelID) =>
    responsesRoute.model({ id: modelID, provider: ProviderID.make(provider) })
  return {
    id: ProviderID.make(provider),
    model: chat,
    chat,
    responses,
    configure,
  }
}

const define = (profile: OpenAICompatibleProfile) => {
  const configureProfile = (input: FamilyModelOptions = {}) => {
    const facade = configure({
      ...input,
      baseURL: input.baseURL ?? profile.baseURL,
      provider: profile.provider,
    })
    return {
      id: ProviderID.make(profile.provider),
      model: facade.model,
      chat: facade.chat,
      responses: facade.responses,
      configure: configureProfile,
    }
  }
  return configureProfile()
}

export const provider = {
  id,
  configure,
}

export const baseten = define(profiles.baseten)
export const cerebras = define(profiles.cerebras)
export const deepinfra = define(profiles.deepinfra)
export const deepseek = define(profiles.deepseek)
export const fireworks = define(profiles.fireworks)
export const groq = define(profiles.groq)
export const togetherai = define(profiles.togetherai)
