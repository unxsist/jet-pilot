<script setup lang="ts">
/**
 * Side panel sections of a RoleBinding or ClusterRoleBinding: in one
 * sentence what it grants to whom and where, its subjects (each leads to
 * what it may do), and the rules of the role it grants.
 */
import { ListChecks, TriangleAlert, Users } from "lucide-vue-next";
import PanelSection from "@/components/generic/PanelSection.vue";
import RulesTable from "./RulesTable.vue";
import ObjectLink from "./ObjectLink.vue";
import SubjectIcon from "./SubjectIcon.vue";
import { useRbacLinks } from "./useRbacLinks";
import { useRbacData } from "@/lib/accessReview";
import { bindingScope, indexRbac, normalizeSubject, subjectDescription, type BindingObject } from "@/lib/rbac";

const props = defineProps<{ resource: BindingObject }>();
const { openObject, openSubject } = useRbacLinks();

const target = computed(() =>
  props.resource.metadata.context
    ? { context: props.resource.metadata.context, kubeConfig: props.resource.metadata.kubeConfig ?? "" }
    : null
);
const { data } = useRbacData(target);
const index = computed(() => (data.value ? indexRbac(data.value.snapshot) : null));
const roleKindUnknown = computed(() =>
  (data.value?.unavailable ?? []).some((u) => u.kind === props.resource.roleRef.kind)
);
const role = computed(() => (index.value && !roleKindUnknown.value ? index.value.roleOf(props.resource) : null));
const missing = computed(() => !!index.value && !roleKindUnknown.value && !role.value);

const scope = computed(() => bindingScope(props.resource));
const subjects = computed(() => (props.resource.subjects ?? []).map((s) => normalizeSubject(s, props.resource)));
</script>

<template>
  <PanelSection value="subjects" title="Grants" :icon="Users" :count="subjects.length">
    <div class="space-y-3">
      <div class="space-y-1">
        <p class="text-sm leading-6 text-muted-foreground">
          Grants
          <ObjectLink
            :kind="resource.roleRef.kind"
            :name="resource.roleRef.name"
            :object="role"
            :missing="missing"
            @open="role && openObject(role)"
          />
          to {{ subjects.length === 1 ? "one subject" : `${subjects.length} subjects` }}, {{ scope === null ? "everywhere" : `only in ${scope}` }}.
        </p>
        <p v-if="scope !== null && resource.roleRef.kind === 'ClusterRole'" class="text-xs text-muted-foreground">
          A ClusterRole granted by a RoleBinding only applies in the binding's namespace.
        </p>
      </div>
      <p v-if="missing" class="flex items-start gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-xs text-foreground">
        <TriangleAlert class="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
        <span>
          {{ resource.roleRef.kind }} {{ resource.roleRef.name }} doesn't exist, so this binding grants nothing until
          someone creates it.
        </span>
      </p>
      <ul class="space-y-1.5">
        <li v-for="subject in subjects" :key="`${subject.kind}/${subject.namespace}/${subject.name}`">
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2.5 rounded-md text-left transition-colors duration-fast hover:text-link focus-ring"
            :title="`What can ${subject.name} do?`"
            @click="openSubject(subject, resource.metadata.context)"
          >
            <SubjectIcon :kind="subject.kind" size="sm" />
            <span class="min-w-0">
              <span class="block truncate text-sm">{{ subject.name }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{ subjectDescription(subject) }}</span>
            </span>
          </button>
        </li>
        <li v-if="!subjects.length" class="text-sm text-muted-foreground">No subjects: it grants nothing to anyone.</li>
      </ul>
    </div>
  </PanelSection>

  <PanelSection v-if="role" value="rules" :title="`Rules of ${role.metadata.name}`" :icon="ListChecks" :count="role.rules?.length ?? 0">
    <RulesTable :rules="role.rules ?? []" />
  </PanelSection>
</template>
