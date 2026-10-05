<script setup lang="ts">
/*
 * Settings › Advanced › Command-line tools: which tools JET Pilot found
 * (version, where), what each is for, and a one-click, checksum-verified
 * download of kubectl and Helm when they are missing. Downloads go to
 * ~/.kube/jet-pilot/bin, which comes after your own PATH: tools you install
 * yourself always win.
 */
import { type as getOsType } from "@tauri-apps/plugin-os";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  CheckCircle2,
  CircleDashed,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { useToast } from "@/components/ui/toast";
import {
  TOOL_INFO,
  detectTools,
  formatBytes,
  installTool,
  uninstallTool,
  type ToolId,
  type ToolStatus,
} from "@/lib/tools";

const { toast } = useToast();
const platform = getOsType() as "macos" | "linux" | "windows";

const tools = ref<ToolStatus[] | null>(null);
const loadError = ref<string | null>(null);
const checking = ref(false);

const check = async (force = false) => {
  checking.value = true;
  loadError.value = null;
  try {
    tools.value = (await detectTools(force)) ?? [];
  } catch (e) {
    loadError.value = String(e);
  } finally {
    checking.value = false;
  }
};
onMounted(() => void check());

/* Running downloads by tool. */
const downloads = reactive(
  new Map<ToolId, { received: number; total: number | null; verifying: boolean }>()
);
const percent = (id: ToolId) => {
  const download = downloads.get(id);
  return download?.total ? Math.round((download.received / download.total) * 100) : null;
};

const replace = (status: ToolStatus) => {
  if (!tools.value) return;
  tools.value = tools.value.map((tool) => (tool.id === status.id ? status : tool));
};

const install = async (tool: ToolStatus) => {
  downloads.set(tool.id, { received: 0, total: null, verifying: false });
  try {
    const status = await installTool(tool.id, (event) => {
      const download = downloads.get(tool.id);
      if (!download) return;
      if (event.type === "progress") {
        download.received = event.received;
        download.total = event.total ?? null;
      } else if (event.type === "verifying") {
        download.verifying = true;
      }
    });
    replace(status);
    toast({
      title: `${tool.name}${status.version ? ` ${status.version}` : ""} is ready`,
      description: "Downloaded, verified and available to JET Pilot and its terminals.",
      variant: "success",
    });
  } catch (e) {
    toast({ title: `Couldn't download ${tool.name}`, description: String(e), variant: "destructive" });
  } finally {
    downloads.delete(tool.id);
  }
};

const remove = async (tool: ToolStatus) => {
  try {
    await uninstallTool(tool.id);
    await check(true);
    toast({ title: `Removed the ${tool.name} JET Pilot downloaded` });
  } catch (e) {
    toast({ title: `Couldn't remove ${tool.name}`, description: String(e), variant: "destructive" });
  }
};

const installCommand = (id: ToolId) => TOOL_INFO[id]?.install?.[platform];
const copy = (text: string) =>
  writeText(text).then(
    () => toast({ title: "Command copied" }),
    () => undefined
  );
</script>

<template>
  <SettingsSection
    title="Command-line tools"
    description="Tools JET Pilot runs for you. Missing ones it can download are verified against their official checksums."
  >
    <template #actions>
      <Button size="sm" variant="ghost" :disabled="checking" @click="check(true)">
        <RefreshCw class="h-3.5 w-3.5" :class="checking ? 'animate-spin' : ''" />
        Check again
      </Button>
    </template>

    <div v-if="!tools && checking" class="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" /> Looking for tools…
    </div>
    <p v-else-if="loadError" class="px-5 py-4 text-sm text-destructive">{{ loadError }}</p>

    <div
      v-for="tool in tools ?? []"
      :key="tool.id"
      class="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-5 py-3"
    >
      <CheckCircle2 v-if="tool.found" class="h-4 w-4 text-success" aria-label="Found" />
      <CircleDashed v-else class="h-4 w-4 text-muted-foreground" aria-label="Not found" />
      <div class="min-w-0 space-y-0.5">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium">{{ tool.name }}</span>
          <span v-if="tool.version" class="font-mono text-xs text-muted-foreground">{{ tool.version }}</span>
          <Badge v-if="tool.source === 'managed'" variant="accent" size="sm">Downloaded by JET Pilot</Badge>
          <Badge v-else-if="!tool.found && TOOL_INFO[tool.id]?.essential" variant="warning" size="sm">Needed</Badge>
        </div>
        <p class="truncate text-xs text-muted-foreground" :title="tool.path ?? undefined">
          <template v-if="tool.problem">{{ tool.problem }}</template>
          <template v-else-if="tool.found && tool.path">{{ tool.path }}</template>
          <template v-else>{{ TOOL_INFO[tool.id]?.purpose }}</template>
        </p>
        <div v-if="downloads.has(tool.id)" class="flex items-center gap-2 pt-1">
          <Progress :model-value="percent(tool.id) ?? 0" class="h-1.5 flex-1" />
          <span class="w-28 text-right text-2xs tabular-nums text-muted-foreground">
            <template v-if="downloads.get(tool.id)?.verifying">Verifying…</template>
            <template v-else-if="percent(tool.id) !== null">
              {{ formatBytes(downloads.get(tool.id)!.received) }} · {{ percent(tool.id) }}%
            </template>
            <template v-else>Starting…</template>
          </span>
        </div>
      </div>
      <div class="flex items-center gap-1">
        <Button
          v-if="!tool.found && tool.installable"
          size="sm"
          variant="outline"
          :disabled="downloads.has(tool.id)"
          @click="install(tool)"
        >
          <Download class="h-3.5 w-3.5" />
          Download{{ tool.installVersion ? ` ${tool.installVersion}` : "" }}
        </Button>
        <Popover v-if="!tool.found">
          <PopoverTrigger as-child>
            <Button size="sm" variant="ghost">How to install</Button>
          </PopoverTrigger>
          <PopoverContent align="end" class="w-80 space-y-3">
            <p class="text-sm font-medium">Install {{ tool.name }}</p>
            <p class="text-xs text-muted-foreground">Used for: {{ TOOL_INFO[tool.id]?.purpose }}.</p>
            <div
              v-if="installCommand(tool.id)"
              class="flex items-center gap-2 rounded-md border bg-surface-1 py-1 pl-2.5 pr-1"
            >
              <code class="min-w-0 flex-1 truncate font-mono text-xs">{{ installCommand(tool.id) }}</code>
              <Button size="icon-sm" variant="ghost" aria-label="Copy command" @click="copy(installCommand(tool.id)!)">
                <Copy class="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button size="sm" variant="outline" class="w-full" @click="openExternal(TOOL_INFO[tool.id].url)">
              <ExternalLink class="h-3.5 w-3.5" />
              Installation guide
            </Button>
            <p class="text-2xs text-muted-foreground">
              Installed it? Use “Check again”. JET Pilot reads the PATH of your login shell when it starts.
            </p>
          </PopoverContent>
        </Popover>
        <Button
          v-if="tool.source === 'managed'"
          size="icon-sm"
          variant="ghost"
          class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          :aria-label="`Remove the ${tool.name} JET Pilot downloaded`"
          title="Remove download"
          @click="remove(tool)"
        >
          <Trash2 class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  </SettingsSection>
</template>
