<script setup lang="ts">
/*
 * Settings search results: matching preferences are editable right here,
 * grouped by the section they live in; matching bespoke sections (theme
 * library, tools...) link to their page.
 */
import { useRouter } from "vue-router";
import { ChevronRight, SearchX } from "lucide-vue-next";
import PageHeader from "@/components/page/PageHeader.vue";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import SettingRow from "@/components/settings/SettingRow.vue";
import { EmptyState } from "@/components/ui/empty-state";
import { parseSearchQuery, searchSettings, type SearchHit } from "@/lib/settings/search";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";

const props = defineProps<{ query: string }>();
const emit = defineEmits<{ navigate: [] }>();

const router = useRouter();
const { settings } = injectStrict(SettingsContextStateKey);

type SettingHit = Extract<SearchHit, { kind: "setting" }>;

const hits = computed(() => searchSettings(props.query, settings.value));
const modifiedOnly = computed(() => parseSearchQuery(props.query).modifiedOnly);

/* Matching preferences, grouped by section in the order of their best match. */
const groups = computed(() => {
  const byId = new Map<string, { id: string; title: string; context: string; hits: SettingHit[] }>();
  for (const hit of hits.value) {
    if (hit.kind !== "setting" || hit.def.hidden) continue;
    const id = `${hit.category.id}/${hit.section.id}`;
    let group = byId.get(id);
    if (!group) {
      group = { id, title: hit.section.title, context: hit.category.title, hits: [] };
      byId.set(id, group);
    }
    group.hits.push(hit);
  }
  return [...byId.values()];
});

/* Sections, and preferences that are edited inside a bespoke section. */
const links = computed(() => {
  const seen = new Set<string>();
  const list: { key: string; title: string; context: string; to: object }[] = [];
  for (const hit of hits.value) {
    if (hit.kind === "setting" && !hit.def.hidden) continue;
    const id = `${hit.category.id}/${hit.section.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({
      key: id,
      title: hit.kind === "setting" ? hit.def.label : hit.section.title,
      context: hit.kind === "setting" ? `${hit.category.title} › ${hit.section.title}` : hit.category.title,
      to: {
        name: "SettingsCategory",
        params: { category: hit.category.id },
        query: { section: hit.section.id },
      },
    });
  }
  return list;
});

const summary = computed(() => {
  const text = parseSearchQuery(props.query).text;
  if (modifiedOnly.value) {
    const what = `${hits.value.length} changed ${hits.value.length === 1 ? "setting" : "settings"}`;
    return text ? `${what} matching “${text}”` : `${what}. Click the dot next to one to reset it.`;
  }
  if (!hits.value.length) return `Nothing matches “${props.query.trim()}”`;
  return `${hits.value.length} ${hits.value.length === 1 ? "match" : "matches"} for “${props.query.trim()}”`;
});

const go = (to: object) => {
  emit("navigate");
  router.push(to);
};
</script>

<template>
  <div class="space-y-10">
    <PageHeader :title="modifiedOnly ? 'Changed settings' : 'Search results'" :description="summary" />

    <SettingsSection
      v-for="group in groups"
      :key="group.id"
      :title="group.title"
      :description="group.context"
    >
      <SettingRow v-for="hit in group.hits" :key="hit.def.key" :def="hit.def" />
    </SettingsSection>

    <SettingsSection v-if="links.length" title="Sections">
      <div class="-mx-3 space-y-px py-2">
        <button
          v-for="link in links"
          :key="link.key"
          type="button"
          class="group flex h-14 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors duration-fast hover:bg-accent/50 focus-ring focus-visible:ring-inset"
          @click="go(link.to)"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-foreground">{{ link.title }}</p>
            <p class="truncate text-xs text-muted-foreground">{{ link.context }}</p>
          </div>
          <ChevronRight
            class="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast group-hover:translate-x-0.5"
          />
        </button>
      </div>
    </SettingsSection>

    <EmptyState
      v-if="!hits.length"
      :icon="SearchX"
      :title="modifiedOnly ? 'Nothing changed' : 'No settings found'"
      :description="modifiedOnly ? 'Every setting has its default value.' : 'Try another word, or @modified to list what you changed.'"
    />
  </div>
</template>
