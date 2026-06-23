;(function () {
  var app = "deepagent"
  var legacyApp = "one" + "agent"
  var key = app + "-theme-id"
  var legacyKey = legacyApp + "-theme-id"
  if (localStorage.getItem(key) === null && localStorage.getItem(legacyKey) !== null) {
    localStorage.setItem(key, localStorage.getItem(legacyKey))
    localStorage.removeItem(legacyKey)
  }
  var themeId = localStorage.getItem(key) || "oc-2"

  if (themeId === "oc-1") {
    themeId = "oc-2"
    localStorage.setItem(key, themeId)
    localStorage.removeItem(app + "-theme-css-light")
    localStorage.removeItem(app + "-theme-css-dark")
    localStorage.removeItem(legacyApp + "-theme-css-light")
    localStorage.removeItem(legacyApp + "-theme-css-dark")
  }

  var schemeKey = app + "-color-scheme"
  var legacySchemeKey = legacyApp + "-color-scheme"
  if (localStorage.getItem(schemeKey) === null && localStorage.getItem(legacySchemeKey) !== null) {
    localStorage.setItem(schemeKey, localStorage.getItem(legacySchemeKey))
    localStorage.removeItem(legacySchemeKey)
  }
  var scheme = localStorage.getItem(schemeKey) || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", isDark ? "#131010" : "#F8F7F7")

  if (themeId === "oc-2") return

  var cssKey = app + "-theme-css-" + mode
  var legacyCssKey = legacyApp + "-theme-css-" + mode
  if (localStorage.getItem(cssKey) === null && localStorage.getItem(legacyCssKey) !== null) {
    localStorage.setItem(cssKey, localStorage.getItem(legacyCssKey))
    localStorage.removeItem(legacyCssKey)
  }
  var css = localStorage.getItem(cssKey)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
