<script setup lang="ts">
/*
 * IAM roles an AWS account assumes on top of its credentials (role
 * chaining): team roles, often in other accounts, whose clusters are found
 * too. Each is checked when added. IAM Identity Center assumes them as one
 * of its account + role pairs (`sources`); profiles and access keys with
 * their own credentials (no sources).
 */
import { CircleAlert, Loader2, Plus, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WIZARD_ERROR, WIZARD_GROUP_LABEL, WIZARD_LIST, WIZARD_ROW } from "@/components/wizard/wizard";
import { errorMessage } from "@/lib/clusters/managed";
import { parseRoleArn } from "@/lib/clusters/cloudModel";

export interface TeamRole {
  arn: string;
  accountId: string;
  roleName: string;
  /** What it's assumed as: a source key ("<accountId>:<roleName>"), "" for the account's own credentials. */
  via: string;
}

const props = defineProps<{
  description: string;
  /** The account + role pairs to assume from (IAM Identity Center); none: the credentials themselves. */
  sources?: { key: string; label: string }[];
  /** The source preselected for a new role. */
  defaultSource?: () => string;
  /** Role ARNs to offer (from ~/.aws/config). */
  suggested: string[];
  /** The second line of a role: its account, and what it's assumed as. */
  detail: (role: TeamRole) => string;
  /** Throws when the role can't be assumed (as `via`). */
  check: (arn: string, via: string) => Promise<void>;
}>();
const roles = defineModel<TeamRole[]>({ required: true });
const checking = defineModel<boolean>("checking", { default: false });

const draft = reactive({ open: false, arn: "", via: "", error: null as string | null });
const withSources = computed(() => !!props.sources);
const offered = computed(() => props.suggested.filter((arn) => !roles.value.some((r) => r.arn === arn)).slice(0, 3));

const open = () => {
  Object.assign(draft, { open: true, arn: "", via: props.defaultSource?.() ?? "", error: null });
  nextTick(() => document.getElementById("aws-team-role")?.focus());
};

const add = async () => {
  const role = parseRoleArn(draft.arn);
  if (!role) {
    draft.error = "Enter a role ARN, e.g. arn:aws:iam::123456789012:role/Platform";
    return;
  }
  if (roles.value.some((r) => r.arn === role.arn)) {
    draft.error = "This role is already in the list.";
    return;
  }
  checking.value = true;
  draft.error = null;
  try {
    await props.check(role.arn, draft.via);
    roles.value = [...roles.value, { ...role, via: draft.via }];
    draft.open = false;
  } catch (e) {
    draft.error = errorMessage(e);
    nextTick(() => document.getElementById("aws-team-role-error")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  } finally {
    checking.value = false;
  }
};

const remove = (arn: string) => (roles.value = roles.value.filter((r) => r.arn !== arn));
</script>

<template>
  <div class="mt-6 space-y-1">
    <p :class="WIZARD_GROUP_LABEL">Team roles</p>
    <p class="text-xs text-muted-foreground">{{ description }}</p>
  </div>
  <div v-if="roles.length" :class="[WIZARD_LIST, 'mt-2']">
    <div v-for="role in roles" :key="role.arn" :class="[WIZARD_ROW, 'group']">
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium" :title="role.arn">{{ role.roleName }}</span>
        <span class="block truncate text-xs text-muted-foreground">{{ detail(role) }}</span>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground opacity-0 transition-opacity duration-fast hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        :aria-label="`Remove ${role.roleName}`"
        @click="remove(role.arn)"
      >
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>
  </div>
  <form
    v-if="draft.open"
    class="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3"
    @submit.prevent="add"
  >
    <label for="aws-team-role" class="pt-1.5 text-sm text-muted-foreground">Role ARN</label>
    <div class="space-y-2">
      <Input
        id="aws-team-role"
        v-model="draft.arn"
        class="font-mono text-xs"
        placeholder="arn:aws:iam::123456789012:role/Platform"
        spellcheck="false"
        autocomplete="off"
      />
      <div v-if="offered.length" class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-muted-foreground">From ~/.aws/config</span>
        <button
          v-for="arn in offered"
          :key="arn"
          type="button"
          class="rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors duration-fast focus-ring"
          :class="arn === draft.arn.trim() ? 'bg-primary/10 text-link' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'"
          :title="arn"
          @click="draft.arn = arn"
        >
          {{ parseRoleArn(arn)?.roleName }}
        </button>
      </div>
    </div>
    <template v-if="sources">
      <label for="aws-team-role-via" class="pt-1.5 text-sm text-muted-foreground">Assume as</label>
      <div class="space-y-1.5">
        <Select v-model="draft.via">
          <SelectTrigger id="aws-team-role-via" class="w-72 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="source in sources" :key="source.key" :value="source.key" class="text-xs">
              {{ source.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">The account and role you sign in as.</p>
      </div>
    </template>
    <p v-if="draft.error" id="aws-team-role-error" :class="[WIZARD_ERROR, 'col-span-2']" role="alert">
      <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" /> {{ draft.error }}
    </p>
    <div class="col-span-2 flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" @click="draft.open = false">Cancel</Button>
      <Button type="submit" size="sm" :disabled="!draft.arn.trim() || (withSources && !draft.via) || checking">
        <Loader2 v-if="checking" class="h-3.5 w-3.5 animate-spin" />
        {{ checking ? "Checking…" : "Add role" }}
      </Button>
    </div>
  </form>
  <Button
    v-else-if="!sources || sources.length"
    variant="ghost"
    size="sm"
    class="-ml-2.5 mt-2 text-muted-foreground"
    @click="open"
  >
    <Plus class="h-3.5 w-3.5" /> Assume a team role
  </Button>
</template>
