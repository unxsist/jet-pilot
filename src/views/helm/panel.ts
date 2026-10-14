import type { HelmReleaseRow } from "@/lib/helm";

/* Opens a release in the side panel. */
export function openHelmReleasePanel(setSidePanelComponent: any, row: HelmReleaseRow) {
  setSidePanelComponent({
    title: row.name,
    overline: "Helm release",
    icon: "helm",
    component: defineAsyncComponent(() => import("@/views/helm/HelmReleasePanel.vue")),
    props: { release: row },
  });
}
