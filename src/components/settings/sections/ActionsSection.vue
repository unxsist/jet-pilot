<script setup lang="ts">
/*
 * Settings › Actions › Your actions: every file of the actions folder as a
 * calm row (icon, name, what it applies to, its file, on/off). A broken
 * file says which line and why, with a way to fix it. Rows open the form
 * editor; the menu has the YAML editor, duplicate and delete.
 */
import { useRouter } from "vue-router";
import { type as osType } from "@tauri-apps/plugin-os";
import { Code, Copy, FolderOpen, MoreHorizontal, Pencil, Plus, Trash2, TriangleAlert, Zap } from "lucide-vue-next";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsTile } from "@/components/settings/styles";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Kbd } from "@/components/ui/kbd";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCustomActions } from "@/lib/customActions/store";
import { actionIconComponent } from "@/lib/customActions/icons";
import { describeScope } from "@/lib/customActions/scope";
import { shortcutKeys } from "@/lib/customActions/shortcut";
import { fileNameFor } from "@/lib/customActions/schema";
import type { ActionFile } from "@/lib/customActions/types";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { confirmDialog } from "@/lib/guardrails/guard";
import { injectStrict, cn } from "@/lib/utils";
import {
  isEnabled,
  nameInText,
  openActionsFolder,
  removeActionFile,
  setEnabled,
  writeActionFile,
} from "@/components/settings/actions/shared";

const router = useRouter();
const { settings } = injectStrict(SettingsContextStateKey);
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const { files, ready } = useCustomActions();
const isMac = osType() === "macos";

const edit = (file: ActionFile) =>
  router.push({ name: "SettingsActionEditor", params: { file: file.file } });
const editYaml = (file: ActionFile) =>
  router.push({ name: "SettingsActionYaml", params: { file: file.file } });
const create = () => router.push({ name: "SettingsActionEditor" });

const duplicate = async (file: ActionFile) => {
  const copy = fileNameFor(`${file.action?.name ?? file.id} copy`, files.value.map((f) => f.file));
  const text = file.action ? file.text.replace(/^name:.*$/m, `name: ${file.action.name} (copy)`) : file.text;
  if (await writeActionFile(copy, text)) router.push({ name: "SettingsActionEditor", params: { file: copy } });
};

const remove = async (file: ActionFile) => {
  const confirmed = await confirmDialog(spawnDialog, {
    title: `Delete ${file.action?.name ?? file.file}?`,
    message: `${file.file} is removed from the actions folder.`,
    confirmLabel: "Delete",
    variant: "destructive",
  });
  if (!confirmed) return;
  await removeActionFile(file.file);
  if (!isEnabled(settings.value, file.id)) setEnabled(settings.value, file.id, true);
};

const title = (file: ActionFile) => file.action?.name ?? nameInText(file.text) ?? file.id;
/* By name, so a list of ten reads like a menu. */
const sorted = computed(() => [...files.value].sort((a, b) => title(a).localeCompare(title(b))));
const problem = (file: ActionFile) =>
  file.error ? (file.error.line ? `Line ${file.error.line}: ${file.error.message}` : file.error.message) : "";
</script>

<template>
  <SettingsSection
    title="Your actions"
    description="Shown in row menus, the side panel and the command palette, for the objects they apply to."
  >
    <template #actions>
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground"
        title="Open the actions folder"
        aria-label="Open the actions folder"
        @click="openActionsFolder"
      >
        <FolderOpen class="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" @click="create">
        <Plus class="h-3.5 w-3.5" />
        New action
      </Button>
    </template>

    <div class="py-2">
      <div v-if="!ready" class="space-y-px" aria-label="Loading actions">
        <div v-for="n in 3" :key="n" class="flex h-14 items-center gap-3">
          <Skeleton class="h-8 w-8 rounded-lg" />
          <div class="space-y-1.5">
            <Skeleton class="h-3 w-40" />
            <Skeleton class="h-2.5 w-56" />
          </div>
        </div>
      </div>

      <EmptyState
        v-else-if="files.length === 0"
        :icon="Zap"
        size="sm"
        title="No actions yet"
        description="Teach JET Pilot your own one-click actions: open a dashboard, run a script, tail logs. Start from an example below, or make your own."
        class="py-10"
      />

      <div v-else class="-mx-3 space-y-px" role="list" aria-label="Your actions">
        <div
          v-for="file in sorted"
          :key="file.file"
          role="listitem"
          :class="
            cn(
              'group/action flex min-h-14 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-fast hover:bg-accent/50',
              file.action && !isEnabled(settings, file.id) && 'text-muted-foreground'
            )
          "
          @click="file.action ? edit(file) : editYaml(file)"
        >
          <span
            :class="
              cn(
                settingsTile,
                file.error && 'border-dashed border-destructive/40 bg-transparent text-destructive',
                file.action && !isEnabled(settings, file.id) && 'opacity-50'
              )
            "
          >
            <TriangleAlert v-if="file.error" class="h-4 w-4" />
            <component :is="actionIconComponent(file.action?.icon)" v-else class="h-4 w-4" />
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <p
                class="truncate text-sm"
                :class="file.action && !isEnabled(settings, file.id) ? 'text-muted-foreground' : 'text-foreground'"
              >
                {{ title(file) }}
              </p>
              <Kbd
                v-if="file.action?.shortcut"
                :keys="shortcutKeys(file.action.shortcut, isMac)"
                size="sm"
                variant="ghost"
                class="shrink-0"
              />
            </div>
            <p v-if="file.error" class="truncate text-xs text-destructive" :title="problem(file)">
              {{ problem(file) }}
            </p>
            <p v-else-if="file.action" class="truncate text-xs text-muted-foreground">
              {{ describeScope(file.action.scope) }}
            </p>
          </div>

          <!-- The file: on hover (and always for a broken one, it names what to fix). -->
          <span
            :class="
              cn(
                'hidden shrink-0 font-mono text-xs text-muted-foreground transition-opacity duration-fast sm:block',
                !file.error && 'opacity-0 group-hover/action:opacity-100 group-focus-within/action:opacity-100'
              )
            "
            :title="file.path"
          >
            {{ file.file }}
          </span>

          <Button
            v-if="file.error"
            size="sm"
            variant="outline"
            class="shrink-0"
            @click.stop="editYaml(file)"
          >
            Fix in YAML
          </Button>
          <Switch
            v-else
            :checked="isEnabled(settings, file.id)"
            :aria-label="`${isEnabled(settings, file.id) ? 'Turn off' : 'Turn on'} ${title(file)}`"
            class="shrink-0"
            @click.stop
            @update:checked="(on: boolean) => setEnabled(settings, file.id, on)"
          />

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                size="icon-sm"
                variant="ghost"
                class="-mr-1.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast focus-visible:opacity-100 group-hover/action:opacity-100 data-[state=open]:opacity-100"
                :aria-label="`More for ${title(file)}`"
                @click.stop
              >
                <MoreHorizontal class="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-44">
              <DropdownMenuItem v-if="file.action" @select="edit(file)">
                <Pencil class="h-3.5 w-3.5 text-muted-foreground" /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem @select="editYaml(file)">
                <Code class="h-3.5 w-3.5 text-muted-foreground" /> Edit as YAML
              </DropdownMenuItem>
              <DropdownMenuItem @select="duplicate(file)">
                <Copy class="h-3.5 w-3.5 text-muted-foreground" /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @select="remove(file)">
                <Trash2 class="h-3.5 w-3.5" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  </SettingsSection>
</template>
