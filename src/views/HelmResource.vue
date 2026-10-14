<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { Plus } from "lucide-vue-next";
import type { ColumnDef } from "@tanstack/vue-table";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import DataTable from "@/components/ui/VirtualDataTable.vue";
import { Button } from "@/components/ui/button";
import { multiContextColumns } from "@/components/tables/multicontext";
import { columns } from "@/components/tables/helm-release";
import { actions } from "@/actions/helm-release";
import {
  useResourceList,
  ContextFailure,
  ResourceListResult,
} from "@/composables/useResourceList";
import { PanelProviderAddTabKey, PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { error } from "@/lib/logger";
import { listReleases } from "@/lib/helmApi";
import { releaseRow, sortReleases, type HelmReleaseRow } from "@/lib/helm";
import { openHelmReleasePanel } from "@/views/helm/panel";

/*
 * Helm releases of every active context, read natively from helm's
 * storage objects (no helm binary). A refresh only decodes releases that
 * changed, so the list polls often enough to feel live. Clicking a
 * release opens its story in the side panel.
 */
const route = useRoute();
const router = useRouter();
const { contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);
const addTab = injectStrict(PanelProviderAddTabKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const setSidePanelComponent = injectStrict(PanelProviderSetSidePanelComponentKey);

const rowActions = actions(addTab, spawnDialog, setSidePanelComponent, router);
const tableColumns: ColumnDef<any>[] = [...multiContextColumns, ...(columns as ColumnDef<any>[])];

const loadReleases = async (): Promise<ResourceListResult<HelmReleaseRow>> => {
  const activeContexts = [...contexts.value.entries()];
  const results = await Promise.allSettled(
    activeContexts.map(([ctx, namespaces]) => {
      const kubeConfig = contextKubeConfigMapping.value.get(ctx) || "";
      return listReleases({ context: ctx, kubeConfig }, namespaces).then((list) =>
        list.map((release) => releaseRow(release, ctx, kubeConfig))
      );
    })
  );

  const items: HelmReleaseRow[] = [];
  const failures: ContextFailure[] = [];
  results.forEach((result, i) => {
    const ctx = activeContexts[i][0];
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      failures.push({
        context: ctx,
        kubeConfig: contextKubeConfigMapping.value.get(ctx) || "",
        reason: result.reason,
      });
      error(`Failed to read Helm releases of ${ctx}: ${result.reason}`);
    }
  });

  return { items: sortReleases(items), failures, attempted: activeContexts.length };
};

const {
  items: releases,
  loading,
  error: loadError,
  lastUpdated,
  retry,
} = useResourceList(loadReleases, {
  // Reads metadata and decodes only what changed: cheap enough to poll.
  // Polling pauses while the window is hidden (useDataRefresher).
  interval: 8000,
  dependencies: [contexts.value],
});

const rowClasses = (row: HelmReleaseRow) =>
  route.query.release && row.name === route.query.release && row.namespace === route.query.namespace
    ? "animate-pulse-highlight-once"
    : "";

const showRelease = (row: HelmReleaseRow) => openHelmReleasePanel(setSidePanelComponent, row);

const installChart = () => router.push({ name: "HelmChartsPage" });
</script>
<template>
  <DataTable
    :data="releases"
    :loading="loading"
    :error="loadError"
    :last-updated="lastUpdated"
    resource-name="releases"
    :columns="tableColumns"
    :allow-filter="true"
    :sticky-headers="true"
    :row-actions="rowActions"
    :row-classes="rowClasses"
    empty-description="Releases you install with Helm show up here."
    @row-clicked="showRelease"
    @retry="retry"
  >
    <template #action-buttons>
      <Button size="sm" variant="outline" title="Find a chart and install it" @click="installChart">
        <Plus class="h-3.5 w-3.5" />
        Install
      </Button>
    </template>
    <template #empty-action>
      <Button size="sm" variant="outline" @click="installChart">
        <Plus class="h-3.5 w-3.5" />
        Install a chart
      </Button>
    </template>
  </DataTable>
</template>
