import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("migrates legacy oc-1 to oc-2 before mount", () => {
    localStorage.setItem("deepagent-theme-id", "oc-1")
    localStorage.setItem("deepagent-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("deepagent-theme-css-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("deepagent-theme-id")).toBe("oc-2")
    expect(localStorage.getItem("deepagent-theme-css-light")).toBeNull()
    expect(localStorage.getItem("deepagent-theme-css-dark")).toBeNull()
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("deepagent-theme-id", "nightowl")
    localStorage.setItem("deepagent-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })

  test("migrates legacy app theme keys to DeepAgent keys", () => {
    localStorage.setItem(`${"one" + "agent"}-theme-id`, "nightowl")
    localStorage.setItem(`${"one" + "agent"}-theme-css-light`, "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(localStorage.getItem("deepagent-theme-id")).toBe("nightowl")
    expect(localStorage.getItem(`${"one" + "agent"}-theme-id`)).toBeNull()
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})
