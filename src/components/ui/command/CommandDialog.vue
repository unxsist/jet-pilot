<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from "radix-vue";
import { DialogDescription, useEmitAsProps } from "radix-vue";
import Command from "./Command.vue";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import Fuse from "fuse.js";

const value = ref("");
const props = withDefaults(
  defineProps<
    DialogRootProps & {
      hints?: boolean;
      /** Replaces the default fuzzy filter (list of item values, query). */
      filter?: (list: any[], query: string) => any[];
    }
  >(),
  { hints: true, filter: undefined }
);
/** The text typed in the input. */
const searchTerm = defineModel<string>("searchTerm", { default: "" });
const emits = defineEmits<DialogRootEmits>();

const emitsAsProps = useEmitAsProps(emits);

const rootProps = computed(() => {
  const { hints: _, filter: __, ...rest } = props;
  return rest;
});

const filter = (
  list: (typeof Command)[],
  query: string
): (typeof Command)[] => {
  const fuse = new Fuse(list, {
    threshold: 0.3,
    // Match anywhere in the string: context names are often long (e.g. EKS
    // ARNs) with the distinguishing part at the end, which Fuse's default
    // location/distance scoring would reject (#20).
    ignoreLocation: true,
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
  <Dialog v-bind="{ ...rootProps, ...emitsAsProps }">
    <DialogContent
      :closeable="false"
      position="top"
      class="max-w-[640px] gap-0 overflow-visible p-0 shadow-xl"
    >
      <DialogTitle v-show="false" />
      <DialogDescription v-show="false" />
      <Command
        v-model="value"
        @update:modelValue="value = ''"
        v-model:searchTerm="searchTerm"
        :filterFunction="props.filter ?? filter"
        class="rounded-xl bg-transparent"
      >
        <slot />
        <div
          v-if="props.hints"
          class="flex h-9 shrink-0 items-center gap-4 border-t px-3 text-xs text-muted-foreground"
        >
          <span class="flex items-center gap-1.5"
            ><Kbd :keys="['↑', '↓']" size="sm" /> Navigate</span
          >
          <span class="flex items-center gap-1.5"
            ><Kbd size="sm">↵</Kbd> Select</span
          >
          <span class="ml-auto flex items-center gap-1.5"
            ><Kbd size="sm">esc</Kbd> Close</span
          >
        </div>
      </Command>
    </DialogContent>
  </Dialog>
</template>
