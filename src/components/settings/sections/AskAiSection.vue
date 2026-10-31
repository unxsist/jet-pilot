<script setup lang="ts">
/*
 * Settings › AI › Ask AI: which AI agent CLI answers questions about a
 * cluster, as one calm list to pick from (installed agents with where they
 * were found, the others with how to install them), or a command line of
 * your own. Off by default: Ask AI stays hidden until an agent is picked.
 * Nothing is stored here but the choice: no keys, no accounts.
 */
import { watchDebounced } from "@vueuse/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, ExternalLink, RefreshCw, ShieldCheck } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/components/ui/toast";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsHint, settingsLabel } from "@/components/settings/styles";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { agentPaths, detectAgents } from "@/lib/ai/detect";
import { AGENTS, PROMPT_PLACEHOLDER, agentInfo, customProgram, type AgentInfo } from "@/lib/ai/agents";

const { settings } = injectStrict(SettingsContextStateKey);
const { toast } = useToast();
const ai = computed(() => settings.value.ai);

const checking = ref(false);
const checked = ref(false);
const program = computed(() => customProgram(ai.value.customCommand));

const check = async () => {
  checking.value = true;
  try {
    await detectAgents([...AGENTS.map((agent) => agent.program), program.value]);
  } catch (e) {
    toast({ title: "Couldn't look for agents", description: String(e), variant: "destructive" });
  } finally {
    checking.value = false;
    checked.value = true;
  }
};
onMounted(check);
watchDebounced(program, (value) => value && detectAgents([value]).catch(() => undefined), { debounce: 400 });

const pathOf = (name: string) => (name ? agentPaths.value[name] ?? null : null);
const found = (agent: AgentInfo) => !!pathOf(agent.program);
const noneFound = computed(() => checked.value && !AGENTS.some(found));

const pick = (id: string) => {
  settings.value.ai.agent = id;
};

const selected = computed(() => agentInfo(ai.value.agent));

const customLine = computed(() => {
  if (!program.value) return { text: "Any agent CLI, started with your command line", tone: "muted" };
  const path = pathOf(program.value);
  if (path) return { text: path, tone: "mono" };
  if (program.value in agentPaths.value) return { text: `${program.value} isn't on your PATH`, tone: "warning" };
  return { text: program.value, tone: "mono" };
});

const copy = (text: string) =>
  writeText(text).then(
    () => toast({ title: "Command copied" }),
    () => undefined
  );

const rowBox = "rounded-lg px-3 py-2 transition-colors duration-fast ease-out";
const row = `${rowBox} flex min-h-14 w-full items-center gap-3 text-left`;
/* The radio inside a row (the row itself holds more: install hints, inputs). */
const choice = "flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-ring disabled:cursor-default";
const radio = (on: boolean) => [
  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-fast",
  on ? "border-primary" : "border-border-strong",
];
</script>

<template>
  <SettingsSection
    title="Ask AI"
    description="Questions about a cluster go to the AI agent you already use, in a terminal tab with kubectl set to that cluster."
  >
    <template #actions>
      <Button
        size="icon-sm"
        variant="ghost"
        class="-mr-1.5 text-muted-foreground"
        :disabled="checking"
        title="Check again"
        aria-label="Look for agents again"
        @click="check"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="checking ? 'animate-spin' : ''" />
      </Button>
    </template>

    <div class="space-y-4 py-3">
      <p v-if="noneFound" class="text-sm text-muted-foreground">
        No AI agent found on this computer. Install one below, then check again.
      </p>

      <div class="-mx-3 space-y-px" role="radiogroup" aria-label="Agent">
        <button
          type="button"
          role="radio"
          :aria-checked="!ai.agent"
          :class="[row, 'focus-ring', !ai.agent ? 'bg-accent/60' : 'hover:bg-accent/40']"
          @click="pick('')"
        >
          <span :class="radio(!ai.agent)">
            <span v-if="!ai.agent" class="h-2 w-2 rounded-full bg-primary" />
          </span>
          <span class="min-w-0 flex-1">
            <span :class="[settingsLabel, 'block']">Off</span>
            <span :class="[settingsHint, 'block']">Ask AI stays hidden</span>
          </span>
        </button>

        <div
          v-for="agent in AGENTS"
          :key="agent.id"
          :class="[
            row,
            ai.agent === agent.id ? 'bg-accent/60' : found(agent) ? 'hover:bg-accent/40' : '',
          ]"
        >
          <button
            type="button"
            role="radio"
            :aria-checked="ai.agent === agent.id"
            :disabled="!found(agent) && ai.agent !== agent.id"
            :class="choice"
            @click="pick(agent.id)"
          >
            <span :class="[radio(ai.agent === agent.id), !found(agent) && 'border-dashed']">
              <span v-if="ai.agent === agent.id" class="h-2 w-2 rounded-full bg-primary" />
            </span>
            <span class="min-w-0 flex-1">
              <span :class="[settingsLabel, 'block truncate', !found(agent) && 'text-muted-foreground']">
                {{ agent.name }}
              </span>
              <span
                v-if="found(agent)"
                class="block truncate font-mono text-xs text-muted-foreground"
                :title="pathOf(agent.program) ?? undefined"
              >
                {{ pathOf(agent.program) }}
              </span>
              <span
                v-else
                class="block text-xs"
                :class="ai.agent === agent.id ? 'text-warning' : 'text-muted-foreground'"
              >
                {{ ai.agent === agent.id ? "Not found on your PATH" : "Not installed" }}
              </span>
            </span>
          </button>
          <Popover v-if="!found(agent) && checked">
            <PopoverTrigger as-child>
              <Button size="sm" variant="ghost" class="-mr-2 shrink-0 text-muted-foreground hover:text-foreground">
                How to install
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" class="w-96 space-y-3">
              <p class="text-sm font-medium">Install {{ agent.name }}</p>
              <div class="flex items-center gap-2 rounded-lg bg-muted/60 py-1 pl-3 pr-1">
                <code class="min-w-0 flex-1 truncate font-mono text-xs">{{ agent.install }}</code>
                <Button size="icon-sm" variant="ghost" aria-label="Copy command" @click="copy(agent.install)">
                  <Copy class="h-3.5 w-3.5" />
                </Button>
              </div>
              <Button size="sm" variant="outline" class="w-full" @click="openExternal(agent.url)">
                <ExternalLink class="h-3.5 w-3.5" />
                Installation guide
              </Button>
              <p class="text-xs text-muted-foreground">
                Installed it? Check again. JET Pilot reads the PATH of your login shell when it starts.
              </p>
            </PopoverContent>
          </Popover>
        </div>

        <div :class="[rowBox, ai.agent === 'custom' ? 'bg-accent/60' : 'hover:bg-accent/40']">
          <button
            type="button"
            role="radio"
            :aria-checked="ai.agent === 'custom'"
            :class="[choice, 'min-h-10 w-full']"
            @click="pick('custom')"
          >
            <span :class="radio(ai.agent === 'custom')">
              <span v-if="ai.agent === 'custom'" class="h-2 w-2 rounded-full bg-primary" />
            </span>
            <span class="min-w-0 flex-1">
              <span :class="[settingsLabel, 'block']">Custom command</span>
              <span
                class="block truncate text-xs"
                :class="{
                  'text-muted-foreground': customLine.tone !== 'warning',
                  'text-warning': customLine.tone === 'warning',
                  'font-mono': customLine.tone === 'mono',
                }"
              >
                {{ customLine.text }}
              </span>
            </span>
          </button>
          <div v-if="ai.agent === 'custom'" class="space-y-3 pb-1.5 pl-7 pt-3.5">
            <label class="block space-y-1.5">
              <span :class="[settingsLabel, 'block']">Command</span>
              <Input
                v-model="settings.ai.customCommand"
                class="font-mono text-xs"
                placeholder="my-agent {prompt}"
                spellcheck="false"
                autocomplete="off"
              />
              <span :class="[settingsHint, 'block']">
                {{ PROMPT_PLACEHOLDER }} becomes the question, or it goes last. Runs without a shell.
              </span>
            </label>
            <label class="block space-y-1.5">
              <span :class="[settingsLabel, 'block']">Read-only command</span>
              <Input
                v-model="settings.ai.customReadOnlyCommand"
                class="font-mono text-xs"
                placeholder="my-agent --read-only {prompt}"
                spellcheck="false"
                autocomplete="off"
              />
              <span :class="[settingsHint, 'block']">
                Used on read-only clusters. Leave it empty to keep your agent off them.
              </span>
            </label>
          </div>
        </div>
      </div>

      <p v-if="selected" :class="settingsHint">
        On read-only clusters, {{ selected.name }} {{ selected.readOnlyMode }}.
      </p>
    </div>

    <div class="flex items-center gap-2 py-3.5 text-xs text-muted-foreground">
      <ShieldCheck class="h-3.5 w-3.5 shrink-0" />
      Your agent sends what it reads to its own provider. JET Pilot sends nothing itself.
    </div>
  </SettingsSection>
</template>
