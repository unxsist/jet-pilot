<script setup lang="ts">
import Separator from "@/components/ui/separator/Separator.vue";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-vue-next";
import { error } from "@/lib/logger";
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

/*
 * Cluster settings are stored per context name, so a name defined in several
 * kubeconfigs shares its settings: list each name once, with the kubeconfigs
 * defining it.
 */
const contexts = ref<{ name: string; kubeConfigs: string[] }[]>([]);
const currentContext = ref<string | undefined>(undefined);
const pickerOpen = ref(false);

const { settings } = injectStrict(SettingsContextStateKey);

const getNamespacesForCluster = (): string[] => {
  const clusterSettings = settings.value.contextSettings.find(
    (c) => c.context === currentContext.value
  );

  return clusterSettings?.namespaces ?? [];
};

const setNamespacesForCluster = (values: unknown[]) => {
  const namespaces = values.map(String);
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

const fetchContexts = async () => {
  const byName = new Map<string, string[]>();
  for (const kubeConfig of settings.value.kubeConfigs) {
    try {
      for (const ctx of await Kubernetes.getContexts(kubeConfig)) {
        byName.set(ctx.name, [...(byName.get(ctx.name) || []), kubeConfig]);
      }
    } catch (e) {
      error(`Failed to list contexts of kubeconfig ${kubeConfig}: ${e}`);
    }
  }

  contexts.value = [...byName.entries()]
    .map(([name, kubeConfigs]) => ({ name, kubeConfigs }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const selectContext = (name: string) => {
  currentContext.value = name;
  pickerOpen.value = false;
};

onMounted(fetchContexts);
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
      <Popover v-model:open="pickerOpen">
        <PopoverTrigger as-child>
          <Button
            variant="outline"
            role="combobox"
            :aria-expanded="pickerOpen"
            class="w-[260px] justify-between font-normal"
          >
            <span class="truncate">{{ currentContext || "Select a cluster" }}</span>
            <ChevronsUpDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent class="w-[320px] p-0" align="end">
          <Command>
            <CommandInput placeholder="Search clusters..." />
            <CommandList>
              <CommandEmpty>No clusters found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  v-for="context in contexts"
                  :key="context.name"
                  :value="context.name"
                  @select="selectContext(context.name)"
                >
                  <Check
                    class="mr-2 h-4 w-4 shrink-0"
                    :class="
                      currentContext === context.name
                        ? 'opacity-100'
                        : 'opacity-0'
                    "
                  />
                  <div class="flex flex-col min-w-0">
                    <span class="truncate">{{ context.name }}</span>
                    <span
                      class="text-xs text-muted-foreground truncate"
                      :title="context.kubeConfigs.join(', ')"
                      >{{ context.kubeConfigs.join(", ") }}</span
                    >
                  </div>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
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
