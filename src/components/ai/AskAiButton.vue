<script setup lang="ts">
/*
 * "Ask AI" in the side panel's header row: a small popover for the
 * question (empty asks the default one), then the agent starts in a
 * terminal tab with the object's state as its first evidence. Only shown
 * while an agent is set up (Settings › AI).
 */
import { Sparkles } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { useAskAi } from "@/lib/ai/askAi";
import { agentName } from "@/lib/ai/agents";
import { OBJECT_QUESTION } from "@/lib/ai/prompt";
import { objectState } from "@/lib/resources/state";
import { guardedCluster } from "@/lib/guardrails/backstop";

const props = defineProps<{
  resource: Record<string, any>;
  context: string;
  kubeConfig: string;
}>();

const { settings } = injectStrict(SettingsContextStateKey);
const askAi = useAskAi();

const open = ref(false);
const question = ref("");
watch(open, (value) => value && (question.value = ""));

const name = computed(() => props.resource.metadata?.name as string);
const agent = computed(() => agentName(settings.value.ai.agent, settings.value.ai.customCommand));
const readOnly = computed(() => guardedCluster(props.context, props.kubeConfig).readOnly);

const evidence = (): string[] => {
  const { kind, metadata } = props.resource;
  const facts = [`${kind} ${metadata?.name}${metadata?.namespace ? ` in namespace ${metadata.namespace}` : ""}`];
  const state = objectState(props.resource);
  if (state) facts.push(`State: ${state.label}${state.detail ? `. ${state.detail}` : ""}`);
  return facts;
};

const submit = () => {
  askAi.ask({
    context: props.context,
    kubeConfig: props.kubeConfig,
    namespace: props.resource.metadata?.namespace,
    subject: `${name.value} (${props.resource.kind})`,
    question: question.value.trim() || OBJECT_QUESTION(name.value),
    evidence: evidence(),
  });
  open.value = false;
};

/* Enter asks, Shift+Enter is a new line (not while composing with an IME). */
const onEnter = (event: KeyboardEvent) => {
  if (event.isComposing) return;
  event.preventDefault();
  submit();
};
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="outline" size="xs">
        <Sparkles class="h-3 w-3" /> Ask AI
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-80 p-3">
      <form class="space-y-2.5" @submit.prevent="submit">
        <label for="ask-ai-question" class="block text-sm font-medium text-foreground">
          Ask {{ agent }} about {{ name }}
        </label>
        <Textarea
          id="ask-ai-question"
          v-model="question"
          rows="3"
          class="resize-none"
          :placeholder="OBJECT_QUESTION(name)"
          @keydown.enter.exact="onEnter"
        />
        <div class="flex items-center justify-between gap-3">
          <p class="min-w-0 text-xs text-muted-foreground">
            {{ readOnly ? "Read-only cluster: it starts in its read-only mode." : "Opens in a terminal tab." }}
          </p>
          <Button type="submit" size="sm" class="shrink-0">Ask</Button>
        </div>
      </form>
    </PopoverContent>
  </Popover>
</template>
