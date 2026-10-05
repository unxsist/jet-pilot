<script setup lang="ts">
/*
 * One settings category: a page title, then its sections in order. A
 * section shows the rows of its preferences under a quiet heading, and/or a
 * bespoke component (theme library, kubeconfig files...) that renders its
 * own section. `?setting=<key>` scrolls to a preference and highlights it,
 * `?section=<id>` to a section.
 */
import { useRoute, useRouter } from "vue-router";
import { type as getOsType } from "@tauri-apps/plugin-os";
import PageHeader from "@/components/page/PageHeader.vue";
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

/*
 * Deep links: scroll once the bespoke sections rendered (they load
 * asynchronously and push what follows down), settle again when they grew
 * with their data, and highlight the setting for a moment.
 */
const highlighted = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/* Scrolls the settings page only (scrollIntoView would also scroll clipped ancestors near the end). */
const scrollToElement = (element: HTMLElement, block: "center" | "start") => {
  const scroller = element.closest<HTMLElement>("[data-settings-scroll]");
  if (!scroller) return element.scrollIntoView({ block });
  const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const offset = block === "start" ? 40 : Math.max(40, (scroller.clientHeight - element.offsetHeight) / 2);
  scroller.scrollTo({ top: Math.max(0, top - offset) });
};
const bespokeRendered = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-bespoke-section]")).every((element) => element.offsetHeight > 0);
const reveal = async () => {
  const setting = typeof route.query.setting === "string" ? route.query.setting : null;
  const section = typeof route.query.section === "string" ? route.query.section : null;
  if (!setting && !section) return;
  await nextTick();
  for (let attempt = 0; attempt < 40; attempt++) {
    const element = document.getElementById(setting ? settingAnchor(setting) : sectionAnchor(section!));
    if (element && (bespokeRendered() || attempt >= 20)) {
      const block = setting ? "center" : "start";
      scrollToElement(element, block);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => scrollToElement(element, block), 350);
      highlighted.value = setting;
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => (highlighted.value = null), 1600);
      return;
    }
    await sleep(50);
  }
};
watch(() => [route.query.setting, route.query.section, route.params.category], reveal, { immediate: true });
onBeforeUnmount(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
  if (settleTimer) clearTimeout(settleTimer);
});
</script>

<template>
  <div v-if="category" class="space-y-10">
    <PageHeader :title="category.title" :description="category.description" />
    <div
      v-for="section in category.sections"
      :id="sectionAnchor(section.id)"
      :key="section.id"
      class="space-y-10"
      :data-bespoke-section="section.component ? '' : undefined"
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
