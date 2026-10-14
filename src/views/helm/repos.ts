import { ref, shallowRef } from "vue";
import { listRepos } from "@/lib/helmApi";
import type { HelmRepo } from "@/lib/helm";

/*
 * The user's Helm repositories (`helm repo list`), shared by the Charts
 * page and the install flow: adding one in either place shows in both.
 */
const repos = shallowRef<HelmRepo[]>([]);
const loaded = ref(false);
const error = ref("");
let inFlight: Promise<void> | null = null;

export function reloadRepos(): Promise<void> {
  inFlight ??= listRepos()
    .then((list) => {
      repos.value = [...list].sort((a, b) => a.name.localeCompare(b.name));
      error.value = "";
    })
    .catch((e) => {
      error.value = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      loaded.value = true;
      inFlight = null;
    });
  return inFlight;
}

export function useHelmRepos() {
  if (!loaded.value && !inFlight) reloadRepos();
  return { repos, loaded, error, reload: reloadRepos };
}
