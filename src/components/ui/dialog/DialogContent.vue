<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  type DialogContentEmits,
  type DialogContentProps,
  DialogOverlay,
  DialogPortal,
  useEmitAsProps,
} from "radix-vue";
import { Cross2Icon } from "@radix-icons/vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<
    DialogContentProps & {
      class?: string;
      closeable?: boolean;
      overlayClass?: string;
      /** `center` (default) or `top` (command-palette style, 14vh from the top) */
      position?: "center" | "top";
    }
  >(),
  {
    closeable: true,
    position: "center",
  }
);
const emits = defineEmits<DialogContentEmits>();

const emitsAsProps = useEmitAsProps(emits);

const delegatedProps = computed(() => {
  const {
    class: _,
    closeable: __,
    overlayClass: ___,
    position: ____,
    ...delegated
  } = props;

  return delegated;
});
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      :class="
        cn(
          'fixed inset-0 z-50 bg-overlay backdrop-blur-[3px]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:duration-200 data-[state=closed]:duration-150',
          props.overlayClass
        )
      "
    />
    <DialogContent
      :class="
        cn(
          'fixed left-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] gap-4 rounded-xl border bg-popover p-5 text-popover-foreground shadow-lg outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.97] data-[state=closed]:slide-out-to-left-1/2 data-[state=open]:slide-in-from-left-1/2 data-[state=open]:duration-200 data-[state=closed]:duration-150 data-[state=open]:ease-out data-[state=closed]:ease-in',
          props.position === 'top'
            ? 'top-[14vh] data-[state=open]:slide-in-from-top-1'
            : 'top-[50%] translate-y-[-50%] data-[state=closed]:slide-out-to-top-[49%] data-[state=open]:slide-in-from-top-[49%]',
          props.class
        )
      "
      v-bind="{ ...delegatedProps, ...emitsAsProps }"
    >
      <slot />

      <DialogClose
        v-if="closeable !== false"
        class="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Cross2Icon class="h-3.5 w-3.5" />
        <span class="sr-only">Close</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
