import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigIM } from "../../src/config/im"

test("IM service config preserves absent/null and normalizes only credential-free HTTPS realms", () => {
  expect(ConfigIM.defaultServiceURL).toBe("https://ai.deepagent.ltd/im")
  expect(ConfigIM.normalizeServiceURL(ConfigIM.defaultServiceURL)).toBe(ConfigIM.defaultServiceURL)
  expect(
    Schema.is(ConfigIM.ServiceStatus)({ url: ConfigIM.defaultServiceURL, source: "default", reconnectRequired: false }),
  ).toBe(true)
  expect(Schema.decodeUnknownSync(ConfigIM.Info)({ model: "provider/model" }).url).toBeUndefined()
  expect(Schema.decodeUnknownSync(ConfigIM.Info)({ url: null }).url).toBeNull()
  expect(ConfigIM.normalizeServiceURL("HTTPS://Example.COM:443/platform///")).toBe("https://example.com/platform")
  for (const url of [
    "",
    "http://example.com",
    "https:example.com",
    "https://u:p@example.com",
    "https://example.com?",
    "https://example.com#",
    "https://example.com/x?key=secret",
    "https://example.com\\other",
    " https://example.com",
    "https://example.com/\n",
    `https://example.com/${"x".repeat(2048)}`,
  ]) {
    expect(ConfigIM.normalizeServiceURL(url)).toBeUndefined()
    expect(Schema.is(ConfigIM.Info)({ url })).toBe(false)
  }
  expect(ConfigIM.normalizeServiceURL("http://127.0.0.1:3000", true)).toBe("http://127.0.0.1:3000")
  expect(ConfigIM.normalizeServiceURL("http://example.com", true)).toBeUndefined()
})

test("IM service config accepts HTTPS IPv4 and IPv6 ports with normalized path prefixes", () => {
  expect(ConfigIM.normalizeServiceURL("https://203.0.113.10:4468///")).toBe("https://203.0.113.10:4468")
  expect(ConfigIM.normalizeServiceURL("https://203.0.113.10:4468/api/v1///")).toBe("https://203.0.113.10:4468/api/v1")
  expect(ConfigIM.normalizeServiceURL("https://[2001:0db8:0:0:0:0:0:1]:4468///")).toBe("https://[2001:db8::1]:4468")
  expect(ConfigIM.normalizeServiceURL("https://[2001:db8::1]:4468/api/v1///")).toBe("https://[2001:db8::1]:4468/api/v1")
  expect(ConfigIM.normalizeServiceURL("http://203.0.113.10:4468")).toBeUndefined()
  expect(ConfigIM.normalizeServiceURL("http://[2001:db8::1]:4468")).toBeUndefined()
  expect(ConfigIM.normalizeServiceURL("https://u:p@203.0.113.10:4468")).toBeUndefined()
  expect(ConfigIM.normalizeServiceURL("https://u:p@[2001:db8::1]:4468")).toBeUndefined()
})
