<script setup lang="ts">
/*
 * One settings category: its sections in order. A section is a card with
 * the rows of its preferences, and/or a bespoke component (theme library,
 * kubeconfig files...) that renders its own card. `?setting=<key>` scrolls
 * to a preference and highlights it, `?section=<id>` to a section.
 */
import { useRoute, useRouter } from "vue-router";
import { type as getOsType } from "@tauri-apps/plugin-os";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import SettingRow from "@/components/settings/SettingRow.vue";
import {
  categoryById,
  sectionAnchor,
  sectionSettings,
  settingAnchor,
  type SettingSection,
} from "@/lib/settings/categories";
import type { Component } from "vue";

const route = useRoute();
const router = useRouter();
const platform = getOsType();

const category = computed(() => categoryById(String(route.params.category)));
watch(
  category,
  (found) => {
    if (!found) router.replace({ name: "SettingsCategory", params: { category: "general" } });
  },
  { immediate: true }
);

const rows = (section: SettingSection) =>
  category.value ? sectionSettings(category.value.id, section.id, platform) : [];

/* Bespoke section components, loaded once per section. */
const bespoke = new Map<string, Component>();
const sectionComponent = (section: SettingSection) => {
  if (!section.component) return null;
  let component = bespoke.get(section.id);
  if (!component) {
    component = defineAsyncComponent(section.component);
    bespoke.set(section.id, component);
  }
  return component;
};

/* Deep links: highlight the setting for a moment, after the page rendered. */
const highlighted = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
const reveal = async () => {
  const setting = typeof route.query.setting === "string" ? route.query.setting : null;
  const section = typeof route.query.section === "string" ? route.query.section : null;
  if (!setting && !section) return;
  await nextTick();
  // Bespoke sections load asynchronously: give them a moment.
  for (let attempt = 0; attempt < 20; attempt++) {
    const element = document.getElementById(setting ? settingAnchor(setting) : sectionAnchor(section!));
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      highlighted.value = setting;
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => (highlighted.value = null), 1600);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
watch(() => [route.query.setting, route.query.section, route.params.category], reveal, { immediate: true });
onBeforeUnmount(() => highlightTimer && clearTimeout(highlightTimer));
</script>

<template>
  <div v-if="category" class="space-y-6">
    <header class="space-y-1">
      <h2 class="text-lg font-semibold tracking-tight">{{ category.title }}</h2>
      <p class="text-sm text-muted-foreground">{{ category.description }}</p>
    </header>
    <div
      v-for="section in category.sections"
      :id="sectionAnchor(section.id)"
      :key="section.id"
      class="scroll-mt-24 space-y-6"
    >
      <SettingsSection
        v-if="rows(section).length > 0"
        :title="section.title"
        :description="section.description"
      >
        <SettingRow
          v-for="def in rows(section)"
          :key="def.key"
          :def="def"
          :highlighted="highlighted === def.key"
        />
      </SettingsSection>
      <component :is="sectionComponent(section)" v-if="section.component" />
    </div>
  </div>
</template>
