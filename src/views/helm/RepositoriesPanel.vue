<script setup lang="ts">
import { Loader2, Plus, RefreshCw, Trash2, TriangleAlert, Warehouse } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { injectStrict } from "@/lib/utils";
import { confirmDialog } from "@/lib/guardrails/guard";
import { DialogProviderSpawnDialogKey } from "@/providers/DialogProvider";
import { addRepo, removeRepo, updateRepos } from "@/lib/helmApi";
import { repoNameProblem, repoUrlProblem } from "@/lib/helm";
import { useHelmRepos } from "./repos";

/*
 * Helm repositories: where `helm search` and installs find charts. Add one
 * by name and URL (validated here, then by helm fetching its index),
 * refresh indexes, remove. These change your local Helm configuration,
 * not a cluster.
 */
const spawnDialog = injectStrict(DialogProviderSpawnDialogKey);
const { repos, loaded, error, reload } = useHelmRepos();

const adding = ref(false);
const name = ref("");
const url = ref("");
const touched = reactive({ name: false, url: false });
const addError = ref("");
const saving = ref(false);
const updating = ref<string | null>(null);

const nameProblem = computed(() => repoNameProblem(name.value, repos.value));
const urlProblem = computed(() => repoUrlProblem(url.value, repos.value));

/* A bare host gets its scheme: helm needs one. */
const completeUrl = () => {
  touched.url = true;
  const value = url.value.trim();
  if (value && !/^[a-z]+:\/\//i.test(value) && /^[\w-]+(\.[\w-]+)+/.test(value)) {
    url.value = `https://${value}`;
  }
};

const startAdding = () => {
  adding.value = true;
  addError.value = "";
  nextTick(() => document.getElementById("helm-repo-name")?.focus());
};

const cancel = () => {
  adding.value = false;
  name.value = "";
  url.value = "";
  touched.name = touched.url = false;
  addError.value = "";
};

const submit = async () => {
  touched.name = true;
  completeUrl();
  if (nameProblem.value || urlProblem.value) return;
  saving.value = true;
  addError.value = "";
  try {
    await addRepo(name.value, url.value);
    await reload();
    toast({ title: `Added ${name.value.trim()}`, variant: "success", autoDismiss: true });
    cancel();
  } catch (e) {
    addError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
};

const update = async (repo?: string) => {
  updating.value = repo ?? "*";
  try {
    await updateRepos(repo ? [repo] : []);
    toast({
      title: repo ? `Updated ${repo}` : "Updated every repository",
      description: "Searches now include their newest charts.",
      autoDismiss: true,
    });
  } catch (e) {
    toast({
      title: repo ? `Couldn't update ${repo}` : "Couldn't update the repositories",
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });
  } finally {
    updating.value = null;
  }
};

const remove = async (repo: string) => {
  const confirmed = await confirmDialog(spawnDialog, {
    title: `Remove ${repo}?`,
    message:
      "Helm stops finding its charts. Releases installed from it keep running; upgrading them needs the repository again.",
    confirmLabel: "Remove",
    variant: "destructive",
  });
  if (!confirmed) return;
  try {
    await removeRepo(repo);
    await reload();
  } catch (e) {
    toast({
      title: `Couldn't remove ${repo}`,
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });
  }
};

defineExpose({ startAdding });
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <p class="mr-auto text-sm text-muted-foreground">
        <template v-if="repos.length">
          {{ repos.length }} {{ repos.length === 1 ? "repository" : "repositories" }} on this computer
        </template>
      </p>
      <Button
        v-if="repos.length"
        variant="ghost"
        size="sm"
        class="text-muted-foreground"
        :disabled="!!updating"
        @click="update()"
      >
        <Loader2 v-if="updating === '*'" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        Update all
      </Button>
      <Button v-if="!adding && (repos.length || !loaded)" size="sm" @click="startAdding">
        <Plus class="h-3.5 w-3.5" /> Add repository
      </Button>
    </div>

    <!-- Add a repository -->
    <form
      v-if="adding"
      class="space-y-3 rounded-xl border bg-card p-4 shadow-xs"
      @submit.prevent="submit"
      @keydown.esc="cancel"
    >
      <div class="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div class="grid gap-1.5">
          <Label for="helm-repo-name">Name</Label>
          <Input
            id="helm-repo-name"
            v-model="name"
            placeholder="bitnami"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="touched.name && !!nameProblem"
            @blur="touched.name = true"
          />
        </div>
        <div class="grid gap-1.5">
          <Label for="helm-repo-url">URL</Label>
          <Input
            id="helm-repo-url"
            v-model="url"
            placeholder="https://charts.bitnami.com/bitnami"
            autocomplete="off"
            spellcheck="false"
            class="font-mono text-xs"
            :aria-invalid="touched.url && !!urlProblem"
            @blur="completeUrl"
          />
        </div>
      </div>
      <p
        v-if="(touched.name && nameProblem) || (touched.url && urlProblem)"
        class="text-xs text-destructive"
        role="alert"
      >
        {{ (touched.name && nameProblem) || urlProblem }}
      </p>
      <p
        v-if="addError"
        class="flex items-start gap-1.5 break-words rounded-md bg-destructive/5 px-2.5 py-2 text-xs text-destructive select-text"
        role="alert"
      >
        <TriangleAlert class="mt-px h-3.5 w-3.5 shrink-0" />{{ addError }}
      </p>
      <div class="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" @click="cancel">Cancel</Button>
        <Button type="submit" size="sm" :disabled="saving">
          <Loader2 v-if="saving" class="h-3.5 w-3.5 animate-spin" />
          {{ saving ? "Checking…" : "Add" }}
        </Button>
      </div>
    </form>

    <div v-if="!loaded" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-12 w-full rounded-xl" />
    </div>

    <EmptyState
      v-else-if="error"
      :icon="TriangleAlert"
      title="Can't list your repositories"
      size="sm"
    >
      <span class="block break-words font-mono text-xs select-text">{{ error }}</span>
      <template #action>
        <Button variant="outline" size="sm" @click="reload()">Retry</Button>
      </template>
    </EmptyState>

    <EmptyState
      v-else-if="!repos.length && !adding"
      :icon="Warehouse"
      title="No repositories yet"
      description="Repositories are where Helm finds charts. Add one by its URL, or install a chart from Artifact Hub and JET Pilot adds its repository for you."
    >
      <template #action>
        <Button size="sm" @click="startAdding"><Plus class="h-3.5 w-3.5" /> Add repository</Button>
      </template>
    </EmptyState>

    <ul v-else class="space-y-px" aria-label="Repositories">
      <li
        v-for="repo in repos"
        :key="repo.name"
        class="group/row flex items-center gap-3.5 rounded-xl px-3 py-2.5 transition-colors duration-fast hover:bg-accent"
      >
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-surface-1 text-muted-foreground">
          <Warehouse class="h-4 w-4" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">{{ repo.name }}</span>
          <span class="block truncate font-mono text-xs text-muted-foreground select-text">{{ repo.url }}</span>
        </span>
        <span
          class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-focus-within/row:opacity-100 group-hover/row:opacity-100"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            :aria-label="`Update ${repo.name}`"
            :title="`Update ${repo.name}`"
            :disabled="!!updating"
            @click="update(repo.name)"
          >
            <Loader2 v-if="updating === repo.name" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-destructive"
            :aria-label="`Remove ${repo.name}`"
            :title="`Remove ${repo.name}`"
            @click="remove(repo.name)"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </Button>
        </span>
      </li>
    </ul>
  </div>
</template>
