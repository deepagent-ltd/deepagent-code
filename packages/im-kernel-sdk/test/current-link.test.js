import { expect, test } from "bun:test";
import { KernelLiveFirstSeenFixture } from "../../deepagent-code/test/im/fixture/kernel-live-first-seen";

await import("../../deepagent-code/src/im/kernel/shims");
const JuggleIM = (await import("../lib/index.js")).default;

test("original current link fences the actual WS socket across native queries, disconnect and replacement", async () => {
  const fixture = KernelLiveFirstSeenFixture.make();
  const client = JuggleIM.init({ appkey: `current-link-${fixture.server.port}`, navList: [fixture.server.url.origin], protectedDeliveryReader: true });
  try {
    expect(client.captureProtectedCurrentLink()).toBeUndefined();
    await client.connect({ token: "private-first-seen-token" });
    const original = client.captureProtectedCurrentLink();
    const first = client.readProtectedCurrentLink(original);
    expect(first).toMatchObject({ version: 1, receiverID: "receiver" });
    expect(first.generation).toBeGreaterThan(0);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(original)).toEqual([]);
    expect(Object.keys(first).sort()).toEqual(["generation", "receiverID", "version"]);
    expect(client.readProtectedCurrentLink({ ...original })).toBeUndefined();
    const foreign = JuggleIM.init({ appkey: "foreign-current-link", protectedDeliveryReader: true });
    expect(foreign.readProtectedCurrentLink(original)).toBeUndefined();
    await client.getDeliveryReader();
    expect(client.readProtectedCurrentLink(original)).toEqual(first);
    await client.disconnect();
    expect(client.readProtectedCurrentLink(original)).toBeUndefined();
    expect(client.captureProtectedCurrentLink()).toBeUndefined();
    await client.connect({ token: "private-first-seen-token" });
    expect(client.readProtectedCurrentLink(original)).toBeUndefined();
    const next = client.captureProtectedCurrentLink();
    expect(client.readProtectedCurrentLink(next).generation).toBeGreaterThan(first.generation);
    expect(foreign.readProtectedCurrentLink(next)).toBeUndefined();
    await client.disconnect();
    expect(client.readProtectedCurrentLink(next)).toBeUndefined();
  } finally {
    await client.disconnect();
    fixture.server.stop(true);
  }
}, 20_000);
