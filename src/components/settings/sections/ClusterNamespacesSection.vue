<script setup lang="ts">
/*
 * Settings › Clusters › Namespaces per cluster: namespaces to offer for a
 * context where listing namespaces is forbidden (contextSettings, used by
 * the context switcher).
 */
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsBlock } from "@/components/settings/styles";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { EmptyState } from "@/components/ui/empty-state";
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
import { Check, ChevronsUpDown, MousePointerClick } from "lucide-vue-next";
import { error } from "@/lib/logger";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
} from "@/components/ui/form";
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputItemDelete,
  TagsInputItemText,
} from "@/components/ui/tags-input";
import { Kubernetes } from "@/services/Kubernetes";
import { resolveKubeconfigPaths } from "@/lib/kubeconfigSources";
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
  for (const kubeConfig of await resolveKubeconfigPaths(settings.value)) {
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
  <SettingsSection
    title="Namespaces per cluster"
    description="Namespaces to offer in the context switcher, for clusters where you can't list them"
  >
    <template #actions>
      <Popover v-model:open="pickerOpen">
        <PopoverTrigger as-child>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            :aria-expanded="pickerOpen"
            class="w-[240px] justify-between font-normal"
          >
            <span class="flex min-w-0 items-center gap-2">
              <ContextAvatar
                v-if="currentContext"
                :name="currentContext"
                size="sm"
                class="[--avatar-ring:var(--background)]"
              />
              <span
                class="truncate"
                :class="{ 'text-muted-foreground': !currentContext }"
                >{{ currentContext || "Select a cluster" }}</span
              >
            </span>
            <ChevronsUpDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent class="w-[320px] p-0" align="end">
          <Command>
            <CommandInput placeholder="Search clusters…" />
            <CommandList>
              <CommandEmpty>No clusters found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  v-for="context in contexts"
                  :key="context.name"
                  :value="context.name"
                  @select="selectContext(context.name)"
                >
                  <ContextAvatar
                    :name="context.name"
                    size="sm"
                    class="[--avatar-ring:var(--popover)]"
                  />
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate">{{ context.name }}</span>
                    <span
                      class="truncate font-mono text-2xs text-muted-foreground"
                      :title="context.kubeConfigs.join(', ')"
                      >{{ context.kubeConfigs.join(", ") }}</span
                    >
                  </div>
                  <Check
                    class="h-3.5 w-3.5 shrink-0 text-primary"
                    :class="
                      currentContext === context.name
                        ? 'opacity-100'
                        : 'opacity-0'
                    "
                  />
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </template>
    <EmptyState
      v-if="!currentContext"
      size="sm"
      :icon="MousePointerClick"
      title="No cluster selected"
      description="Select a cluster to view its specific settings"
    />
    <div v-else :class="settingsBlock">
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

              <TagsInputInput placeholder="Namespace…" />
            </TagsInput>
          </FormControl>
          <FormDescription>
            Allows you to specify the namespaces to use for this cluster
          </FormDescription>
          <FormMessage />
        </FormItem>
      </FormField>
    </div>
  </SettingsSection>
</template>
