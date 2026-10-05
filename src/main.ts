import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import { perfMark, markFirstPaint } from "./lib/perf";
import { resetLogStreams } from "./lib/logStreams";

import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./assets/main.postcss";

perfMark("app:boot");
resetLogStreams();

createApp(App).use(router).mount("#app");

perfMark("app:mounted");
markFirstPaint();

window.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("keydown", (e) => {
  if (e.metaKey && e.key === "r") {
    window.location.reload();
  }
});
