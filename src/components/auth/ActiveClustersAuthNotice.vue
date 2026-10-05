<script setup lang="ts">
/**
 * Above every view that needs a context (RouterViewport): one slim strip
 * per active cluster that needs the user to sign in, with a Sign in button.
 * The views themselves keep these failures out of their error banners and
 * reconnect once the sign-in succeeded.
 */
import { KeyRound, Loader2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import ClusterLabel from "@/components/clusters/ClusterLabel.vue";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { injectStrict } from "@/lib/utils";
import { credentialView, requestSignIn } from "@/lib/auth/center";

const { contexts, contextKubeConfigMapping } = injectStrict(KubeContextStateKey);

const pending = computed(() =>
  [...contexts.value.keys()]
    .map((context) =>
      credentialView({
        context,
        kubeConfig: contextKubeConfigMapping.value.get(context) ?? "",
      })
    )
    .filter((view) => view.needsSignIn && view.canSignIn)
);
</script>

<template>
  <div v-if="pending.length > 0" class="flex shrink-0 flex-col border-b bg-warning/[0.05]" data-testid="auth-notice">
    <div
      v-for="view in pending"
      :key="view.key"
      role="alert"
      class="flex h-11 min-w-0 items-center gap-3 border-border-subtle px-4 text-sm [&:not(:first-child)]:border-t"
    >
      <KeyRound class="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      <span class="flex min-w-0 max-w-[50%] shrink-0">
        <ClusterLabel :context="view.target.context" :kube-config="view.target.kubeConfig" class="font-medium" />
      </span>
      <span class="min-w-0 flex-1 truncate text-muted-foreground" :title="view.lastIssue?.message">
        {{ view.state === "expired" ? "Credentials expired" : "Needs a sign-in" }}
      </span>
      <Button
        size="sm"
        variant="outline"
        class="h-7 shrink-0"
        :disabled="view.signingIn"
        @click="requestSignIn(view.target)"
      >
        <Loader2 v-if="view.signingIn" class="h-3.5 w-3.5 animate-spin" />
        {{ view.signingIn ? "Signing in…" : "Sign in" }}
      </Button>
    </div>
  </div>
</template>
