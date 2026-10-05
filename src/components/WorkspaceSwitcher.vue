<script setup lang="ts">
import {
  Check,
  ChevronsUpDown,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-vue-next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { injectStrict } from "@/lib/utils";
import {
  WorkspacesKey,
  WORKSPACE_SHORTCUT_COUNT,
} from "@/providers/WorkspaceProvider";
import { describeWorkspace, MAX_WORKSPACES } from "@/lib/workspaces";
import { type as getOsType } from "@tauri-apps/plugin-os";

/*
 * Compact workspace switcher in the sidebar ("hotbar"): the first nine
 * workspaces are also on Mod+Alt+1..9 and in the command palette.
 */
const { workspaces, active, saveAs, update, switchTo, rename, remove } =
  injectStrict(WorkspacesKey);

const isMac = getOsType() === "macos";
const shortcut = (index: number) =>
  index < WORKSPACE_SHORTCUT_COUNT
    ? `${isMac ? "⌘⌥" : "Ctrl+Alt+"}${index + 1}`
    : "";

const renaming = ref(false);
const draftName = ref("");
const startRename = () => {
  draftName.value = active.value?.name ?? "";
  renaming.value = true;
};
const confirmRename = () => {
  if (active.value) rename(active.value.id, draftName.value);
  renaming.value = false;
};

const saved = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | undefined;
const updateActive = () => {
  if (!active.value) return;
  update(active.value.id);
  saved.value = true;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (saved.value = false), 1500);
};
onUnmounted(() => clearTimeout(savedTimer));
</script>
<template>
  <div class="w-full">
    <DropdownMenu>
      <DropdownMenuTrigger
        class="group flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-fast ease-out hover:bg-accent/70 hover:text-foreground focus-ring focus-visible:ring-offset-sidebar data-[state=open]:bg-accent data-[state=open]:text-foreground"
        :aria-label="
          active ? `Workspace: ${active.name}` : 'Workspaces: none active'
        "
        data-workspace-switcher
      >
        <Layers class="h-3.5 w-3.5 shrink-0" />
        <span class="min-w-0 flex-1 truncate text-left">
          <template v-if="active">
            <span class="font-medium text-foreground">{{ active.name }}</span>
          </template>
          <template v-else>No workspace</template>
        </span>
        <span
          v-if="saved"
          class="text-2xs text-success"
          role="status"
          aria-live="polite"
          >Saved</span
        >
        <ChevronsUpDown class="h-3 w-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        class="w-72 p-1"
        align="start"
        side="right"
        :side-offset="8"
      >
        <DropdownMenuLabel class="flex items-center justify-between">
          <span>Workspaces</span>
          <span class="font-normal tabular-nums text-muted-foreground/70">{{
            workspaces.length
          }}</span>
        </DropdownMenuLabel>
        <DropdownMenuItem
          v-for="(workspace, index) in workspaces"
          :key="workspace.id"
          class="items-start gap-2.5 py-1.5"
          @select="switchTo(workspace.id)"
        >
          <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
            <Check
              v-if="workspace.id === active?.id"
              class="h-3.5 w-3.5 text-primary"
            />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm">{{ workspace.name }}</span>
            <span class="block truncate text-xs text-muted-foreground">{{
              describeWorkspace(workspace)
            }}</span>
          </span>
          <DropdownMenuShortcut v-if="shortcut(index)" class="mt-0.5">{{
            shortcut(index)
          }}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <div
          v-if="workspaces.length === 0"
          class="px-2 py-2 text-xs text-muted-foreground"
        >
          Save the active contexts, namespaces, open tabs and port forwards
          as a workspace and switch between them in one keystroke.
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          :disabled="workspaces.length >= MAX_WORKSPACES"
          @select="saveAs()"
        >
          <Plus class="h-3.5 w-3.5" /> Save current as new workspace
        </DropdownMenuItem>
        <template v-if="active">
          <DropdownMenuItem @select="updateActive">
            <RefreshCw class="h-3.5 w-3.5" /> Update “{{ active.name }}”
          </DropdownMenuItem>
          <DropdownMenuItem @select="startRename">
            <Pencil class="h-3.5 w-3.5" /> Rename…
          </DropdownMenuItem>
          <DropdownMenuItem
            class="text-destructive focus:text-destructive"
            @select="remove(active.id)"
          >
            <Trash2 class="h-3.5 w-3.5" /> Delete “{{ active.name }}”
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>

    <Dialog :open="renaming" @update:open="(open: boolean) => (renaming = open)">
      <DialogContent class="max-w-sm">
        <form class="grid gap-4" @submit.prevent="confirmRename">
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription
              >Shown in the sidebar and the command palette.</DialogDescription
            >
          </DialogHeader>
          <Input
            v-model="draftName"
            aria-label="Workspace name"
            maxlength="60"
            autofocus
          />
          <DialogFooter>
            <Button type="button" variant="ghost" @click="renaming = false"
              >Cancel</Button
            >
            <Button type="submit" :disabled="!draftName.trim()">Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
