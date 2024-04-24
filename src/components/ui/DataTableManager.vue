<script setup lang="ts">
import { ColumnDef } from "@tanstack/vue-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import MultiSelect from "@/components/ui/MultiSelect.vue";

type ObjectProperty = {
  path: string;
  name: string;
};

const columnPickerDialogOpen = ref(true);

const props = defineProps<{
  defaultColumns: ColumnDef<any>[];
  data: object[];
}>();

const getObjectProperties = (
  obj: any,
  parent: string | null = null
): ObjectProperty[] => {
  console.log(obj);

  let properties: ObjectProperty[] = [];

  Object.keys(obj).forEach((key) => {
    const path = [parent, key].filter((k) => k).join(".");
    if (obj[key] instanceof Object) {
      properties.push(...getObjectProperties(obj[key], path));
    } else {
      properties.push({ path: path, name: key });
    }
  });

  return properties;
};

const availableColumns = computed((): ColumnDef<any>[] => {
  if (props.data.length === 0) {
    return [...props.defaultColumns];
  }

  return [...props.defaultColumns];
});
</script>
<template>
  <Dialog :open="false">
    <DialogContent class="flex flex-col w-[400px] h-[400px]">
      <DialogHeader>
        <DialogTitle>Column Picker</DialogTitle>
        <DialogDescription>
          Manage visible columns for this view
        </DialogDescription>
      </DialogHeader>
      <div class="overflow-y-auto">
        <div class="flex" v-if="data.length > 0">
          <MultiSelect :options="getObjectProperties(data[0])" labelKey="" />
        </div>
        <span v-else>Unable to resolve columns as no data is present</span>
      </div>
      <DialogFooter>
        <Button type="submit"> Apply </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  <slot v-bind="{ availableColumns }" />
</template>
