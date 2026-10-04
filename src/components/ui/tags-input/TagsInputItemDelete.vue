<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { TagsInputItemDelete, type TagsInputItemDeleteProps, useForwardProps } from 'radix-vue'
import { Cross2Icon } from '@radix-icons/vue'
import { cn } from '@/lib/utils'

const props = defineProps<TagsInputItemDeleteProps & { class?: HTMLAttributes['class'] }>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props

  return delegated
})

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <TagsInputItemDelete v-bind="forwardedProps" :class="cn('mr-0.5 flex rounded-sm bg-transparent text-muted-foreground transition-colors hover:text-foreground', props.class)">
    <slot>
      <Cross2Icon class="h-3 w-3" />
    </slot>
  </TagsInputItemDelete>
</template>
