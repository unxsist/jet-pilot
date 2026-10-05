<script setup lang="ts">
/*
 * The setup guide's tools step, kept light: kubectl and Helm as rows (with
 * a checksum-verified download when missing), the cloud CLIs as quiet chips
 * that open their install guide. Everything else (versions, removing a
 * download) lives in Settings › Advanced.
 */
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { CheckCircle2, CircleDashed, Download, Loader2, RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { settingsTile } from "@/components/settings/styles";
import { TOOL_INFO, detectTools, installTool, type ToolId, type ToolStatus } from "@/lib/tools";

const { toast } = useToast();

const CORE: ToolId[] = ["kubectl", "helm"];

const tools = ref<ToolStatus[] | null>(null);
const checking = ref(false);
const failed = ref<string | null>(null);
const check = async (force = false) => {
  checking.value = true;
  failed.value = null;
  try {
    tools.value = await detectTools(force);
  } catch (e) {
    failed.value = String(e);
  } finally {
    checking.value = false;
  }
};
onMounted(() => void check());

const core = computed(() => (tools.value ?? []).filter((tool) => CORE.includes(tool.id)));
const cloud = computed(() => (tools.value ?? []).filter((tool) => !CORE.includes(tool.id)));

/* Download progress by tool (0–100, null until the size is known). */
const downloads = reactive(new Map<ToolId, number | null>());
const install = async (tool: ToolStatus) => {
  downloads.set(tool.id, null);
  try {
    const status = await installTool(tool.id, (event) => {
      if (event.type === "progress" && event.total) downloads.set(tool.id, Math.round((event.received / event.total) * 100));
    });
    tools.value = (tools.value ?? []).map((t) => (t.id === status.id ? status : t));
    toast({ title: `${tool.name} is ready`, description: "Downloaded and verified.", variant: "success" });
  } catch (e) {
    toast({ title: `Couldn't download ${tool.name}`, description: String(e), variant: "destructive" });
  } finally {
    downloads.delete(tool.id);
  }
};
</script>

<template>
  <div class="space-y-6">
    <div class="rounded-xl border bg-card p-1.5 shadow-xs">
      <div v-if="!tools" class="flex h-14 items-center gap-2 px-3 text-sm text-muted-foreground">
        <template v-if="failed"><span class="text-destructive">{{ failed }}</span></template>
        <template v-else><Loader2 class="h-4 w-4 animate-spin" /> Looking for tools…</template>
      </div>
      <div v-for="tool in core" :key="tool.id" class="flex items-center gap-3 rounded-lg px-3 py-2.5">
        <span :class="settingsTile">
          <CheckCircle2 v-if="tool.found" class="h-4 w-4 text-success" />
          <CircleDashed v-else class="h-4 w-4" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">{{ tool.name }}</p>
          <p class="truncate text-xs" :class="tool.problem ? 'text-warning' : 'text-muted-foreground'">
            {{ tool.problem ?? TOOL_INFO[tool.id].purpose }}
          </p>
          <Progress v-if="downloads.has(tool.id)" :model-value="downloads.get(tool.id) ?? 0" class="mt-1.5 h-1" />
        </div>
        <span v-if="tool.found" class="font-mono text-xs text-muted-foreground">{{ tool.version }}</span>
        <Button v-else-if="tool.installable" size="sm" variant="outline" :disabled="downloads.has(tool.id)" @click="install(tool)">
          <Loader2 v-if="downloads.has(tool.id)" class="h-3.5 w-3.5 animate-spin" />
          <Download v-else class="h-3.5 w-3.5" />
          Download{{ tool.installVersion ? ` ${tool.installVersion}` : "" }}
        </Button>
        <Button v-else size="sm" variant="ghost" @click="openExternal(TOOL_INFO[tool.id].url)">How to install</Button>
      </div>
    </div>

    <section v-if="cloud.length" class="space-y-3">
      <div class="flex items-end justify-between gap-4">
        <div>
          <h2 class="text-sm font-medium">Cloud sign-in</h2>
          <p class="text-xs text-muted-foreground">Only needed for clusters in that cloud. Click a missing one to see how to install it.</p>
        </div>
        <Button size="sm" variant="ghost" class="text-muted-foreground" :disabled="checking" @click="check(true)">
          <RefreshCw class="h-3.5 w-3.5" :class="checking ? 'animate-spin' : ''" />
          Check again
        </Button>
      </div>
      <ul class="flex flex-wrap gap-2">
        <li v-for="tool in cloud" :key="tool.id">
          <span
            v-if="tool.found"
            class="flex h-8 items-center gap-2 rounded-full border bg-card px-3 text-xs"
            :title="tool.path ?? undefined"
          >
            <CheckCircle2 class="h-3.5 w-3.5 text-success" />
            <span class="font-medium">{{ tool.name }}</span>
            <span class="font-mono text-muted-foreground">{{ tool.version }}</span>
          </span>
          <button
            v-else
            type="button"
            class="flex h-8 items-center gap-2 rounded-full border border-dashed px-3 text-xs text-muted-foreground transition-colors duration-fast hover:border-border-strong hover:text-foreground focus-ring"
            :title="`How to install ${tool.name}: ${TOOL_INFO[tool.id].purpose}`"
            @click="openExternal(TOOL_INFO[tool.id].url)"
          >
            <CircleDashed class="h-3.5 w-3.5" />
            {{ tool.name }}
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
