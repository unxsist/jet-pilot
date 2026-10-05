<script setup lang="ts">
/* "?" cheat sheet of the resource table keyboard shortcuts. */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Keyboard } from "lucide-vue-next";
import { tableShortcuts } from "./keyboard";

const props = defineProps<{ isMac: boolean }>();
const open = defineModel<boolean>("open", { default: false });

const groups = computed(() => tableShortcuts(props.isMac));
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-2xl gap-5" @close-auto-focus.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Keyboard class="h-4 w-4 text-muted-foreground" />
          Keyboard shortcuts
        </DialogTitle>
        <DialogDescription class="text-sm text-muted-foreground">
          Typing filters the rows. The arrow keys (or a click) enter row
          mode: the row cursor appears and letters act on the row. Esc or
          typing into the filter goes back to filtering. Keys are ignored
          while typing in a field, editor or terminal.
        </DialogDescription>
      </DialogHeader>
      <div class="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        <section v-for="group in groups" :key="group.title">
          <h3
            class="text-2xs font-medium uppercase tracking-wider text-muted-foreground"
            :class="group.note ? 'mb-0.5' : 'mb-1.5'"
          >
            {{ group.title }}
          </h3>
          <p v-if="group.note" class="mb-1.5 text-2xs text-muted-foreground/80">
            {{ group.note }}
          </p>
          <ul class="divide-y divide-border-subtle">
            <li
              v-for="item in group.items"
              :key="item.label"
              class="flex items-center justify-between gap-4 py-1.5 text-sm"
            >
              <span class="text-foreground">{{ item.label }}</span>
              <span class="flex shrink-0 items-center gap-1.5">
                <template v-for="(combo, index) in item.keys" :key="index">
                  <span
                    v-if="index > 0"
                    class="text-2xs text-muted-foreground"
                    aria-hidden="true"
                    >or</span
                  >
                  <Kbd :keys="combo" size="sm" />
                </template>
              </span>
            </li>
          </ul>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
