<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { TagsInputInput, type TagsInputInputProps, useForwardProps } from 'radix-vue'
import { cn } from '@/lib/utils'

const props = defineProps<TagsInputInputProps & { class?: HTMLAttributes['class'] }>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props

  return delegated
})

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <TagsInputInput v-bind="forwardedProps" :class="cn('min-h-[1.25rem] flex-1 bg-transparent px-1 text-sm placeholder:text-muted-foreground/80 focus:outline-none', props.class)" />
</template>
