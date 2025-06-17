<script setup lang="ts">
import Separator from "@/components/ui/separator/Separator.vue";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
} from "@/components/ui/form";
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputItemDelete,
  TagsInputItemText,
} from "@/components/ui/tags-input";
import { Kubernetes } from "@/services/Kubernetes";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";

const contexts = ref<{ name: string; context: { namespace: string } }[]>([]);
const currentContext = ref<string | undefined>(undefined);

const { settings } = injectStrict(SettingsContextStateKey);

const getNamespacesForCluster = (): string[] => {
  const clusterSettings = settings.value.contextSettings.find(
    (c) => c.context === currentContext.value
  );

  return clusterSettings?.namespaces ?? [];
};

const setNamespacesForCluster = (namespaces: string[]) => {
  const clusterSettings = settings.value.contextSettings.find(
    (c) => c.context === currentContext.value
  );

  if (clusterSettings) {
    clusterSettings.namespaces = namespaces;
  } else {
    settings.value.contextSettings.push({
      context: currentContext.value as string,
      namespaces,
    });
  }
};

onMounted(async () => {
  contexts.value = await Kubernetes.getContexts();
});
</script>
<template>
  <div class="flex items-center justify-between">
    <div>
      <h3 class="text-lg font-medium">Cluster specific settings</h3>
      <p class="text-sm text-muted-foreground">
        Settings that can be tuned per cluster
      </p>
    </div>
    <div>
      <Select v-model="currentContext">
        <SelectTrigger>
          <SelectValue placeholder="Select a cluster" />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            <SelectItem
              v-for="context in contexts"
              :key="context.name"
              :value="context.name"
            >
              {{ context.name }}
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  </div>
  <Separator />
  <div v-if="!currentContext">
    <p class="text-sm text-muted-foreground">
      Select a cluster to view its specific settings
    </p>
  </div>
  <div v-else>
    <div>
      <FormField name="namespaces">
        <FormItem>
          <FormLabel>Namespaces</FormLabel>
          <FormControl>
            <TagsInput
              :model-value="getNamespacesForCluster()"
              @update:model-value="setNamespacesForCluster"
            >
              <TagsInputItem
                v-for="namespace in getNamespacesForCluster()"
                :key="namespace"
                :value="namespace"
              >
                <TagsInputItemText />
                <TagsInputItemDelete />
              </TagsInputItem>

              <TagsInputInput placeholder="Namespace..." />
            </TagsInput>
          </FormControl>
          <FormDescription>
            Allows you to specify the namespaces to use for this cluster
          </FormDescription>
          <FormMessage />
        </FormItem>
      </FormField>
    </div>
  </div>
</template>
