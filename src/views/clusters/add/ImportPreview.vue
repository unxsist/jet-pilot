<script setup lang="ts">
/**
 * The contexts of a kubeconfig about to be imported, as calm rows: pick
 * which ones, rename any in place (names that clash are renamed already),
 * see how each signs in and what's wrong with it. Commands run by exec
 * plugins are shown and must be acknowledged before importing.
 */
import { AlertTriangle, CircleAlert, Terminal } from "lucide-vue-next";
import { Checkbox } from "@/components/ui/checkbox";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import { detectProvider } from "@/lib/clusters/provider";
import { AUTH_LABELS } from "@/lib/kubeconfigSources";
import { WIZARD_LIST } from "@/components/wizard/wizard";
import type { ImportRow } from "./forms";

const props = defineProps<{ rows: ImportRow[] }>();
const trusted = defineModel<boolean>("trusted", { required: true });

const execRows = computed(() => props.rows.filter((row) => row.include && row.context.execCommand));
const commandLine = (row: ImportRow) =>
  [row.context.execCommand!.command, ...row.context.execCommand!.args].join(" ");

const provider = (row: ImportRow) =>
  detectProvider({
    context: row.context.name,
    cluster: row.context.cluster,
    server: row.context.server,
    authCommand: row.context.auth.command,
  }).id;

/* One quiet line: how it signs in, where it is. */
const subtitle = (row: ImportRow) => {
  const auth = row.context.auth;
  const parts = [auth.command ? `${AUTH_LABELS[auth.kind] ?? auth.kind} · ${auth.command}` : (AUTH_LABELS[auth.kind] ?? auth.kind)];
  if (auth.interactive === "interactive") parts.push("signs in through a browser");
  if (row.context.namespace) parts.push(`namespace ${row.context.namespace}`);
  return parts.join(" · ");
};
const host = (server: string | null | undefined) => server?.replace(/^https?:\/\//, "") ?? "";

/* What needs saying on the right: already there, a clash, a rename. */
const fact = (row: ImportRow) => {
  if (row.context.duplicateOf) return { text: "Already added", tone: "muted", title: "The same cluster with the same credentials is already in JET Pilot" };
  if (row.context.nameConflict && row.name === row.context.name)
    return { text: "Name taken", tone: "warning", title: `A cluster called ${row.context.name} already exists` };
  if (row.context.nameConflict && row.name !== row.context.name)
    return { text: `Renamed from ${row.context.name}`, tone: "muted", title: `A cluster called ${row.context.name} already exists` };
  return null;
};
</script>

<template>
  <div class="space-y-5">
    <div :class="WIZARD_LIST" role="list" aria-label="Contexts">
      <div
        v-for="row in rows"
        :key="row.context.name"
        role="listitem"
        class="group/row flex items-start gap-3 rounded-lg px-3 py-2 transition-colors duration-fast hover:bg-accent/50"
      >
        <Checkbox v-model:checked="row.include" class="mt-2" :aria-label="`Import ${row.context.name}`" />
        <span class="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center" :class="row.include ? '' : 'opacity-50'">
          <ProviderMark :provider="provider(row)" :context="row.context.name" :size="18" />
        </span>
        <div class="min-w-0 flex-1" :class="row.include ? '' : 'opacity-60'">
          <div class="flex min-w-0 items-center gap-3">
            <input
              v-model="row.name"
              class="-ml-1.5 h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-sm font-medium text-foreground outline-none transition-[border-color,background-color,box-shadow] duration-fast placeholder:text-muted-foreground hover:border-input focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:pointer-events-none"
              :class="fact(row)?.tone === 'warning' ? 'border-warning/50' : ''"
              :aria-label="`Name for ${row.context.name}`"
              :disabled="!row.include"
              spellcheck="false"
            />
            <span
              v-if="fact(row)"
              class="flex shrink-0 items-center gap-1.5 text-xs"
              :class="fact(row)!.tone === 'warning' ? 'text-warning' : 'text-muted-foreground'"
              :title="fact(row)!.title"
            >
              <span v-if="fact(row)!.tone === 'warning'" class="h-1.5 w-1.5 rounded-full bg-current" />
              {{ fact(row)!.text }}
            </span>
          </div>
          <p class="truncate text-xs text-muted-foreground" :title="row.context.server ?? undefined">
            {{ subtitle(row) }}<template v-if="row.context.server"> · <span class="font-mono text-[11px]">{{ host(row.context.server) }}</span></template>
          </p>
          <p
            v-for="problem in row.context.problems"
            :key="problem.code + problem.message"
            class="mt-1 flex items-start gap-1.5 text-xs"
            :class="problem.severity === 'error' ? 'text-destructive' : 'text-warning'"
          >
            <CircleAlert v-if="problem.severity === 'error'" class="mt-px h-3.5 w-3.5 shrink-0" />
            <AlertTriangle v-else class="mt-px h-3.5 w-3.5 shrink-0" />
            {{ problem.message }}
          </p>
        </div>
      </div>
    </div>

    <div v-if="execRows.length" class="flex gap-3 rounded-xl bg-muted/50 p-4">
      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-warning/10 text-warning">
        <Terminal class="h-4 w-4" />
      </span>
      <div class="min-w-0 flex-1 space-y-3">
        <div class="space-y-0.5">
          <p class="text-sm font-medium">
            {{ execRows.length === 1 ? `${execRows[0]!.name} signs in by running a command` : "These clusters sign in by running commands" }}
          </p>
          <p class="text-xs text-muted-foreground">
            JET Pilot runs it on this computer whenever it connects. Only import kubeconfigs you trust.
          </p>
        </div>
        <ul class="space-y-1">
          <li v-for="row in execRows" :key="row.context.name" class="flex min-w-0 items-baseline gap-2">
            <span v-if="execRows.length > 1" class="shrink-0 text-xs text-muted-foreground">{{ row.name }}</span>
            <code class="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" :title="commandLine(row)">{{ commandLine(row) }}</code>
          </li>
        </ul>
        <label class="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <Checkbox v-model:checked="trusted" />
          I trust {{ execRows.length === 1 ? "this command" : "these commands" }}
        </label>
      </div>
    </div>
  </div>
</template>
