<script setup lang="ts">
/*
 * Asked before a custom action runs: its inputs, the container (when the
 * pod has several), its confirmation, and what will run with these
 * answers, updated as you type.
 */
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TriangleAlert } from "lucide-vue-next";
import ActionPreview from "@/components/customActions/ActionPreview.vue";
import { defaultInputs, planItem, type PlanItem } from "@/lib/customActions/plan";
import { renderText } from "@/lib/customActions/template";
import type { ShellDialect } from "@/lib/customActions/template";
import type { CustomAction } from "@/lib/customActions/types";
import { runVerb } from "@/lib/customActions/words";

export interface PromptAnswer {
  inputs: Record<string, string>;
  container?: string;
}

const props = defineProps<{
  action: CustomAction;
  items: PlanItem[];
  containers: string[];
  dialect: ShellDialect;
  containerShell: string;
  /** The action changes the cluster (the confirmation reads as a warning). */
  mutates: boolean;
  done: (answer: PromptAnswer | null) => void;
}>();
const emit = defineEmits<{ closeDialog: [] }>();

const inputs = reactive<Record<string, string>>(defaultInputs(props.action));
const container = ref(props.containers[0]);

const answer = computed<PromptAnswer>(() => ({ inputs: { ...inputs }, container: container.value }));

const first = computed(() => props.items[0]!);
const planned = computed(() => planItem(props.action, first.value, { ...answer.value, dialect: props.dialect, containerShell: props.containerShell }));
const confirmText = computed(() =>
  props.action.confirm
    ? renderText(props.action.confirm, {
        object: first.value.object,
        context: first.value.context,
        kubeConfig: first.value.kubeConfig,
        inputs: answer.value.inputs,
        container: container.value,
      })
    : ""
);

/* Pick lists of a few short values read best as segmented buttons. */
const segmented = (options: string[]) => options.length <= 4 && options.every((option) => option.length <= 14);

let settled = false;
const finish = (result: PromptAnswer | null) => {
  if (settled) return;
  settled = true;
  props.done(result);
  emit("closeDialog");
};
onBeforeUnmount(() => finish(null));

/* Enter on a segmented choice runs too (text fields submit by themselves). */
const onEnter = (event: KeyboardEvent) => {
  if ((event.target as HTMLElement | null)?.closest?.("[role=tab]")) {
    event.preventDefault();
    finish(answer.value);
  }
};

const firstField = ref<InstanceType<typeof Input>[] | null>(null);
onMounted(() => {
  const element = (firstField.value?.[0] as unknown as { $el?: HTMLElement })?.$el;
  (element as HTMLInputElement | undefined)?.focus?.();
});
</script>

<template>
  <form class="space-y-5" @submit.prevent="finish(answer)" @keydown.enter="onEnter">
    <div v-if="action.inputs.length || containers.length" class="space-y-4">
      <div v-if="containers.length" class="space-y-1.5">
        <Label class="text-xs font-medium text-muted-foreground">Container</Label>
        <Tabs v-if="segmented(containers)" v-model="container">
          <TabsList aria-label="Container">
            <TabsTrigger v-for="name in containers" :key="name" :value="name" class="px-2.5">
              {{ name }}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Select v-else v-model="container">
          <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="name in containers" :key="name" :value="name">{{ name }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div v-for="input in action.inputs" :key="input.name" class="space-y-1.5">
        <Label :for="`action-input-${input.name}`" class="text-xs font-medium text-muted-foreground">
          {{ input.label }}
        </Label>
        <template v-if="input.options?.length">
          <Tabs v-if="segmented(input.options)" v-model="inputs[input.name]">
            <TabsList :aria-label="input.label">
              <TabsTrigger v-for="option in input.options" :key="option" :value="option" class="px-2.5">
                {{ option }}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Select v-else v-model="inputs[input.name]">
            <SelectTrigger :id="`action-input-${input.name}`" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in input.options" :key="option" :value="option">{{ option }}</SelectItem>
            </SelectContent>
          </Select>
        </template>
        <Input
          v-else
          :id="`action-input-${input.name}`"
          ref="firstField"
          v-model="inputs[input.name]"
          :type="input.type === 'number' ? 'number' : 'text'"
          :placeholder="input.placeholder"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
    </div>

    <p
      v-if="confirmText"
      class="flex gap-2 text-sm"
      :class="mutates ? 'text-foreground' : 'text-muted-foreground'"
    >
      <TriangleAlert v-if="mutates" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      <span>{{ confirmText }}</span>
    </p>

    <ActionPreview :type="action.run.type" :text="planned.display" :more="items.length - 1" />

    <AlertDialogFooter>
      <Button type="button" variant="ghost" @click="finish(null)">Cancel</Button>
      <Button type="submit">{{ runVerb(action) }}</Button>
    </AlertDialogFooter>
  </form>
</template>
