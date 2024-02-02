<script setup lang="ts">
const model = defineModel<object[]>({ required: true });

const props = defineProps<{
  options: any[];
  labelKey: string;
}>();

const availableOptions = computed(() => {
  return props.options.filter((option) => {
    return !model.value.includes(option);
  });
});

const labelFor = (option: any) => {
  return option[props.labelKey];
};
</script>
<template>
  <div class="flex">
    <ul>
      <li v-for="(option, index) in availableOptions" :key="index">
        {{ labelFor(option) }}
      </li>
    </ul>
    <div>
      <button>&gt;</button>
      <button>&lt;</button>
    </div>
    <ul>
      <li v-for="(option, index) in model" :key="index">
        {{ labelFor(option) }}
      </li>
    </ul>
  </div>
</template>
