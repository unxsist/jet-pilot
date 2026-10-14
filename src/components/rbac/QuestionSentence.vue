<script setup lang="ts">
/**
 * The question as a sentence you edit in place: "Can I [list] [pods] in
 * [payments]?" or "Who can …". A name and a subresource are optional
 * extras; "a URL path" asks about non-resource URLs (/metrics).
 */
import { X } from "lucide-vue-next";
import TokenPicker from "./TokenPicker.vue";
import {
  EVERY_NAMESPACE,
  URL_RESOURCE,
  VERB_OPTIONS,
  isNamespaced,
  parseResourceValue,
  resourceOptions,
  subresourceOptions,
  type Question,
} from "./question";
import type { DiscoveredResource, DiscoverySnapshot } from "@/lib/discovery";

const props = defineProps<{
  mode: "me" | "who";
  resources: DiscoveredResource[];
  discovery: DiscoverySnapshot | null;
  namespaces: string[];
}>();
const question = defineModel<Question>("question", { required: true });

const isUrl = computed(() => question.value.resource === URL_RESOURCE);
const parsed = computed(() => parseResourceValue(question.value.resource));
const namespaced = computed(() => !isUrl.value && isNamespaced(props.resources, parsed.value.resource, parsed.value.group));

const resourceList = computed(() => {
  const options = resourceOptions(props.resources);
  // Keep a typed or deep-linked resource that discovery doesn't know.
  if (!options.some((o) => o.value === question.value.resource)) {
    options.unshift({ value: question.value.resource, label: parsed.value.resource, hint: parsed.value.group || undefined });
  }
  return options;
});
const subresources = computed(() => subresourceOptions(props.discovery, parsed.value.resource, parsed.value.group));
const namespaceList = computed(() => [
  {
    value: EVERY_NAMESPACE,
    label: props.mode === "me" ? "every namespace" : "any namespace",
    hint: props.mode === "me" ? "cluster-wide" : undefined,
  },
  ...props.namespaces.map((ns) => ({ value: ns, label: ns })),
]);

const nameOpen = ref(!!question.value.name);
const subresourceOpen = ref(!!question.value.subresource);
const nameInput = ref<HTMLInputElement | null>(null);

/* Another resource: its subresources differ. */
const setResource = (value: string) => {
  question.value.resource = value;
  question.value.subresource = "";
  subresourceOpen.value = false;
};
watch(
  () => [question.value.name, question.value.subresource],
  ([name, subresource]) => {
    if (name) nameOpen.value = true;
    if (subresource) subresourceOpen.value = true;
  }
);

const addName = () => {
  nameOpen.value = true;
  nextTick(() => nameInput.value?.focus());
};
const clearName = () => {
  question.value.name = "";
  nameOpen.value = false;
};
const clearSubresource = () => {
  question.value.subresource = "";
  subresourceOpen.value = false;
};
const inputWidth = (text: string, placeholder: string) => `${Math.max(text.length, placeholder.length) + 1}ch`;

const inlineInput =
  "token rounded-md bg-transparent px-1 py-0.5 font-medium text-foreground outline-none transition-colors duration-fast placeholder:font-normal placeholder:text-muted-foreground/80 hover:bg-accent/70 focus:bg-accent";
</script>

<template>
  <div class="space-y-3">
    <p class="question tracking-tight text-muted-foreground">
      {{ mode === "me" ? "Can I" : "Who can" }}
      <TokenPicker v-model="question.verb" :options="VERB_OPTIONS" label="Verb" custom />
      <template v-if="isUrl">
        <TokenPicker :model-value="question.resource" :options="resourceList" label="Resource" display="the URL" @update:model-value="setResource" />
        <input
          v-model.trim="question.path"
          type="text"
          spellcheck="false"
          aria-label="URL path"
          placeholder="/metrics"
          :class="inlineInput"
          class="font-mono text-lg"
          :style="{ width: inputWidth(question.path, '/metrics') }"
        />
      </template>
      <template v-else>
        <TokenPicker :model-value="question.resource" :options="resourceList" label="Resource" custom @update:model-value="setResource" />
        <template v-if="subresourceOpen">
          <span>/</span>
          <TokenPicker
            v-model="question.subresource"
            :options="subresources"
            label="Subresource"
            placeholder="subresource"
            custom
          />
        </template>
        <template v-if="nameOpen">
          named
          <input
            ref="nameInput"
            v-model.trim="question.name"
            type="text"
            spellcheck="false"
            aria-label="Name"
            placeholder="any name"
            :class="inlineInput"
            :style="{ width: inputWidth(question.name, 'any name') }"
            @keydown.esc="clearName"
          />
        </template>
        <template v-if="namespaced">
          in
          <TokenPicker v-model="question.namespace" :options="namespaceList" label="Namespace" custom />
        </template>
        <template v-else>across the cluster</template>
      </template>
      <span class="-ml-1.5">?</span>
    </p>

    <div v-if="!isUrl" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <button
        v-if="!nameOpen"
        type="button"
        class="rounded font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
        @click="addName"
      >
        + A specific name
      </button>
      <button
        v-else
        type="button"
        class="inline-flex items-center gap-1 rounded font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
        @click="clearName"
      >
        <X class="h-3 w-3" /> Any name
      </button>
      <button
        v-if="!subresourceOpen"
        type="button"
        class="rounded font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
        @click="subresourceOpen = true"
      >
        + A subresource<span v-if="subresources.length" class="font-normal"> ({{ subresources.slice(0, 3).map((s) => s.label).join(", ") }}{{ subresources.length > 3 ? ", …" : "" }})</span>
      </button>
      <button
        v-else
        type="button"
        class="inline-flex items-center gap-1 rounded font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
        @click="clearSubresource"
      >
        <X class="h-3 w-3" /> No subresource
      </button>
    </div>
  </div>
</template>

<style scoped>
/* A word you can change: a dashed underline that firms up on hover. Kept
   out of the utility classes, which all ship in the startup CSS. */
.token {
  text-decoration-line: underline;
  text-decoration-style: dashed;
  text-decoration-thickness: 1px;
  text-decoration-color: hsl(var(--border-strong));
  text-underline-offset: 6px;
}
.token:hover,
.token:focus,
.token[data-state="open"] {
  text-decoration-color: hsl(var(--foreground) / 0.5);
}
/* Large enough to read as a question; tokens wrap like words. */
.question {
  font-size: 1.125rem;
  line-height: 2.5rem;
}
</style>
