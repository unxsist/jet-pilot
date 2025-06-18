<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { Kubernetes } from "@/services/Kubernetes";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";

import {
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { V1Namespace } from "@kubernetes/client-node";
import DropdownMenuItem from "./ui/dropdown-menu/DropdownMenuItem.vue";
import Spinner from "./Spinner.vue";

import {
  KubeContextSetActiveNamespacesKey,
  KubeContextIsContextActiveKey,
  KubeContextIsNamespaceActiveKey,
  KubeContextStateKey,
} from "@/providers/KubeContextProvider";

const { contexts: activeContexts } = injectStrict(KubeContextStateKey);
const { settings } = injectStrict(SettingsContextStateKey);
const setActiveNamespaces = injectStrict(KubeContextSetActiveNamespacesKey);
const isContextActive = injectStrict(KubeContextIsContextActiveKey);
const isNamespaceActive = injectStrict(KubeContextIsNamespaceActiveKey);

const contexts = ref<
  {
    context: string;
    defaultNamespace: string;
    namespaces: string[];
    isFetching?: boolean;
    canListNamespaces?: boolean;
    canConnect?: boolean;
    canHandleAuth?: boolean;
    handleAuthCallback?: () => void;
    kubeConfig: string;
  }[]
>([]);

const activeNamespaces = ref<Map<string, string[]>>(
  new Map<string, string[]>()
);

const toggleActiveNamespace = (
  context: string,
  kubeConfig: string,
  namespace: string
) => {
  if (!activeNamespaces.value.has(context)) {
    activeNamespaces.value.set(context, []);
  }

  const ctx = contexts.value.find((ctx) => ctx.context === context);

  if (!ctx) return;

  let namespaces = activeNamespaces.value.get(context) || [];

  if (namespace === "all" && !namespaces.includes("all")) {
    activeNamespaces.value.set(context, ["all"]);

    setActiveNamespaces(
      context,
      kubeConfig,
      activeNamespaces.value.get(context) || []
    );

    return;
  }

  if (namespace !== "all" && namespaces.includes("all")) {
    activeNamespaces.value.set(context, ctx.namespaces);
    namespaces = activeNamespaces.value.get(context) || [];
  }

  if (namespace !== "all" && !namespaces.includes(namespace)) {
    if (namespaces.length + 1 === ctx.namespaces.length) {
      activeNamespaces.value.set(context, ["all"]);

      setActiveNamespaces(
        context,
        kubeConfig,
        activeNamespaces.value.get(context) || []
      );

      return;
    }
  }

  if (namespaces.includes(namespace)) {
    activeNamespaces.value.set(
      context,
      namespaces.filter((ns) => ns !== namespace)
    );
  } else {
    activeNamespaces.value.set(context, [...namespaces, namespace]);
  }

  setActiveNamespaces(
    context,
    kubeConfig,
    activeNamespaces.value.get(context) || []
  );
};

const fetchContexts = async () => {
  contexts.value = [];
  for (const kubeConfig of settings.value.kubeConfigs) {
    await Kubernetes.setCurrentKubeConfig(kubeConfig);
    const ctx = await Kubernetes.getContexts();
    contexts.value.push(
      ...ctx.map((ctx) => {
        return {
          context: ctx.name,
          defaultNamespace: ctx.context.namespace,
          namespaces: [],
          kubeConfig: kubeConfig,
        };
      })
    );
  }
};

const fetchNamespaces = async (context: string) => {
  const ctx = contexts.value.find((ctx) => ctx.context === context);

  if (!ctx) return;
  if (ctx.namespaces.length > 0) return;

  const clusterSettings = settings.value.contextSettings.find(
    (c) => c.context === context
  );

  if (
    clusterSettings &&
    clusterSettings.namespaces &&
    clusterSettings.namespaces.length > 0
  ) {
    ctx.canConnect = true;
    ctx.namespaces = clusterSettings.namespaces;
    return;
  }

  ctx.isFetching = true;

  await Kubernetes.setCurrentKubeConfig(ctx.kubeConfig);
  try {
    const namespaces = await Kubernetes.getNamespaces(context, ctx.kubeConfig);
    ctx.namespaces = namespaces.map(
      (ns: V1Namespace) => ns.metadata?.name || ""
    );
    ctx.canConnect = true;
  } catch (err: { code: number; message: string }) {
    if (err.code === 401) {
      ctx.canConnect = true;
      ctx.canListNamespaces = false;

      if (ctx.defaultNamespace) {
        ctx.namespaces = [ctx.defaultNamespace];
      } else {
        ctx.namespaces = [];
      }

      return;
    }

    ctx.canConnect = false;

    const authHandler = await Kubernetes.getAuthErrorHandler(
      ctx.context,
      ctx.kubeConfig,
      err.message
    );

    ctx.canHandleAuth = authHandler.canHandle;
    ctx.handleAuthCallback = () => {
      authHandler.callback(() => {
        fetchNamespaces(context);
        ctx.canConnect = true;
      });
    };
  } finally {
    ctx.isFetching = false;
  }
};

onMounted(async () => {
  await fetchContexts();
});
</script>
<template>
  <div class="w-full mt-2 mb-4 pr-2">
    <DropdownMenu>
      <DropdownMenuTrigger class="w-full">
        <div
          class="bg-background border border-muted hover:bg-muted rounded p-1 text-xs"
        >
          Connected to {{ activeContexts.size }} of
          {{ contexts.length }} contexts
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        class="w-[--reka-dropdown-menu-trigger-width] min-w-56 rounded-lg max-h-[80vh] overflow-y-auto"
        align="start"
        side="right"
        :side-offset="4"
      >
        <DropdownMenuLabel class="text-xs text-muted-foreground">
          Contexts
        </DropdownMenuLabel>
        <DropdownMenuSub v-for="context in contexts" :key="context.context">
          <DropdownMenuSubTrigger
            class="py-2"
            @mouseenter="fetchNamespaces(context.context)"
          >
            <div class="flex items-center gap-2 max-w-[225px]">
              <span
                class="block w-2 h-2 rounded-full"
                :class="{
                  'bg-gray-500': !isContextActive(context.context),
                  // 'bg-yellow-500': context.canHandleAuth,
                  'bg-green-500': isContextActive(context.context),
                  // 'bg-red-500': !context.canConnect && !context.canHandleAuth,
                }"
              ></span>
              <span class="whitespace-nowrap truncate">{{
                context.context
              }}</span>
            </div>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent
              class="max-h-[80vh] overflow-y-auto"
              align="start"
              side="right"
              :side-offset="4"
            >
              <template
                v-if="!context.isFetching && context.namespaces.length > 0"
              >
                <DropdownMenuCheckboxItem
                  :checked="isNamespaceActive(context.context, 'all')"
                  @select.prevent="
                    toggleActiveNamespace(
                      context.context,
                      context.kubeConfig,
                      'all'
                    )
                  "
                >
                  <span>All namespaces</span>
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
              </template>
              <DropdownMenuLabel v-if="context.isFetching">
                <div class="flex flex-row items-center gap-2">
                  <Spinner class="text-white max-w-[16px]" />
                  <span>Fetching namespaces...</span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuItem
                v-if="
                  !context.isFetching &&
                  context.canHandleAuth &&
                  context.namespaces.length === 0
                "
                @select.prevent="
                  context.handleAuthCallback && context.handleAuthCallback()
                "
              >
                <button class="w-full text-left">
                  <span>Re-authenticate</span>
                </button>
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="
                  !context.isFetching &&
                  !context.canConnect &&
                  !context.canHandleAuth
                "
              >
                <span class="text-red-500">
                  Cannot connect to this context
                </span>
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                v-for="namespace in context.namespaces"
                :key="namespace"
                :value="namespace"
                :checked="isNamespaceActive(context.context, namespace)"
                @select.prevent="
                  toggleActiveNamespace(
                    context.context,
                    context.kubeConfig,
                    namespace
                  )
                "
              >
                <span>{{ namespace }}</span>
              </DropdownMenuCheckboxItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>

<style scoped>
.marquee-container {
  overflow: hidden;
  white-space: nowrap;
  /* width: 100%; */
}

.marquee {
  display: inline-block;
  /* transform: translateX(0%);
  margin-left: 0%; */
  animation: marquee 30s linear infinite;
  animation-delay: 0s, 5;
}

@keyframes marquee {
  0% {
    transform: translateX(0%);
    margin-left: 0%;
  }
  25% {
    transform: translateX(-100%);
    margin-left: 100%;
  }
  50% {
    transform: translateX(-100%);
    margin-left: 100%;
  }
  75% {
    transform: translateX(0%);
    margin-left: 0%;
  }
  100% {
    transform: translateX(0%);
    margin-left: 0%;
  }
}
</style>
