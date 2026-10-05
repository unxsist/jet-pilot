<script setup lang="ts">
/**
 * One preference: label, description and its control; a dot marks values
 * that differ from the default, with a reset button and a menu (reset, copy
 * the setting id, edit it in settings.json).
 */
import { useRouter } from "vue-router";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { MoreHorizontal, RotateCcw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SettingControl from "@/components/settings/SettingControl.vue";
import { settingsRow } from "@/components/settings/styles";
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
  /** Show the category › section path (search results). */
  context?: string;
}>();

const { settings } = injectStrict(SettingsContextStateKey);
const router = useRouter();
const { toast } = useToast();

const id = computed(() => settingAnchor(props.def.key));
const value = computed(() => getPath(settings.value, props.def.key));
const modified = computed(() => isModified(settings.value, props.def));
const defaultText = computed(() => formatSettingValue(props.def, props.def.default));

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
        'group/setting scroll-mt-24',
        highlighted && 'animate-pulse-highlight-once'
      )
    "
  >
    <div class="min-w-0 space-y-1">
      <p v-if="context" class="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {{ context }}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <span
          v-if="modified"
          class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
          :title="`Modified · default: ${defaultText}`"
          aria-hidden="true"
        />
        <label :for="id + '-control'" class="text-sm font-medium leading-none">
          {{ def.label }}
        </label>
        <span v-if="modified" class="sr-only">(modified)</span>
        <Badge v-if="def.appliesTo" variant="muted" size="sm">{{ def.appliesTo }}</Badge>
      </div>
      <p v-if="def.description" class="text-xs text-muted-foreground">
        {{ def.description }}
      </p>
    </div>
    <div class="flex min-w-0 items-center gap-1 sm:justify-end">
      <div class="flex min-w-0 flex-1 sm:flex-none sm:justify-end" :class="def.type === 'string' || def.type === 'string[]' ? 'sm:flex-1' : ''">
        <SettingControl
          :id="id + '-control'"
          :def="def"
          :model-value="value"
          @update:model-value="update"
        />
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        class="shrink-0 text-muted-foreground"
        :class="modified ? 'opacity-0 group-hover/setting:opacity-100 focus-visible:opacity-100' : 'invisible'"
        :title="`Reset to default (${defaultText})`"
        :aria-label="`Reset ${def.label} to its default`"
        :tabindex="modified ? 0 : -1"
        @click="reset"
      >
        <RotateCcw class="h-3.5 w-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0 text-muted-foreground opacity-0 group-hover/setting:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            :aria-label="`More actions for ${def.label}`"
          >
            <MoreHorizontal class="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-52">
          <DropdownMenuItem :disabled="!modified" @select="reset">
            Reset to default
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
