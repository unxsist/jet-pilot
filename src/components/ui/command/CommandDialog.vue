<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from "radix-vue";
import { DialogDescription, useEmitAsProps } from "radix-vue";
import Command from "./Command.vue";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import Fuse from "fuse.js";

const value = ref("");
const props = defineProps<DialogRootProps>();
const emits = defineEmits<DialogRootEmits>();

const emitsAsProps = useEmitAsProps(emits);

const filter = (list: Command[], query: string): Command[] => {
  const fuse = new Fuse(list, {
    threshold: 0.3,
    keys: [
      {
        name: "keywords",
        weight: 2,
      },
      "name",
      "description",
    ],
  });
  return fuse.search(query).map((result) => result.item);
};
</script>

<template>
  <Dialog v-bind="{ ...props, ...emitsAsProps }">
    <DialogContent class="p-0 shadow-lg">
      <DialogTitle v-show="false" />
      <DialogDescription v-show="false" />
      <Command
        v-model="value"
        @update:modelValue="value = ''"
        :filterFunction="filter"
        class="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
      >
        <slot />
      </Command>
    </DialogContent>
  </Dialog>
</template>
