<script setup lang="ts">
/*
 * Settings search results: matching preferences are editable right here,
 * matching bespoke sections (theme library, tools...) link to their page.
 */
import { useRouter } from "vue-router";
import { ArrowRight, SearchX } from "lucide-vue-next";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import SettingRow from "@/components/settings/SettingRow.vue";
import { EmptyState } from "@/components/ui/empty-state";
import { searchSettings, type SearchHit } from "@/lib/settings/search";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";

const props = defineProps<{ query: string }>();
const emit = defineEmits<{ navigate: [] }>();

const router = useRouter();
const { settings } = injectStrict(SettingsContextStateKey);

const hits = computed(() => searchSettings(props.query, settings.value));
const rows = computed(() =>
  hits.value.filter((hit): hit is Extract<SearchHit, { kind: "setting" }> => hit.kind === "setting" && !hit.def.hidden)
);
/* Sections, and preferences that are edited inside a bespoke section. */
const links = computed(() => {
  const seen = new Set<string>();
  const list: { key: string; title: string; description?: string; context: string; to: object }[] = [];
  for (const hit of hits.value) {
    if (hit.kind === "setting" && !hit.def.hidden) continue;
    const id = `${hit.category.id}/${hit.section.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({
      key: id,
      title: hit.kind === "setting" ? hit.def.label : hit.section.title,
      description: hit.kind === "setting" ? hit.def.description : hit.section.description,
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

const go = (to: object) => {
  emit("navigate");
  router.push(to);
};
</script>

<template>
  <div class="space-y-6">
    <header class="space-y-1">
      <h2 class="text-lg font-semibold tracking-tight">Search results</h2>
      <p class="text-sm text-muted-foreground">
        <template v-if="hits.length">
          {{ hits.length }} {{ hits.length === 1 ? "match" : "matches" }} for “{{ query.trim() }}”
        </template>
        <template v-else>Nothing matches “{{ query.trim() }}”</template>
      </p>
    </header>

    <SettingsSection v-if="rows.length" title="Settings">
      <SettingRow
        v-for="hit in rows"
        :key="hit.def.key"
        :def="hit.def"
        :context="`${hit.category.title} › ${hit.section.title}`"
      />
    </SettingsSection>

    <SettingsSection v-if="links.length" title="Sections">
      <button
        v-for="link in links"
        :key="link.key"
        type="button"
        class="group flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors duration-fast hover:bg-accent/50 focus-ring focus-visible:ring-inset"
        @click="go(link.to)"
      >
        <div class="min-w-0 flex-1 space-y-1">
          <p class="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{{ link.context }}</p>
          <p class="text-sm font-medium">{{ link.title }}</p>
          <p v-if="link.description" class="text-xs text-muted-foreground">{{ link.description }}</p>
        </div>
        <ArrowRight class="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast group-hover:translate-x-0.5" />
      </button>
    </SettingsSection>

    <EmptyState
      v-if="!hits.length"
      :icon="SearchX"
      title="No settings found"
      description="Try another word, or @modified to list what you changed."
    />
  </div>
</template>
