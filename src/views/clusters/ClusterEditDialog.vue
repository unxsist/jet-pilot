<script setup lang="ts">
/**
 * Edit what JET Pilot knows about one cluster, or several at once (bulk:
 * only the fields you touch are applied; mixed values start empty).
 */
import { Check, Lock, ShieldAlert } from "lucide-vue-next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import ClusterLabel from "@/components/clusters/ClusterLabel.vue";
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
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[90vh] max-w-xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ single ? "Cluster details" : `Edit ${clusters.length} clusters` }}</DialogTitle>
        <DialogDescription>
          <template v-if="single">
            Only stored in JET Pilot; your kubeconfig isn't changed.
          </template>
          <template v-else>Only the fields you change are applied to every selected cluster.</template>
        </DialogDescription>
      </DialogHeader>

      <div v-if="single" class="flex items-center gap-3 rounded-lg border bg-surface-1 px-3 py-2.5">
        <ClusterLabel :context="single.entry.context" :kube-config="single.entry.kubeConfig" size="default" />
        <span class="ml-auto truncate font-mono text-2xs text-muted-foreground" :title="single.entry.kubeConfig">
          {{ single.entry.kubeConfig }}
        </span>
      </div>

      <div class="space-y-5 py-1">
        <div v-if="single" class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
          <label for="cluster-alias" class="text-sm font-medium">Name</label>
          <Input
            id="cluster-alias"
            v-model="form.alias"
            :placeholder="single.entry.context"
            spellcheck="false"
            @update:model-value="touched.add('alias')"
          />
        </div>

        <div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
          <span class="text-sm font-medium">Colour</span>
          <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Colour">
            <button
              type="button"
              role="radio"
              :aria-checked="form.color === ''"
              class="flex h-6 items-center rounded-full border px-2 text-2xs text-muted-foreground focus-ring"
              :class="form.color === '' ? 'border-primary text-foreground' : ''"
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
              class="flex h-6 w-6 items-center justify-center rounded-full ring-offset-2 ring-offset-popover focus-ring"
              :class="form.color === color ? 'ring-2 ring-primary' : ''"
              :style="{ background: swatch(color) }"
              @click="set('color', color)"
            >
              <Check v-if="form.color === color" class="h-3.5 w-3.5 text-white" />
            </button>
          </div>
        </div>

        <div class="grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-3">
          <span class="pt-1.5 text-sm font-medium">Environment</span>
          <div class="space-y-1.5">
            <Tabs :model-value="form.env || 'none'" @update:model-value="(v) => chooseEnv(v === 'none' ? '' : String(v))">
              <TabsList aria-label="Environment">
                <TabsTrigger value="none" class="px-2.5">None</TabsTrigger>
                <TabsTrigger v-for="env in ENVIRONMENTS" :key="env.value" :value="env.value" class="px-2.5">
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

        <div class="space-y-3 rounded-lg border p-3">
          <label class="flex items-start gap-3">
            <ShieldAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span class="flex-1 space-y-0.5">
              <span class="block text-sm font-medium">Protected</span>
              <span class="block text-xs text-muted-foreground">
                Destructive actions need you to type the resource name, and YAML is always checked with a
                server dry run before it's applied. On by default for production.
              </span>
            </span>
            <Switch :checked="form.protected" @update:checked="(v: boolean) => set('protected', v)" />
          </label>
          <label class="flex items-start gap-3">
            <Lock class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span class="flex-1 space-y-0.5">
              <span class="block text-sm font-medium">Read-only</span>
              <span class="block text-xs text-muted-foreground">
                JET Pilot hides and blocks every change: browse, read logs, port-forward and open shells only.
              </span>
            </span>
            <Switch :checked="form.readOnly" @update:checked="(v: boolean) => set('readOnly', v)" />
          </label>
        </div>

        <div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
          <label for="cluster-folder" class="text-sm font-medium">Folder</label>
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
        </div>

        <div class="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
          <span class="text-sm font-medium">Tags</span>
          <TagsInput :model-value="form.tags" @update:model-value="(v: unknown[]) => set('tags', v.map(String))">
            <TagsInputItem v-for="tag in form.tags" :key="tag" :value="tag">
              <TagsInputItemText />
              <TagsInputItemDelete />
            </TagsInputItem>
            <TagsInputInput placeholder="Add a tag…" />
          </TagsInput>
        </div>

        <div class="grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-3">
          <span class="pt-1.5 text-sm font-medium">Namespaces</span>
          <div class="space-y-1.5">
            <TagsInput
              :model-value="form.namespaces"
              @update:model-value="(v: unknown[]) => set('namespaces', v.map(String))"
            >
              <TagsInputItem v-for="namespace in form.namespaces" :key="namespace" :value="namespace">
                <TagsInputItemText />
                <TagsInputItemDelete />
              </TagsInputItem>
              <TagsInputInput placeholder="Add a namespace…" />
            </TagsInput>
            <p class="text-xs text-muted-foreground">
              Offered in the context switcher when you aren't allowed to list namespaces.
            </p>
          </div>
        </div>

        <div class="flex items-center gap-6">
          <label class="flex items-center gap-2 text-sm">
            <Switch :checked="form.favorite" @update:checked="(v: boolean) => set('favorite', v)" />
            Favourite
          </label>
          <label class="flex items-center gap-2 text-sm">
            <Switch :checked="form.hidden" @update:checked="(v: boolean) => set('hidden', v)" />
            Hidden from lists
          </label>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="open = false">Cancel</Button>
        <Button @click="save">Save</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
