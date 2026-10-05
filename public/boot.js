/*
 * Paints the last used theme before the app bundle runs (classic script:
 * the CSP only allows 'self' scripts). Keys and cache shape (BootCache):
 * src/lib/themes/scheme.ts.
 */
(function () {
  var root = document.documentElement;
  var dark = false;
  try {
    var mode = localStorage.getItem("vueuse-color-scheme") || "auto";
    dark =
      mode === "dark" ||
      (mode === "auto" &&
        !!window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    var entry = null;
    try {
      var cache = JSON.parse(localStorage.getItem("jet-theme-cache") || "null");
      if (cache && cache.v === 1) entry = cache[dark ? "dark" : "light"];
    } catch (e) {}
    if (entry && typeof entry === "object" && typeof entry.dark === "boolean") {
      dark = entry.dark;
      var vars = entry.vars;
      if (vars && typeof vars === "object") {
        for (var key in vars) {
          if (
            Object.prototype.hasOwnProperty.call(vars, key) &&
            /^[a-z0-9-]+$/.test(key) &&
            typeof vars[key] === "string"
          ) {
            root.style.setProperty("--" + key, vars[key]);
          }
        }
        if (typeof entry.id === "string") root.setAttribute("data-theme-id", entry.id);
      }
    }
  } catch (e) {}
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
})();
