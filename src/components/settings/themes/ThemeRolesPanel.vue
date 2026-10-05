<script setup lang="ts">
/*
 * The theme editor's role list: every T3 + JET role with the colour it
 * resolves to in the draft (set in the file, or derived), and where JET
 * Pilot paints it. Clicking a role jumps to its key, or adds it with the
 * resolved colour.
 */
import { Search } from "lucide-vue-next";
import { JET_ROLE_DESCRIPTIONS, ROLE_DESCRIPTIONS } from "@/lib/themes/schema";
import { JET_COLOR_ROLES, THEME_COLOR_ROLES } from "@/lib/themes/types";

const props = defineProps<{
  /** Resolved roles of the draft (#rrggbb); null while resolving / invalid. */
  roles: Record<string, string> | null;
  /** Roles the file sets for the shown appearance. */
  explicit: ReadonlySet<string>;
  readonly?: boolean;
}>();

const emit = defineEmits<{ (e: "pick", role: string): void }>();

const filter = ref("");
const ALL = [
  ...THEME_COLOR_ROLES.map((role) => ({ role, description: ROLE_DESCRIPTIONS[role], jet: false })),
  ...JET_COLOR_ROLES.map((role) => ({ role, description: JET_ROLE_DESCRIPTIONS[role], jet: true })),
];
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = q
    ? ALL.filter(({ role, description }) => `${role} ${description}`.toLowerCase().includes(q))
    : ALL;
  // The roles the file sets first, then the rest in T3's order.
  return [...list].sort(
    (a, b) => Number(props.explicit.has(b.role)) - Number(props.explicit.has(a.role))
  );
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="space-y-2 border-b px-3 py-3">
      <div class="flex items-baseline justify-between">
        <h2 class="text-sm font-semibold text-foreground">Roles</h2>
        <span class="text-xs tabular-nums text-muted-foreground">{{ explicit.size }} set · {{ ALL.length - explicit.size }} derived</span>
      </div>
      <p class="text-xs text-muted-foreground">
        Only <span class="font-mono">canvas</span> and <span class="font-mono">accent</span> are
        needed: every other role is derived from them. {{ readonly ? "" : "Click a role to add or jump to it." }}
      </p>
      <div class="relative">
        <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          v-model="filter"
          type="search"
          placeholder="Filter roles"
          aria-label="Filter roles"
          class="h-7 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none"
        />
      </div>
    </div>
    <ul class="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="Theme roles">
      <li v-for="item in shown" :key="item.role">
        <button
          type="button"
          class="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-ring disabled:hover:bg-transparent"
          :title="item.description"
          :disabled="readonly && !explicit.has(item.role)"
          @click="emit('pick', item.role)"
        >
          <span
            class="mt-0.5 h-4 w-4 shrink-0 rounded-[4px] border border-foreground/15"
            :class="roles ? '' : 'bg-muted'"
            :style="roles ? { backgroundColor: roles[item.role] } : undefined"
          ></span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="truncate font-mono text-xs text-foreground">{{ item.role }}</span>
              <span
                v-if="explicit.has(item.role)"
                class="rounded-sm bg-primary/10 px-1 text-2xs font-medium text-link"
              >set</span>
              <span v-if="item.jet" class="text-2xs text-muted-foreground">jetPilot</span>
              <span class="ml-auto shrink-0 font-mono text-2xs uppercase tabular-nums text-muted-foreground">
                {{ roles?.[item.role] ?? "" }}
              </span>
            </span>
            <span class="line-clamp-2 text-2xs leading-4 text-muted-foreground">{{ item.description }}</span>
          </span>
        </button>
      </li>
      <li v-if="shown.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">
        No role matches “{{ filter }}”.
      </li>
    </ul>
  </div>
</template>
