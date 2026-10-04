<script setup lang="ts">
/*
 * Quick pick for keyboard actions with options (Logs / Shell per
 * container): anchored under the cursor row, ↑↓ / j k to move, Enter or
 * 1-9 to run, Esc to cancel.
 */
import { floatingSurface } from "@/components/ui/overlay-styles";
import { Kbd } from "@/components/ui/kbd";

const props = defineProps<{
  title: string;
  options: { label: string }[];
  /** Viewport position of the anchor (bottom-left of the row's first cell). */
  anchor: { x: number; y: number };
}>();

const emit = defineEmits<{
  (e: "select", index: number): void;
  (e: "close"): void;
}>();

const active = ref(0);
const list = ref<HTMLElement | null>(null);

const style = computed(() => {
  const maxTop = window.innerHeight - 40 - props.options.length * 28;
  return {
    left: `${Math.min(props.anchor.x, window.innerWidth - 280)}px`,
    top: `${Math.max(8, Math.min(props.anchor.y + 4, maxTop))}px`,
  };
});

const onKeydown = (event: KeyboardEvent) => {
  const count = props.options.length;
  let handled = true;
  if (event.key === "ArrowDown" || event.key === "j") {
    active.value = (active.value + 1) % count;
  } else if (event.key === "ArrowUp" || event.key === "k") {
    active.value = (active.value - 1 + count) % count;
  } else if (event.key === "Home") {
    active.value = 0;
  } else if (event.key === "End") {
    active.value = count - 1;
  } else if (event.key === "Enter") {
    emit("select", active.value);
  } else if (event.key === "Escape" || event.key === "Tab") {
    emit("close");
  } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= count) {
    emit("select", Number(event.key) - 1);
  } else {
    handled = false;
  }
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
};

const onPointerDownOutside = (event: PointerEvent) => {
  if (list.value && !list.value.contains(event.target as Node)) {
    emit("close");
  }
};

onMounted(() => {
  nextTick(() => list.value?.focus());
  window.addEventListener("pointerdown", onPointerDownOutside, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onPointerDownOutside, true);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="list"
      role="listbox"
      tabindex="-1"
      :aria-label="title"
      :aria-activedescendant="`row-option-${active}`"
      :class="[
        floatingSurface,
        'fixed z-50 min-w-[14rem] max-w-[22rem] p-1 animate-in fade-in-0 zoom-in-[0.97] duration-150',
      ]"
      :style="style"
      @keydown="onKeydown"
    >
      <div class="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
        {{ title }}
      </div>
      <div
        v-for="(option, index) in options"
        :id="`row-option-${index}`"
        :key="index"
        role="option"
        :aria-selected="index === active"
        class="relative flex min-h-[1.75rem] cursor-default select-none items-center gap-2 rounded-[5px] px-2 py-1 text-sm outline-none"
        :class="index === active ? 'bg-accent text-accent-foreground' : ''"
        @pointermove="active = index"
        @click="emit('select', index)"
      >
        <span class="truncate">{{ option.label }}</span>
        <Kbd v-if="index < 9" size="sm" variant="ghost" class="ml-auto">{{
          index + 1
        }}</Kbd>
      </div>
    </div>
  </Teleport>
</template>
