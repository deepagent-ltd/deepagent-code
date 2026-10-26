import { expect, test } from "bun:test"
import path from "node:path"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { tmpdir } from "../fixture/fixture"

// The complete production route factory owns construction and request services. Do not
// inject a Gateway or a synthetic authorization/context middleware into the request.
test("production readiness registration shares the runner Gateway without request injection", async () => {
  await using fixture = await tmpdir()
  const directory = path.join(fixture.path, "current")
  const foreign = path.join(fixture.path, "foreign")
  await Bun.write(path.join(directory, "README.md"), "# REGISTRATIONCONTEXTFACT\n")
  await Bun.write(path.join(directory, "main.ts"), "export const actual = 'REGISTRATIONCONTEXTFACT'\n")
  await Bun.write(path.join(foreign, "README.md"), "# FOREIGNREGISTRATIONFACT\n")
  const web = HttpRouter.toWebHandler(HttpApiApp.createRoutes(), { disableLogger: true })
  try {
    // Admit both Sessions through this listener's actual Root and location store.
    const create = async (directory: string, title: string) => {
      const response = await web.handler(
        new Request("http://localhost/session", {
          method: "POST",
          headers: { "content-type": "application/json", "x-deepagent-code-directory": directory },
          body: JSON.stringify({ title }),
        }),
        HttpApiApp.context,
      )
      expect(response.status, response.status === 200 ? undefined : await response.clone().text()).toBe(200)
      const body: unknown = await response.json()
      if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string")
        throw new Error("Session creation did not return its durable identity")
      return body.id
    }
    const currentID = await create(directory, "current registration")
    const foreignID = await create(foreign, "foreign registration")
    const current = await web.handler(
      new Request(
        `http://localhost/context/readiness?session_id=${currentID}&directory=${encodeURIComponent(directory)}`,
      ),
      HttpApiApp.context,
    )
    expect(current.status, current.status === 200 ? undefined : await current.clone().text()).toBe(200)
    const result = await current.json()
    expect(result.session_id).toBe(currentID)
    expect(result.statuses.knowledge.revision).toBe("released:none")
    expect(result.statuses.memory.revision).toBe("memory:0")
    const rejected = await web.handler(
      new Request(
        `http://localhost/context/readiness?session_id=${foreignID}&directory=${encodeURIComponent(directory)}`,
      ),
      HttpApiApp.context,
    )
    expect(rejected.status).toBe(404)
    expect(JSON.stringify(await rejected.json())).not.toContain("FOREIGNREGISTRATIONFACT")
  } finally {
    await web.dispose()
  }
}, 30_000)
