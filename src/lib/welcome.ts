/* Opens the setup guide on demand (command palette, Settings › General). */
import { ref } from "vue";

export const welcomeRequested = ref(false);

export function openWelcome() {
  welcomeRequested.value = true;
}
