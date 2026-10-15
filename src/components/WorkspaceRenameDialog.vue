<script setup lang="ts">
/*
 * Rename dialog of the workspace switcher. A chunk of its own: the switcher
 * loads it the first time "Rename…" is picked, so the sidebar doesn't carry
 * the dialog primitives at startup.
 */
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

const open = defineModel<boolean>("open", { required: true });
const name = defineModel<string>("name", { required: true });
const emit = defineEmits<{ confirm: [] }>();
</script>
<template>
  <Dialog :open="open" @update:open="(value: boolean) => (open = value)">
    <DialogContent class="max-w-sm">
      <form class="grid gap-4" @submit.prevent="emit('confirm')">
        <DialogHeader>
          <DialogTitle>Rename workspace</DialogTitle>
          <DialogDescription
            >Shown in the sidebar and the command palette.</DialogDescription
          >
        </DialogHeader>
        <Input
          v-model="name"
          aria-label="Workspace name"
          maxlength="60"
          autofocus
        />
        <DialogFooter>
          <Button type="button" variant="ghost" @click="open = false"
            >Cancel</Button
          >
          <Button type="submit" :disabled="!name.trim()">Rename</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
