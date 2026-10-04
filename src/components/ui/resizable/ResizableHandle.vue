<script setup lang="ts">
import { cn } from '@/lib/utils'
import { DragHandleDots2Icon } from '@radix-icons/vue'
import { SplitterResizeHandle, type SplitterResizeHandleEmits, type SplitterResizeHandleProps, useForwardPropsEmits } from 'radix-vue'
import { computed, type HTMLAttributes } from 'vue'

const props = defineProps<SplitterResizeHandleProps & { class?: HTMLAttributes['class'], withHandle?: boolean }>()
const emits = defineEmits<SplitterResizeHandleEmits>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SplitterResizeHandle v-bind="forwarded" :class="cn('relative flex w-px items-center justify-center bg-border transition-colors duration-base data-[resize-handle-state=hover]:bg-primary/50 data-[resize-handle-state=drag]:bg-primary after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 [&[data-orientation=vertical]]:h-px [&[data-orientation=vertical]]:w-full [&[data-orientation=vertical]]:after:left-0 [&[data-orientation=vertical]]:after:h-1 [&[data-orientation=vertical]]:after:w-full [&[data-orientation=vertical]]:after:-translate-y-1/2 [&[data-orientation=vertical]]:after:translate-x-0 [&[data-orientation=vertical]>div]:rotate-90', props.class)">
    <template v-if="props.withHandle">
      <div class="z-10 flex h-5 w-3 items-center justify-center rounded-sm border bg-surface-2 text-muted-foreground shadow-xs">
        <DragHandleDots2Icon class="h-2.5 w-2.5" />
      </div>
    </template>
  </SplitterResizeHandle>
</template>
