<script setup lang="ts">
/**
 * One preference: label, one line of description and its control. A small
 * dot in the left gutter marks a value that differs from the default (click
 * it to reset); the menu in the right gutter (on hover) resets, copies the
 * setting id or opens it in settings.json.
 */
import { useRouter } from "vue-router";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { MoreHorizontal } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SettingControl from "@/components/settings/SettingControl.vue";
import { settingsHint, settingsLabel, settingsRow } from "@/components/settings/styles";
import { useToast } from "@/components/ui/toast";
import { injectStrict, cn } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { settingAnchor } from "@/lib/settings/categories";
import { formatSettingValue, validateSetting } from "@/lib/settings/values";
import { cloneJson, getPath, setPath, type JsonObject } from "@/lib/settings/paths";
import { isModified } from "@/lib/settings/store";
import type { SettingDefinition } from "@/lib/settings/types";

const props = defineProps<{
  def: SettingDefinition;
  /** Briefly highlight the row (deep links). */
  highlighted?: boolean;
}>();

const { settings } = injectStrict(SettingsContextStateKey);
const router = useRouter();
const { toast } = useToast();

const id = computed(() => settingAnchor(props.def.key));
const value = computed(() => getPath(settings.value, props.def.key));
const modified = computed(() => isModified(settings.value, props.def));
const defaultText = computed(() => formatSettingValue(props.def, props.def.default));
/* "New terminals" → "Applies to new terminals". */
const appliesTo = computed(() =>
  props.def.appliesTo ? `Applies to ${props.def.appliesTo.charAt(0).toLowerCase()}${props.def.appliesTo.slice(1)}` : null
);

const update = (next: unknown) => {
  const result = validateSetting(props.def, next);
  if (!result.ok) {
    toast({ title: `${props.def.label}: invalid value`, description: result.message, variant: "destructive" });
    return;
  }
  setPath(settings.value as unknown as JsonObject, props.def.key, result.value);
};

const reset = () => update(cloneJson(props.def.default));

const copyId = () =>
  writeText(props.def.key).then(
    () => toast({ title: "Setting ID copied", description: props.def.key }),
    () => undefined
  );
</script>

<template>
  <div
    :id="id"
    :class="
      cn(
        settingsRow,
        'group/setting relative isolate',
        'before:absolute before:-inset-x-3 before:inset-y-0 before:-z-10 before:rounded-lg before:bg-primary/[0.08] before:opacity-0 before:transition-opacity before:duration-slow',
        highlighted && 'before:opacity-100'
      )
    "
  >
    <div class="min-w-0">
      <div class="relative flex items-center gap-2">
        <button
          v-if="modified"
          type="button"
          class="group/dot absolute -left-[1.375rem] top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full focus-ring"
          :title="`Changed · default: ${defaultText}. Click to reset.`"
          :aria-label="`${def.label} is changed. Reset to the default, ${defaultText}`"
          @click="reset"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-primary transition-transform duration-fast group-hover/dot:scale-125" />
        </button>
        <label :for="id + '-control'" :class="settingsLabel">{{ def.label }}</label>
      </div>
      <p v-if="def.description || appliesTo" :class="cn(settingsHint, 'mt-0.5')">
        {{ def.description }}<template v-if="def.description && appliesTo"> · </template>{{ appliesTo }}
      </p>
    </div>

    <div class="flex min-w-0 items-center sm:justify-end">
      <SettingControl
        :id="id + '-control'"
        :def="def"
        :model-value="value"
        @update:model-value="update"
      />
    </div>

    <!-- Right gutter: the row's menu (keeps controls aligned with the section actions). -->
    <div class="absolute inset-y-0 -right-10 hidden w-10 items-center justify-end sm:flex">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/setting:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            :aria-label="`More actions for ${def.label}`"
          >
            <MoreHorizontal class="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-60">
          <DropdownMenuItem :disabled="!modified" @select="reset">
            Reset to default
            <DropdownMenuShortcut class="max-w-[6rem] truncate font-sans">{{ defaultText }}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="copyId">Copy setting ID</DropdownMenuItem>
          <DropdownMenuItem @select="router.push({ name: 'SettingsJson', query: { key: def.key } })">
            Edit in settings.json
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
