/*
 * Runs before the app bundle (a classic, render-blocking script in <head>):
 * applies the last used colour scheme so the boot skeleton and the first
 * frame of the app are painted in the right theme. VueUse's useColorMode
 * (ColorSchemeProvider) keeps `vueuse-color-scheme` up to date.
 * A file instead of an inline script: the CSP only allows 'self' scripts.
 */
(function () {
  try {
    var mode = localStorage.getItem("vueuse-color-scheme") || "auto";
    var dark =
      mode === "dark" ||
      (mode === "auto" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {
    /* storage unavailable: keep the default (light) */
  }
})();
