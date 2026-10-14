<script setup lang="ts">
/*
 * Settings › Actions › Examples: well-made actions to start from. "Add"
 * copies one into the actions folder (nothing is installed by default);
 * from then on it is the user's file.
 */
import { useRouter } from "vue-router";
import { Check, Plus } from "lucide-vue-next";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { settingsTile } from "@/components/settings/styles";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ACTION_EXAMPLES } from "@/lib/customActions/examples";
import { actionIconComponent } from "@/lib/customActions/icons";
import { parseActionFile } from "@/lib/customActions/schema";
import { useCustomActions } from "@/lib/customActions/store";
import { writeActionFile } from "@/components/settings/actions/shared";

const router = useRouter();
const { files } = useCustomActions();

const examples = ACTION_EXAMPLES.map((example) => ({
  ...example,
  action: parseActionFile(example.file, example.text).action!,
}));

const added = (file: string) => files.value.some((f) => f.file === file);
const adding = ref<string | null>(null);

const add = async (example: (typeof examples)[number]) => {
  adding.value = example.file;
  const ok = await writeActionFile(example.file, example.text);
  adding.value = null;
  if (!ok) return;
  toast({
    title: `Added ${example.action.name}`,
    description: "It shows up for the objects it applies to. Make it yours in its editor.",
    variant: "success",
    autoDismiss: true,
  });
};

const open = (file: string) => router.push({ name: "SettingsActionEditor", params: { file } });
</script>

<template>
  <SettingsSection title="Examples" description="Add one to start from, then make it yours.">
    <div class="-mx-3 space-y-px py-2" role="list" aria-label="Example actions">
      <div
        v-for="example in examples"
        :key="example.file"
        role="listitem"
        class="flex min-h-12 items-center gap-3 rounded-lg px-3 py-1.5"
      >
        <span :class="[settingsTile, 'h-7 w-7 border-transparent bg-transparent']">
          <component :is="actionIconComponent(example.action.icon)" class="h-3.5 w-3.5" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm text-foreground">{{ example.action.name }}</p>
          <p class="truncate text-xs text-muted-foreground">{{ example.action.description }}</p>
        </div>
        <Button
          v-if="added(example.file)"
          size="sm"
          variant="ghost"
          class="-mr-1.5 shrink-0 text-muted-foreground"
          :title="`Edit ${example.action.name}`"
          @click="open(example.file)"
        >
          <Check class="h-3.5 w-3.5 text-success" />
          Added
        </Button>
        <Button
          v-else
          size="sm"
          variant="ghost"
          class="-mr-1.5 shrink-0"
          :disabled="adding === example.file"
          @click="add(example)"
        >
          <Plus class="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
    </div>
  </SettingsSection>
</template>
