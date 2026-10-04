import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";

import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./assets/main.postcss";

createApp(App).use(router).mount("#app");

window.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("keydown", (e) => {
  if (e.metaKey && e.key === "r") {
    window.location.reload();
  }
});
