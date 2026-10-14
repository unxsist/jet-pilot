<script setup lang="ts">
/** KEDA triggers in words, with the query and credentials one line below. */
import ObjectLink from "./ObjectLink.vue";
import { triggerDetails, triggerInWords, triggers } from "@/lib/operators/keda";
import { targetOf } from "@/lib/operators/panel";

const props = defineProps<{ object: any }>();

const list = computed(() =>
  triggers(props.object).map((trigger) => ({
    words: triggerInWords(trigger),
    details: triggerDetails(trigger),
    name: trigger?.name as string | undefined,
  }))
);
</script>

<template>
  <p v-if="list.length === 0" class="text-xs text-muted-foreground">No triggers: nothing makes it scale.</p>
  <ul v-else class="divide-y divide-border-subtle text-xs">
    <li v-for="(trigger, index) in list" :key="index" class="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
      <p class="font-medium">{{ trigger.words }}</p>
      <pre
        v-if="trigger.details.query"
        class="select-text whitespace-pre-wrap break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
        >{{ trigger.details.query }}</pre
      >
      <p
        v-for="field in trigger.details.fields"
        :key="field.label"
        class="truncate text-muted-foreground"
        :title="field.value"
      >
        {{ field.label }} <span class="text-foreground/80">{{ field.value }}</span>
      </p>
      <p v-if="trigger.details.auth" class="flex items-center gap-1.5 text-muted-foreground">
        Credentials from
        <ObjectLink
          :target="targetOf(object)"
          :object="{
            apiVersion: 'keda.sh/v1alpha1',
            kind: trigger.details.auth.kind,
            name: trigger.details.auth.name,
            namespace: trigger.details.auth.kind === 'TriggerAuthentication' ? object.metadata?.namespace : undefined,
          }"
        />
      </p>
    </li>
  </ul>
</template>
