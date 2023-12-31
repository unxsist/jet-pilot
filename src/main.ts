import devtools from "@vue/devtools";
import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";

import "./assets/main.postcss";

if (process.env.NODE_ENV === "development") {
  devtools.connect("http://localhost", 8098);
}

createApp(App).use(router).mount("#app");

window.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("keydown", (e) => {
  if (e.metaKey && e.key === "r") {
    window.location.reload();
  }
});
