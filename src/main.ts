import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";

import "./assets/main.postcss";

createApp(App).use(router).mount("#app");

window.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("keydown", (e) => {
  if (e.metaKey && e.key === "r") {
    window.location.reload();
  }
});
