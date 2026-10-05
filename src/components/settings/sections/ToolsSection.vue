<script setup lang="ts">
/*
 * Settings › Advanced › Command-line tools, as a calm list: each tool with
 * its platform's mark, where it was found (or what it is for) and its
 * version, and a one-click, checksum-verified download of kubectl and Helm
 * when they are missing. Downloads go to ~/.kube/jet-pilot/bin, which comes
 * after your own PATH: tools you install yourself always win.
 */
import { type as getOsType } from "@tauri-apps/plugin-os";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Download, ExternalLink, Loader2, RefreshCw, ShipWheel, Trash2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import { settingsTile } from "@/components/settings/styles";
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
import type { ProviderId } from "@/lib/clusters/provider";

const { toast } = useToast();

/* The mark of each tool's platform (Helm gets its wheel). */
const TOOL_MARKS: Partial<Record<ToolId, ProviderId>> = {
  kubectl: "other",
  aws: "aws",
  gcloud: "gcp",
  "gke-gcloud-auth-plugin": "gcp",
  az: "azure",
  kubelogin: "azure",
  doctl: "digitalocean",
};
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
    description="Tools JET Pilot runs for you. Downloads are checked against their official checksums."
  >
    <template #actions>
      <Button
        size="icon-sm"
        variant="ghost"
        class="-mr-1.5 text-muted-foreground"
        :disabled="checking"
        title="Check again"
        aria-label="Check for tools again"
        @click="check(true)"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="checking ? 'animate-spin' : ''" />
      </Button>
    </template>

    <div class="py-2">
      <div v-if="!tools && checking" class="flex h-14 items-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" /> Looking for tools…
      </div>
      <p v-else-if="loadError" class="py-4 text-sm text-destructive">{{ loadError }}</p>

      <div class="-mx-3 space-y-px" role="list" aria-label="Command-line tools">
        <div
          v-for="tool in tools ?? []"
          :key="tool.id"
          role="listitem"
          class="group/tool flex min-h-14 items-center gap-3 rounded-lg px-3 py-2"
        >
          <span :class="[settingsTile, !tool.found && 'border-dashed bg-transparent']">
            <span :class="tool.found ? '' : 'opacity-40 grayscale'" class="flex">
              <ProviderMark v-if="TOOL_MARKS[tool.id]" :provider="TOOL_MARKS[tool.id]!" :size="16" />
              <ShipWheel v-else class="h-4 w-4" />
            </span>
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-foreground">{{ tool.name }}</p>
            <p
              class="truncate text-xs"
              :class="tool.problem ? 'text-warning' : 'text-muted-foreground'"
              :title="tool.path ?? undefined"
            >
              <template v-if="tool.problem">{{ tool.problem }}</template>
              <template v-else-if="tool.source === 'managed'">Downloaded by JET Pilot</template>
              <span v-else-if="tool.found && tool.path" class="font-mono">{{ tool.path }}</span>
              <template v-else>{{ TOOL_INFO[tool.id]?.purpose }}</template>
            </p>
            <div v-if="downloads.has(tool.id)" class="flex items-center gap-2 pt-1.5">
              <Progress :model-value="percent(tool.id) ?? 0" class="h-1 flex-1" />
              <span class="w-28 text-right text-2xs tabular-nums text-muted-foreground">
                <template v-if="downloads.get(tool.id)?.verifying">Verifying…</template>
                <template v-else-if="percent(tool.id) !== null">
                  {{ formatBytes(downloads.get(tool.id)!.received) }} · {{ percent(tool.id) }}%
                </template>
                <template v-else>Starting…</template>
              </span>
            </div>
          </div>

          <span v-if="tool.found && tool.version" class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {{ tool.version }}
          </span>
          <span
            v-else-if="!tool.found && TOOL_INFO[tool.id]?.essential"
            class="flex shrink-0 items-center gap-1.5 text-xs text-warning"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-current" />
            Needed
          </span>

          <div class="flex shrink-0 items-center gap-1 empty:hidden">
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
                <Button size="sm" variant="ghost" class="-mr-2 text-muted-foreground hover:text-foreground">How to install</Button>
              </PopoverTrigger>
              <PopoverContent align="end" class="w-80 space-y-3">
                <div class="space-y-0.5">
                  <p class="text-sm font-medium">Install {{ tool.name }}</p>
                  <p class="text-xs text-muted-foreground">For {{ TOOL_INFO[tool.id]?.purpose.toLowerCase() }}.</p>
                </div>
                <div
                  v-if="installCommand(tool.id)"
                  class="flex items-center gap-2 rounded-lg bg-muted/60 py-1 pl-3 pr-1"
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
                <p class="text-xs text-muted-foreground">
                  Installed it? Check again. JET Pilot reads the PATH of your login shell when it starts.
                </p>
              </PopoverContent>
            </Popover>
            <Button
              v-if="tool.source === 'managed'"
              size="icon-sm"
              variant="ghost"
              class="text-muted-foreground opacity-0 transition-opacity duration-fast hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/tool:opacity-100"
              :aria-label="`Remove the ${tool.name} JET Pilot downloaded`"
              title="Remove download"
              @click="remove(tool)"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  </SettingsSection>
</template>
