<script setup lang="ts">
/**
 * The forward manager (the sidebar footer's popover): running forwards and
 * saved profiles below. Loaded on first open; the sidebar entry stays light.
 */
import ForwardRow from "@/components/port-forwards/ForwardRow.vue";
import ProfileRow from "@/components/port-forwards/ProfileRow.vue";
import {
  PortForwardingStateKey,
  PortForwardingRemovePortForwarding,
  PortForwardingProfilesKey,
  PortForwardingActionsKey,
  type ActivePortForwarding,
} from "@/providers/PortForwardingProvider";
import { injectStrict } from "@/lib/utils";
import { profileId, toSpec, type PortForwardProfile } from "@/lib/portForwardProfiles";
import { error as logError } from "@/lib/logger";
import { useToast } from "@/components/ui/toast";

defineProps<{ summary: string }>();
const emit = defineEmits<{ test: [forward: ActivePortForwarding] }>();

const { activePortForwardings } = injectStrict(PortForwardingStateKey);
const removePortForwarding = injectStrict(PortForwardingRemovePortForwarding);
const pfProfiles = injectStrict(PortForwardingProfilesKey);
const actions = injectStrict(PortForwardingActionsKey);
const profiles = pfProfiles.profiles;
const { toast } = useToast();

// Traffic counters and "Reconnected 2m ago" stay fresh while it's open.
const now = ref(Date.now());
actions.refresh();
const poll = setInterval(() => {
  now.value = Date.now();
  actions.refresh();
}, 2000);
onBeforeUnmount(() => clearInterval(poll));

const savedIds = computed(() => new Set(profiles.value.map((p) => p.id)));
const isSaved = (pf: ActivePortForwarding) =>
  savedIds.value.has(profileId(toSpec(pf)));
const toggleSaved = (pf: ActivePortForwarding) => {
  if (isSaved(pf)) pfProfiles.remove(profileId(toSpec(pf)));
  else pfProfiles.save(pf);
};

const failed = (title: string, e: unknown) =>
  toast({
    title,
    description: e instanceof Error ? e.message : String(e),
    variant: "destructive",
    autoDismiss: true,
  });

const restart = (pf: ActivePortForwarding) =>
  actions.restart(pf).catch((e) => failed(`Couldn't restart ${pf.objectName}`, e));

const startingProfile = ref<string | null>(null);
const startProfile = async (profile: PortForwardProfile) => {
  startingProfile.value = profile.id;
  try {
    await pfProfiles.start(profile.id);
  } catch (e) {
    logError(`Failed to start port forward ${profile.name}: ${e}`);
    failed(`Couldn't start ${profile.name}`, e);
  } finally {
    startingProfile.value = null;
  }
};
</script>

<template>
  <header data-manager-header tabindex="-1" class="px-4 pb-2 pt-3.5 outline-none">
    <h2 class="text-sm font-medium text-foreground">Port forwards</h2>
    <p class="text-xs text-muted-foreground">{{ summary }}</p>
  </header>

  <ul
    v-if="activePortForwardings.length > 0"
    class="max-h-[50vh] space-y-px overflow-y-auto px-1.5 pb-1.5"
  >
    <ForwardRow
      v-for="pf in activePortForwardings"
      :key="pf.id"
      :forward="pf"
      :saved="isSaved(pf)"
      :now="now"
      @open="actions.openInBrowser(pf)"
      @test="emit('test', pf)"
      @save="toggleSaved(pf)"
      @restart="restart(pf)"
      @stop="removePortForwarding(pf)"
    />
  </ul>
  <p v-else class="px-4 pb-3 text-xs leading-5 text-muted-foreground">
    Nothing is forwarded right now. Start a profile below, or forward a port
    from a pod, deployment or service.
  </p>

  <template v-if="profiles.length > 0">
    <div class="border-t border-border-subtle" />
    <div class="flex items-baseline justify-between px-4 pb-1 pt-3">
      <span class="text-xs font-medium text-muted-foreground">
        Profiles <span class="ml-1 tabular-nums">{{ profiles.length }}</span>
      </span>
      <span class="text-2xs text-muted-foreground">Start with JET Pilot</span>
    </div>
    <ul class="max-h-[30vh] space-y-px overflow-y-auto px-1.5 pb-1.5">
      <ProfileRow
        v-for="profile in profiles"
        :key="profile.id"
        :profile="profile"
        :running="pfProfiles.isRunning(profile)"
        :starting="startingProfile === profile.id"
        @start="startProfile(profile)"
        @auto-start="(on) => pfProfiles.setAutoStart(profile.id, on)"
        @remove="pfProfiles.remove(profile.id)"
      />
    </ul>
  </template>
</template>
