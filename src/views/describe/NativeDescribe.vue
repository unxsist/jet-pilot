<script setup lang="ts">
/**
 * The native describe as a document: the object's name and state at the
 * top, then its sections as quiet definition lists and tables, related
 * objects as links that open in the side panel. Search matches are marked
 * in place (numbered in reading order, like describeStrings).
 */
import { StatusDot, statusTextClass } from "@/components/ui/status";
import ObjectLink from "@/components/generic/ObjectLink.vue";
import Highlighted from "@/views/describe/Highlighted.vue";
import type { DescribeDoc, DescribeValue } from "@/lib/resources/describe";
import type { PanelTarget } from "@/lib/resources/open";

const props = defineProps<{
  doc: DescribeDoc;
  target: PanelTarget;
  query: string;
  active: number;
  /** Key (see describeStrings) → number of its first match. */
  starts: Map<string, number>;
}>();

const problem = computed(() => props.doc.state?.tone === "warning" || props.doc.state?.tone === "destructive");
const valueClass = (value: DescribeValue) => [
  value.mono ? "font-mono text-xs" : "",
  value.tone ? statusTextClass[value.tone] : value.muted ? "text-muted-foreground" : "",
];
const at = (key: string) => props.starts.get(key) ?? 0;
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto" data-testid="describe-native">
    <article class="mx-auto max-w-5xl px-8 pb-10 pt-6 select-text">
      <header class="mb-6">
        <div class="text-xs font-medium text-muted-foreground">
          {{ doc.kind }}<template v-if="doc.namespace"> · {{ doc.namespace }}</template>
        </div>
        <h1 class="text-xl font-semibold leading-7">{{ doc.name }}</h1>
        <div v-if="doc.state" class="mt-2 flex max-w-3xl items-start gap-2.5 text-sm">
          <StatusDot :tone="doc.state.tone" class="mt-1.5" />
          <p>
            <span class="font-medium" :class="problem ? statusTextClass[doc.state.tone] : ''">{{ doc.state.label }}</span>
            <span v-if="doc.state.detail" class="text-muted-foreground"> · {{ doc.state.detail }}</span>
          </p>
        </div>
      </header>

      <section v-for="(section, s) in doc.sections" :key="`${s}-${section.title}`" class="border-t border-border-subtle py-4">
        <h2 class="mb-2.5 text-sm font-semibold">
          <Highlighted :text="section.title" :query="query" :start="at(`${s}.t`)" :active="active" />
        </h2>

        <dl
          v-if="section.rows?.length"
          class="grid grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)] items-baseline gap-x-6 gap-y-1.5 text-sm"
        >
          <template v-for="(row, r) in section.rows" :key="r">
            <dt class="truncate text-xs text-muted-foreground" :title="row.label">
              <Highlighted :text="row.label" :query="query" :start="at(`${s}.r${r}.l`)" :active="active" />
            </dt>
            <dd class="min-w-0 break-words">
              <template v-for="(value, j) in row.values" :key="j">
                <span v-if="j > 0" class="text-muted-foreground">{{ row.separator ?? " · " }}</span>
                <ObjectLink v-if="value.ref" :object-ref="value.ref" :target="target">
                  <Highlighted :text="value.text" :query="query" :start="at(`${s}.r${r}.v${j}`)" :active="active" />
                </ObjectLink>
                <span v-else :class="valueClass(value)">
                  <Highlighted :text="value.text" :query="query" :start="at(`${s}.r${r}.v${j}`)" :active="active" />
                </span>
              </template>
            </dd>
          </template>
        </dl>

        <div v-if="section.table?.rows.length" class="-mx-2 overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr>
                <th
                  v-for="(column, c) in section.table.columns"
                  :key="column"
                  class="whitespace-nowrap px-2 pb-1.5 text-xs font-normal text-muted-foreground"
                >
                  <Highlighted :text="column" :query="query" :start="at(`${s}.h${c}`)" :active="active" />
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(cells, r) in section.table.rows" :key="r" class="border-t border-border-subtle align-baseline">
                <td
                  v-for="(cell, c) in cells"
                  :key="c"
                  class="px-2 py-1.5"
                  :class="c === cells.length - 1 ? 'min-w-[16rem] break-words' : 'whitespace-nowrap'"
                >
                  <ObjectLink v-if="cell.ref" :object-ref="cell.ref" :target="target">
                    <Highlighted :text="cell.text" :query="query" :start="at(`${s}.c${r}.${c}`)" :active="active" />
                  </ObjectLink>
                  <span v-else :class="valueClass(cell)">
                    <Highlighted :text="cell.text" :query="query" :start="at(`${s}.c${r}.${c}`)" :active="active" />
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="!section.rows?.length && !section.table?.rows.length && section.empty" class="text-sm text-muted-foreground">
          {{ section.empty }}
        </p>
      </section>
    </article>
  </div>
</template>
