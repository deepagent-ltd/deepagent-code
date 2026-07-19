// @ts-nocheck

import { DeepAgentCode } from "@deepagent-code/core"
import { ReadTool } from "@deepagent-code/core/tools"

const deepagentCode = DeepAgentCode.make({})

deepagentCode.tool.add(ReadTool)

deepagentCode.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

deepagentCode.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

deepagentCode.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await deepagentCode.session.create({
  agent: "build",
})

deepagentCode.subscribe((event) => {
  console.log(event)
})

await deepagentCode.session.prompt({
  sessionID,
  text: "hey what is up",
})

await deepagentCode.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await deepagentCode.session.wait()

console.log(await deepagentCode.session.messages(sessionID))
