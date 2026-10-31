<script setup lang="ts">
/**
 * The diff of one change (a tab): what changed in words, who and when,
 * then the two sides as YAML. A recorded edit shows only the fields that
 * changed; a rollout its whole pod template, with the unchanged parts
 * folded.
 */
import yaml from "js-yaml";
import KindIcon from "@/components/KindIcon.vue";
import DiffView from "@/components/workloads/DiffView.vue";
import { formatDateTime } from "@/lib/utils";
import type { Change } from "@/lib/changes/model";
import { managerLabel } from "@/lib/changes/words";

const props = defineProps<{ change: Change }>();

const dump = (value: unknown) => yaml.dump(value ?? {}, { sortKeys: true, lineWidth: 120, noRefs: true });
const before = computed(() => dump(props.change.diff?.before));
const after = computed(() => dump(props.change.diff?.after));

const meta = computed(() =>
  [
    props.change.object.kind === "HelmRelease" ? "Helm release" : props.change.object.kind,
    props.change.object.namespace,
    props.change.target.context,
  ]
    .filter(Boolean)
    .join(" · ")
);
const who = computed(() =>
  [props.change.by ? `By ${managerLabel(props.change.by)}` : "", formatDateTime(new Date(props.change.at))].filter(Boolean).join(" · ")
);
</script>

<template>
  <div class="flex h-full flex-col bg-background">
    <div class="flex shrink-0 items-start gap-3 border-b border-border-subtle px-4 py-3">
      <KindIcon :name="change.object.kind === 'HelmRelease' ? 'helm' : change.object.kind" class="mt-0.5 text-muted-foreground" />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm">
          <span class="font-medium text-foreground">{{ change.object.name }}</span>
          <span class="text-muted-foreground"> · {{ change.summary }}</span>
        </p>
        <p class="truncate text-xs text-muted-foreground">{{ meta }}</p>
      </div>
      <p class="shrink-0 text-xs text-muted-foreground">{{ who }}</p>
    </div>
    <div class="min-h-0 flex-1">
      <DiffView
        :old-text="before"
        :new-text="after"
        :old-label="change.diff?.beforeLabel"
        :new-label="change.diff?.afterLabel"
        empty-text="Changed and changed back"
      />
    </div>
  </div>
</template>
