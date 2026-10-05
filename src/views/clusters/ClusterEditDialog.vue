<script setup lang="ts">
/**
 * Edit what JET Pilot knows about one cluster, or several at once (bulk:
 * only the fields you touch are applied; mixed values start empty). Three
 * calm groups: how it looks, its guardrails, how it's organised.
 */
import { Layers, Lock, ShieldAlert } from "lucide-vue-next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputItemDelete,
  TagsInputItemText,
} from "@/components/ui/tags-input";
import ContextAvatar from "@/components/ContextAvatar.vue";
import WizardHeader from "@/components/wizard/WizardHeader.vue";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import { WIZARD_BODY, WIZARD_DIALOG } from "@/components/wizard/wizard";
import { useClusters } from "@/lib/clusters/useClusters";
import {
  CLUSTER_COLORS,
  ENVIRONMENTS,
  envInfo,
  type ClusterColor,
  type ClusterMeta,
  type Environment,
} from "@/lib/clusters/meta";
import type { HubCluster } from "@/lib/clusters/hubModel";

const props = defineProps<{ clusters: HubCluster[]; folders: string[] }>();
const open = defineModel<boolean>("open", { required: true });

const { update, updateMany } = useClusters();

const single = computed(() => (props.clusters.length === 1 ? props.clusters[0]! : null));

/* The value shared by every selected cluster, else undefined ("mixed"). */
const shared = <T,>(pick: (c: HubCluster) => T): T | undefined => {
  const values = props.clusters.map(pick);
  return values.every((v) => JSON.stringify(v) === JSON.stringify(values[0])) ? values[0] : undefined;
};

interface Form {
  alias: string;
  color: ClusterColor | "";
  env: Environment | "";
  protected: boolean;
  readOnly: boolean;
  folder: string;
  tags: string[];
  namespaces: string[];
  favorite: boolean;
  hidden: boolean;
}

const form = reactive<Form>({
  alias: "",
  color: "",
  env: "",
  protected: false,
  readOnly: false,
  folder: "",
  tags: [],
  namespaces: [],
  favorite: false,
  hidden: false,
});
/* Fields changed in this session (bulk edits apply only these). */
const touched = reactive(new Set<keyof Form>());
const set = <K extends keyof Form>(key: K, value: Form[K]) => {
  form[key] = value;
  touched.add(key);
};

watch(
  () => [open.value, props.clusters] as const,
  ([isOpen]) => {
    if (!isOpen) return;
    touched.clear();
    const record = (c: HubCluster) => c.meta;
    form.alias = single.value ? (single.value.meta.displayName === single.value.entry.context ? "" : single.value.meta.displayName) : "";
    form.color = shared((c) => record(c).color ?? "") ?? "";
    form.env = shared((c) => (record(c).envInferred ? "" : (record(c).env ?? ""))) ?? "";
    form.protected = shared((c) => record(c).protected) ?? false;
    form.readOnly = shared((c) => record(c).readOnly) ?? false;
    form.folder = shared((c) => record(c).folder ?? "") ?? "";
    form.tags = [...(shared((c) => record(c).tags) ?? [])];
    form.namespaces = [...(shared((c) => record(c).namespaces) ?? [])];
    form.favorite = shared((c) => record(c).favorite) ?? false;
    form.hidden = shared((c) => record(c).hidden) ?? false;
  },
  { immediate: true }
);

/* Choosing Production turns protection on (unless set by hand). */
const chooseEnv = (value: string) => {
  set("env", value as Environment | "");
  if (!touched.has("protected")) form.protected = value === "prod";
};

const inferred = computed(() =>
  single.value && single.value.meta.envInferred ? envInfo(single.value.meta.env) : undefined
);

const save = () => {
  const patch: Partial<ClusterMeta> = {};
  const apply = (key: keyof Form, value: unknown) => {
    if (single.value || touched.has(key)) (patch as Record<string, unknown>)[key] = value;
  };
  if (single.value) patch.alias = form.alias.trim() || undefined;
  apply("color", form.color || undefined);
  apply("env", form.env || undefined);
  // Protection follows the environment unless it differs from that default.
  if (single.value || touched.has("protected") || touched.has("env")) {
    patch.protected = form.protected === (form.env === "prod") ? undefined : form.protected;
  }
  apply("readOnly", form.readOnly || undefined);
  apply("folder", form.folder.trim() || undefined);
  apply("tags", form.tags.length ? [...form.tags] : undefined);
  apply("namespaces", form.namespaces.length ? [...form.namespaces] : undefined);
  apply("favorite", form.favorite || undefined);
  apply("hidden", form.hidden || undefined);

  if (single.value) update(single.value.entry.context, single.value.entry.kubeConfig, patch);
  else updateMany(props.clusters.map((c) => ({ context: c.entry.context, kubeConfig: c.entry.kubeConfig })), patch);
  open.value = false;
};

const COLORS = Object.keys(CLUSTER_COLORS) as ClusterColor[];
const swatch = (color: ClusterColor) =>
  color === "gray" ? "hsl(220 8% 55%)" : `hsl(${CLUSTER_COLORS[color]} 70% 52%)`;
/* The chosen swatch gets a ring in its own colour, with a gap. */
const swatchStyle = (color: ClusterColor) => ({
  background: swatch(color),
  boxShadow: form.color === color ? `0 0 0 2px hsl(var(--popover)), 0 0 0 4px ${swatch(color)}` : undefined,
});

const where = computed(() =>
  single.value
    ? [single.value.entry.context, single.value.entry.origin === "managed" ? "added in JET Pilot" : single.value.entry.kubeConfig.replace(/^\/(home|Users)\/[^/]+/, "~")].join(" · ")
    : ""
);
const LABEL = "text-sm text-muted-foreground";
const SECTION = "space-y-4 border-t pt-5";
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="WIZARD_DIALOG">
      <WizardHeader
        :title="single ? single.meta.displayName : `Edit ${clusters.length} clusters`"
        :tone="single ? 'bare' : 'default'"
      >
        <template #icon>
          <ContextAvatar v-if="single" :name="single.entry.context" :kube-config="single.entry.kubeConfig" size="lg" />
          <Layers v-else class="h-[18px] w-[18px]" />
        </template>
        <template #description>
          <span v-if="single" class="block truncate font-mono text-xs" :title="single.entry.kubeConfig">{{ where }}</span>
          <template v-else>Only the fields you change are applied to every selected cluster.</template>
        </template>
      </WizardHeader>

      <div :class="[WIZARD_BODY, 'space-y-5']">
        <!-- How it looks -->
        <div class="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-4 gap-y-4">
          <template v-if="single">
            <label for="cluster-alias" :class="LABEL">Name</label>
            <Input
              id="cluster-alias"
              v-model="form.alias"
              :placeholder="single.entry.context"
              spellcheck="false"
              @update:model-value="touched.add('alias')"
            />
          </template>

          <span :class="LABEL">Colour</span>
          <div class="flex flex-wrap items-center gap-2.5" role="radiogroup" aria-label="Colour">
            <button
              type="button"
              role="radio"
              :aria-checked="form.color === ''"
              class="flex h-6 items-center rounded-full px-2.5 text-xs transition-colors duration-fast focus-ring"
              :class="form.color === '' ? 'bg-accent text-foreground ring-1 ring-inset ring-border-strong' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'"
              @click="set('color', '')"
            >
              Auto
            </button>
            <button
              v-for="color in COLORS"
              :key="color"
              type="button"
              role="radio"
              :aria-checked="form.color === color"
              :aria-label="color"
              :title="color"
              class="h-5 w-5 rounded-full transition-transform duration-fast hover:scale-110 focus-ring"
              :style="swatchStyle(color)"
              @click="set('color', color)"
            />
          </div>

          <span :class="[LABEL, 'self-start pt-1.5']">Environment</span>
          <div class="space-y-1.5">
            <Tabs :model-value="form.env || 'none'" @update:model-value="(v) => chooseEnv(v === 'none' ? '' : String(v))">
              <TabsList aria-label="Environment">
                <TabsTrigger value="none">None</TabsTrigger>
                <TabsTrigger v-for="env in ENVIRONMENTS" :key="env.value" :value="env.value">
                  {{ env.label }}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <p v-if="inferred && !form.env" class="text-xs text-muted-foreground">
              The name suggests {{ inferred.label.toLowerCase() }}.
              <button type="button" class="text-link hover:underline" @click="chooseEnv(inferred.value)">
                Mark as {{ inferred.label.toLowerCase() }}
              </button>
            </p>
          </div>
        </div>

        <!-- Guardrails -->
        <section :class="SECTION">
          <h3 class="text-xs font-medium text-muted-foreground">Guardrails</h3>
          <label class="flex cursor-pointer items-start gap-3">
            <ShieldAlert
              class="mt-0.5 h-4 w-4 shrink-0 transition-colors duration-fast"
              :class="form.protected ? 'text-destructive' : 'text-muted-foreground'"
            />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium">Protected</span>
              <span class="block text-xs text-muted-foreground">
                Deleting asks you to type the name; YAML gets a server dry run first. On for production.
              </span>
            </span>
            <Switch :checked="form.protected" @update:checked="(v: boolean) => set('protected', v)" />
          </label>
          <label class="flex cursor-pointer items-start gap-3">
            <Lock
              class="mt-0.5 h-4 w-4 shrink-0 transition-colors duration-fast"
              :class="form.readOnly ? 'text-warning' : 'text-muted-foreground'"
            />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium">Read-only</span>
              <span class="block text-xs text-muted-foreground">
                Browse, read logs, port-forward and open shells. Every change is blocked.
              </span>
            </span>
            <Switch :checked="form.readOnly" @update:checked="(v: boolean) => set('readOnly', v)" />
          </label>
        </section>

        <!-- Organise -->
        <section :class="SECTION">
          <h3 class="text-xs font-medium text-muted-foreground">Organise</h3>
          <div class="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-4 gap-y-4">
            <label for="cluster-folder" :class="LABEL">Folder</label>
            <div>
              <Input
                id="cluster-folder"
                :model-value="form.folder"
                list="cluster-folders"
                placeholder="e.g. Payments team"
                @update:model-value="(v) => set('folder', String(v))"
              />
              <datalist id="cluster-folders">
                <option v-for="folder in folders" :key="folder" :value="folder" />
              </datalist>
            </div>

            <span :class="LABEL">Tags</span>
            <TagsInput :model-value="form.tags" @update:model-value="(v: unknown[]) => set('tags', v.map(String))">
              <TagsInputItem v-for="tag in form.tags" :key="tag" :value="tag">
                <TagsInputItemText />
                <TagsInputItemDelete />
              </TagsInputItem>
              <TagsInputInput placeholder="Add a tag…" />
            </TagsInput>

            <span :class="[LABEL, 'self-start pt-1.5']">Namespaces</span>
            <div class="space-y-1.5">
              <TagsInput :model-value="form.namespaces" @update:model-value="(v: unknown[]) => set('namespaces', v.map(String))">
                <TagsInputItem v-for="namespace in form.namespaces" :key="namespace" :value="namespace">
                  <TagsInputItemText />
                  <TagsInputItemDelete />
                </TagsInputItem>
                <TagsInputInput placeholder="Add a namespace…" />
              </TagsInput>
              <p class="text-xs text-muted-foreground">Offered in the context switcher when you can't list namespaces.</p>
            </div>

            <span />
            <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
              <label class="flex cursor-pointer items-center gap-2 text-sm">
                <Switch :checked="form.favorite" @update:checked="(v: boolean) => set('favorite', v)" />
                Favourite
              </label>
              <label class="flex cursor-pointer items-center gap-2 text-sm">
                <Switch :checked="form.hidden" @update:checked="(v: boolean) => set('hidden', v)" />
                Hidden from lists
              </label>
            </div>
          </div>
        </section>
      </div>

      <WizardFooter>
        <template #start>
          <p class="truncate text-xs text-muted-foreground">Saved in JET Pilot; your kubeconfig isn't changed.</p>
        </template>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button @click="save">Save</Button>
      </WizardFooter>
    </DialogContent>
  </Dialog>
</template>
