<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { TagsInputRoot, type TagsInputRootEmits, type TagsInputRootProps, useForwardPropsEmits } from 'radix-vue'
import { cn } from '@/lib/utils'
import { fieldBase } from '@/components/ui/input'

const props = defineProps<TagsInputRootProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<TagsInputRootEmits>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props

  return delegated
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <TagsInputRoot v-bind="forwarded" :class="cn(fieldBase, 'flex min-h-[2rem] flex-wrap items-center gap-1 px-1.5 py-1 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20', props.class)">
    <slot />
  </TagsInputRoot>
</template>
