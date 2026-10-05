<script setup lang="ts">
/**
 * The contexts of a kubeconfig about to be imported: pick which ones, rename
 * clashing names, see how each signs in and what's wrong with it. Commands
 * run by exec plugins are shown and must be acknowledged before importing.
 */
import { AlertTriangle, CircleAlert, Terminal } from "lucide-vue-next";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import { detectProvider } from "@/lib/clusters/provider";
import { AUTH_LABELS } from "@/lib/kubeconfigSources";
import type { ImportRow } from "./forms";

const props = defineProps<{ rows: ImportRow[] }>();
const trusted = defineModel<boolean>("trusted", { required: true });

const execRows = computed(() => props.rows.filter((row) => row.include && row.context.execCommand));
const commandLine = (row: ImportRow) =>
  [row.context.execCommand!.command, ...row.context.execCommand!.args].join(" ");
</script>

<template>
  <div class="space-y-3">
    <div class="max-h-[22rem] divide-y divide-border-subtle overflow-y-auto rounded-lg border">
      <div v-for="row in rows" :key="row.context.name" class="space-y-1.5 px-3 py-2.5" :class="row.include ? '' : 'opacity-60'">
        <div class="flex items-center gap-3">
          <Checkbox v-model:checked="row.include" :aria-label="`Import ${row.context.name}`" />
          <ProviderMark
            :provider="detectProvider({ context: row.context.name, cluster: row.context.cluster, server: row.context.server, authCommand: row.context.auth.command }).id"
            :context="row.context.name"
          />
          <Input
            v-model="row.name"
            class="h-7 flex-1 font-mono text-xs"
            :aria-label="`Name for ${row.context.name}`"
            :disabled="!row.include"
            spellcheck="false"
          />
          <Badge v-if="row.context.duplicateOf" variant="muted" size="sm" title="The same cluster with the same credentials is already available">
            Already added
          </Badge>
          <Badge v-else-if="row.context.nameConflict && row.name === row.context.name" variant="warning" size="sm">
            Name taken
          </Badge>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-xs text-muted-foreground">
          <span>{{ AUTH_LABELS[row.context.auth.kind] ?? row.context.auth.kind }}<template v-if="row.context.auth.command"> · {{ row.context.auth.command }}</template></span>
          <span v-if="row.context.auth.interactive === 'interactive'" class="rounded border px-1 text-2xs">sign-in in the browser</span>
          <span v-if="row.context.server" class="truncate font-mono text-2xs" :title="row.context.server">{{ row.context.server }}</span>
          <span v-if="row.context.namespace" class="text-2xs">namespace {{ row.context.namespace }}</span>
        </div>
        <p
          v-for="problem in row.context.problems"
          :key="problem.code + problem.message"
          class="flex items-start gap-1.5 pl-7 text-xs"
          :class="problem.severity === 'error' ? 'text-destructive' : 'text-warning'"
        >
          <CircleAlert v-if="problem.severity === 'error'" class="mt-px h-3.5 w-3.5 shrink-0" />
          <AlertTriangle v-else class="mt-px h-3.5 w-3.5 shrink-0" />
          {{ problem.message }}
        </p>
      </div>
    </div>

    <div v-if="execRows.length" class="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
      <p class="flex items-center gap-2 text-sm font-medium">
        <Terminal class="h-4 w-4 text-warning" />
        {{ execRows.length === 1 ? "This cluster signs in by running a command" : "These clusters sign in by running commands" }}
      </p>
      <p class="text-xs text-muted-foreground">
        JET Pilot runs it on this computer whenever it connects. Only import kubeconfigs from people and tools you trust.
      </p>
      <ul class="space-y-1">
        <li v-for="row in execRows" :key="row.context.name" class="flex items-center gap-2 rounded-md bg-background/80 px-2 py-1">
          <span class="shrink-0 text-2xs text-muted-foreground">{{ row.name }}</span>
          <code class="min-w-0 flex-1 truncate text-right font-mono text-2xs" :title="commandLine(row)">{{ commandLine(row) }}</code>
        </li>
      </ul>
      <label class="flex items-center gap-2 text-xs">
        <Checkbox v-model:checked="trusted" />
        I trust {{ execRows.length === 1 ? "this command" : "these commands" }}
      </label>
    </div>
  </div>
</template>
