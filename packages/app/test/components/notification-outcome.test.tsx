import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { NotificationProvider, useNotification } from "@/context/notification"
import { dict } from "@/i18n/en"

const bridge = vi.hoisted(() => ({
  rows: [] as { id: string; seq: number; type: string; data: Record<string, unknown> }[],
  notify: vi.fn(),
  sound: vi.fn(),
  cursors: [] as string[],
  hint: undefined as ((event: { name: string; details: { properties: { sessionID: string } } }) => void) | undefined,
}))
vi.mock("@solidjs/router", () => ({ useParams: () => ({ dir: btoa("/workspace"), id: "other-session" }) }))
vi.mock("@/context/server-sdk", () => ({
  useServerSDK: () => ({
    scope: "isolated-notification-test",
    client: {
      context: {
        eventsCursor: async () => ({ data: { watermark: 0, cursor: 0, floor: 0 } }),
        events: async (input: { after: string }) => {
          bridge.cursors.push(input.after)
          return { data: { events: bridge.rows, floor: 0 } }
        },
      },
    },
    event: {
      listen: (hint: NonNullable<typeof bridge.hint>) => {
        bridge.hint = hint
        return () => { bridge.hint = undefined }
      },
    },
    createClient() {
      return this.client
    },
  }),
}))
vi.mock("@/context/server-sync", () => ({
  useServerSync: () => ({
    child: () => [{ session: [{ id: "session-1", title: "Fixture session" }], session_status: {} }],
  }),
}))
vi.mock("@/context/platform", () => ({ usePlatform: () => ({ notify: bridge.notify }) }))
vi.mock("@/utils/sound", () => ({ playSoundById: bridge.sound }))
vi.mock("@/context/settings", () => ({
  useSettings: () => ({
    sounds: {
      agentEnabled: () => true,
      agent: () => "success-sound",
      errorsEnabled: () => true,
      errors: () => "error-sound",
    },
    notifications: { agent: () => true, errors: () => true },
  }),
}))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] }) }))
vi.mock("@/utils/persist", () => ({
  Persist: { serverGlobal: () => "isolated" },
  persisted: (_key: string, state: readonly unknown[]) => [...state, undefined, () => true],
}))

beforeEach(() => {
  vi.useFakeTimers()
  bridge.rows = []
  bridge.cursors = []
  bridge.notify.mockReset()
  bridge.sound.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Probe() {
  const notifications = useNotification()
  return <output>{JSON.stringify(notifications.session.all("session-1").map((item) => item.type))}</output>
}

it("consumes every interruption reason silently and notifies only later success and failure", async () => {
  bridge.rows = ["user", "shutdown", "superseded"].map((reason, index) => ({
    id: `stopped-${reason}`,
    seq: index + 1,
    type: "session.execution.interrupted.1",
    data: { sessionID: "session-1", reason },
  }))
  render(() => (
    <NotificationProvider>
      <Probe />
    </NotificationProvider>
  ))
  await vi.advanceTimersByTimeAsync(1)
  expect(screen.getByRole("status").textContent).toBe("[]")
  expect(bridge.notify).not.toHaveBeenCalled()
  expect(bridge.sound).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(bridge.cursors).toEqual(["0", "3"])
  expect(bridge.notify).not.toHaveBeenCalled()
  bridge.rows.push(
    { id: "success", seq: 4, type: "session.execution.succeeded.1", data: { sessionID: "session-1" } },
    {
      id: "failure",
      seq: 5,
      type: "session.execution.failed.1",
      data: { sessionID: "session-1", error: { type: "unknown", message: "provider failure" } },
    },
  )
  bridge.hint?.({ name: "/workspace", details: { properties: { sessionID: "session-1" } } })
  await vi.advanceTimersByTimeAsync(1000)
  expect(screen.getByRole("status").textContent).toBe('["turn-complete","error"]')
  expect(bridge.notify.mock.calls.map((args) => args[0])).toEqual([
    dict["notification.session.responseReady.title"],
    dict["notification.session.error.title"],
  ])
  expect(bridge.sound.mock.calls.map((args) => args[0])).toEqual(["success-sound", "error-sound"])
  await vi.advanceTimersByTimeAsync(1000)
  expect(bridge.cursors.at(-1)).toBe("5")
  expect(bridge.notify).toHaveBeenCalledTimes(2)
  expect(bridge.sound).toHaveBeenCalledTimes(2)
})
