<script setup lang="ts">
/**
 * A cluster in one of your cloud accounts that isn't added yet (the hub's
 * Available section): where it is, its version, and Add / Ignore.
 */
import { EyeOff, Loader2, Plus, RotateCcw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import { cn } from "@/lib/utils";
import type { CatalogCluster } from "@/lib/clusters/cloud";

defineProps<{ cluster: CatalogCluster; selected: boolean; selecting: boolean; adding: boolean }>();
const emit = defineEmits<{ add: []; ignore: []; restore: []; select: [on: boolean] }>();
</script>

<template>
  <div
    role="row"
    :class="
      cn(
        'group/row grid h-11 grid-cols-[1.25rem_2rem_minmax(0,1fr)_minmax(0,11rem)_4.5rem_4rem_minmax(0,13rem)_auto] items-center gap-x-3 px-3 transition-colors duration-fast hover:bg-accent/50',
        selected && 'bg-primary/[0.06] hover:bg-primary/10',
        cluster.state === 'ignored' && 'opacity-60'
      )
    "
  >
    <Checkbox
      :checked="selected"
      :class="selecting || selected ? '' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'"
      :aria-label="`Select ${cluster.name}`"
      @update:checked="(on: boolean) => emit('select', on)"
    />
    <span class="flex h-7 w-7 items-center justify-center rounded-full border border-dashed text-muted-foreground" aria-hidden="true">
      <Plus class="h-3.5 w-3.5" />
    </span>
    <div class="min-w-0">
      <span class="block truncate text-sm font-medium">{{ cluster.name }}</span>
      <span class="block truncate text-xs text-muted-foreground">
        {{ cluster.state === "ignored" ? "Ignored" : "Not added yet" }}<template v-if="cluster.roleName"> · {{ cluster.roleName }} role</template>
      </span>
    </div>
    <div class="flex min-w-0 items-center gap-2">
      <ProviderMark provider="aws" />
      <span class="truncate text-xs text-muted-foreground">{{ cluster.region }} · {{ cluster.accountName ?? cluster.accountId }}</span>
    </div>
    <span class="font-mono text-xs tabular-nums text-muted-foreground">{{ cluster.version ? `v${cluster.version}` : "—" }}</span>
    <span class="text-xs text-muted-foreground">
      <template v-if="cluster.status && cluster.status !== 'ACTIVE'">{{ cluster.status.toLowerCase() }}</template>
    </span>
    <span />
    <div class="flex items-center justify-end gap-1">
      <template v-if="cluster.state === 'ignored'">
        <Button size="sm" variant="ghost" class="h-7 text-muted-foreground" @click="emit('restore')">
          <RotateCcw class="h-3.5 w-3.5" /> Restore
        </Button>
      </template>
      <template v-else>
        <Button
          size="sm"
          variant="ghost"
          class="h-7 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
          :aria-label="`Ignore ${cluster.name}`"
          title="Ignore: hide it from this list"
          @click="emit('ignore')"
        >
          <EyeOff class="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="outline" class="h-7" :disabled="adding" @click="emit('add')">
          <Loader2 v-if="adding" class="h-3.5 w-3.5 animate-spin" />
          Add
        </Button>
      </template>
    </div>
  </div>
</template>
