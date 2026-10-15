<script setup lang="ts">
/**
 * A small request tool for a forward: method, path, headers and body,
 * sent from Rust to the forward's own local port, with the answer (status,
 * time, size, headers on request, the body pretty-printed). Recent requests
 * sit on the left for a quick re-run.
 */
import { invoke } from "@tauri-apps/api/core";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { ChevronRight, Loader2, Plus, X } from "lucide-vue-next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusDot, statusTextClass } from "@/components/ui/status";
import ContextAvatar from "@/components/ContextAvatar.vue";
import { cn } from "@/lib/utils";
import { portLabel } from "@/lib/portForwardPorts";
import { targetKey } from "@/lib/portForwardLocal";
import { formatSize, forwardTone } from "@/lib/portForwardView";
import {
  HTTP_METHODS,
  formatDuration,
  headerValue,
  jsonTokens,
  methodHasBody,
  normalizePath,
  prettyBody,
  sendableHeaders,
  statusTone,
  useHttpHistory,
  type HttpHistoryEntry,
  type HttpRequestDraft,
  type HttpResponse,
  type JsonTokenKind,
} from "@/lib/portForwardHttp";
import type { ActivePortForwarding } from "@/providers/PortForwardingProvider";

const props = defineProps<{
  /** `null` once the forward stopped while the tester was open. */
  forward: ActivePortForwarding | null;
  /** The forward the tester was opened for (kept when it stops). */
  initial: ActivePortForwarding;
}>();
const emit = defineEmits<{ close: [] }>();

const pf = computed(() => props.forward ?? props.initial);
const history = useHttpHistory(() => targetKey(pf.value));
const entries = computed(() => history.entries());

const blank = (): HttpRequestDraft => ({
  method: "GET",
  path: "/",
  headers: [],
  body: "",
});
const cloneDraft = (draft: HttpRequestDraft): HttpRequestDraft => ({
  ...draft,
  headers: draft.headers.map((h) => ({ ...h })),
});

// Pick up where the last request left off.
const last = entries.value[0];
const draft = ref<HttpRequestDraft>(last ? cloneDraft(last.request) : blank());
const shown = ref<HttpHistoryEntry | null>(last ?? null);
const editor = ref<"headers" | "body" | null>(null);
const sending = ref(false);
const showHeaders = ref(false);

const ready = computed(
  () =>
    props.forward !== null &&
    (props.forward.status === "ready" || props.forward.status === "reconnecting")
);
const unavailable = computed(() => {
  if (!props.forward) return "This forward has stopped.";
  if (props.forward.status === "error") return "This forward stopped working.";
  if (props.forward.status === "starting") return "This forward is still starting.";
  return null;
});

const toggle = (which: "headers" | "body") => {
  editor.value = editor.value === which ? null : which;
  if (editor.value === "headers" && draft.value.headers.length === 0) addHeader();
};
const addHeader = () => draft.value.headers.push({ name: "", value: "" });
const headerCount = computed(
  () => draft.value.headers.filter((h) => h.name.trim()).length
);

const send = async () => {
  if (sending.value || !ready.value || !props.forward) return;
  sending.value = true;
  const request = cloneDraft({
    ...draft.value,
    path: normalizePath(draft.value.path),
  });
  draft.value.path = request.path;
  const entry: HttpHistoryEntry = {
    id: Date.now(),
    at: Date.now(),
    request,
    response: null,
    error: null,
  };
  try {
    entry.response = await invoke<HttpResponse>("port_forward_http_request", {
      request: {
        id: props.forward.id,
        method: request.method,
        path: request.path,
        headers: sendableHeaders(request),
        body: methodHasBody(request.method) ? request.body : null,
      },
    });
  } catch (e) {
    entry.error = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  } finally {
    sending.value = false;
  }
  history.add(entry);
  shown.value = entry;
};

const pick = (entry: HttpHistoryEntry) => {
  draft.value = cloneDraft(entry.request);
  shown.value = entry;
  editor.value = null;
};

const response = computed(() => shown.value?.response ?? null);
const body = computed(() => {
  const r = response.value;
  if (!r || r.binary || !r.body) return null;
  return prettyBody(r.body, headerValue(r.headers, "content-type"));
});
// Colouring is for reading, not for megabytes.
const tokens = computed(() =>
  body.value?.json && body.value.text.length < 200_000
    ? jsonTokens(body.value.text)
    : null
);
const TOKEN_CLASS: Record<JsonTokenKind, string> = {
  key: "text-foreground",
  string: "text-success",
  number: "text-info",
  literal: "text-warning",
  plain: "text-muted-foreground",
};

const modKey = getOsType() === "macos" ? "⌘" : "Ctrl";
const onKeydown = (event: KeyboardEvent) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    send();
  }
};

const subtitle = computed(() => {
  const host = pf.value.address === "127.0.0.1" ? "localhost" : pf.value.address;
  return `${host}:${pf.value.localPort} · ${pf.value.namespace} · ${pf.value.context}`;
});
</script>

<template>
  <Dialog :open="true" @update:open="(open: boolean) => !open && emit('close')">
    <DialogContent
      class="flex h-[min(42rem,86vh)] max-w-4xl flex-col gap-0 overflow-hidden p-0"
      @keydown="onKeydown"
    >
      <header class="flex items-center gap-3 border-b border-border-subtle px-5 py-4 pr-12">
        <ContextAvatar
          :name="pf.context"
          :kube-config="pf.kubeConfig"
          :status="forward ? forwardTone(forward) : 'muted'"
          class="[--avatar-ring:var(--popover)]"
        />
        <div class="min-w-0">
          <DialogTitle class="flex items-baseline gap-2 text-base">
            <span class="truncate">{{ pf.objectName }}</span>
            <span class="shrink-0 text-sm font-normal tabular-nums text-muted-foreground">{{
              portLabel(pf.portName, pf.objectPort)
            }}</span>
          </DialogTitle>
          <DialogDescription class="truncate text-xs">{{ subtitle }}</DialogDescription>
        </div>
      </header>

      <div class="grid min-h-0 flex-1 grid-cols-[15rem_1fr]">
        <aside class="flex min-h-0 flex-col border-r border-border-subtle bg-surface-1/60">
          <h3 class="px-4 pb-1.5 pt-4 text-xs font-medium text-muted-foreground">Recent</h3>
          <ul v-if="entries.length" class="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
            <li v-for="entry in entries" :key="entry.id">
              <button
                type="button"
                :class="
                  cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-fast hover:bg-accent/60 focus-ring',
                    shown?.id === entry.id && 'bg-accent hover:bg-accent'
                  )
                "
                :title="`${entry.request.method} ${entry.request.path}`"
                @click="pick(entry)"
                @dblclick="send"
              >
                <span class="w-11 shrink-0 text-2xs font-medium tracking-wide text-muted-foreground">{{
                  entry.request.method
                }}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{{
                  entry.request.path
                }}</span>
                <span
                  class="shrink-0 text-2xs tabular-nums"
                  :class="
                    entry.response
                      ? statusTextClass[statusTone(entry.response.status)]
                      : 'text-destructive'
                  "
                  >{{ entry.response ? entry.response.status : "failed" }}</span
                >
              </button>
            </li>
          </ul>
          <p v-else class="px-4 text-xs leading-5 text-muted-foreground">
            Requests you send show up here.
          </p>
        </aside>

        <section class="flex min-h-0 min-w-0 flex-col">
          <form class="flex items-center gap-2 px-5 pt-4" @submit.prevent="send">
            <Select v-model="draft.method">
              <SelectTrigger class="w-[6.75rem] shrink-0 text-xs font-medium" aria-label="Method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="method in HTTP_METHODS" :key="method" :value="method" class="text-xs">
                  {{ method }}
                </SelectItem>
              </SelectContent>
            </Select>
            <Input
              v-model="draft.path"
              class="min-w-0 flex-1 font-mono text-xs"
              placeholder="/"
              aria-label="Path"
              spellcheck="false"
              autocomplete="off"
            />
            <Button type="submit" :disabled="!ready || sending" :title="`Send (${modKey}+Enter)`">
              <Loader2 v-if="sending" class="h-3.5 w-3.5 animate-spin" />
              Send
            </Button>
          </form>

          <div class="flex items-center gap-1 px-4 pt-2">
            <button
              type="button"
              class="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
              :aria-expanded="editor === 'headers'"
              @click="toggle('headers')"
            >
              <ChevronRight
                class="h-3 w-3 transition-transform duration-fast"
                :class="editor === 'headers' && 'rotate-90'"
              />
              Headers<span v-if="headerCount" class="tabular-nums"> · {{ headerCount }}</span>
            </button>
            <button
              v-if="methodHasBody(draft.method)"
              type="button"
              class="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
              :aria-expanded="editor === 'body'"
              @click="toggle('body')"
            >
              <ChevronRight
                class="h-3 w-3 transition-transform duration-fast"
                :class="editor === 'body' && 'rotate-90'"
              />
              Body<span v-if="draft.body.trim()" class="text-foreground/60"> · {{ formatSize(draft.body.length) }}</span>
            </button>
          </div>

          <div v-if="editor === 'headers'" class="space-y-1.5 px-5 pt-1">
            <div v-for="(header, index) in draft.headers" :key="index" class="flex items-center gap-2">
              <Input
                v-model="header.name"
                class="h-7 w-44 font-mono text-xs"
                placeholder="Name"
                aria-label="Header name"
                spellcheck="false"
              />
              <Input
                v-model="header.value"
                class="h-7 min-w-0 flex-1 font-mono text-xs"
                placeholder="Value"
                aria-label="Header value"
                spellcheck="false"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                class="text-muted-foreground"
                aria-label="Remove header"
                @click="draft.headers.splice(index, 1)"
              >
                <X class="h-3.5 w-3.5" />
              </Button>
            </div>
            <Button variant="ghost" size="xs" class="text-muted-foreground" @click="addHeader">
              <Plus class="h-3 w-3" /> Add header
            </Button>
          </div>
          <div v-else-if="editor === 'body' && methodHasBody(draft.method)" class="px-5 pt-1">
            <Textarea
              v-model="draft.body"
              class="h-28 resize-none font-mono text-xs"
              placeholder='{ "name": "value" }'
              aria-label="Body"
              spellcheck="false"
            />
          </div>

          <div class="mt-4 border-t border-border-subtle" />

          <div class="flex min-h-0 flex-1 flex-col px-5 pb-4 pt-3" aria-live="polite">
            <p v-if="unavailable && !shown" class="m-auto text-sm text-muted-foreground">
              {{ unavailable }}
            </p>
            <div v-else-if="!shown" class="m-auto text-center">
              <p class="text-sm text-muted-foreground">Send a request to see the answer.</p>
              <p class="mt-1 text-xs text-muted-foreground/80">
                It goes to {{ pf.address === "127.0.0.1" ? "localhost" : pf.address }}:{{ pf.localPort }}, through the forward.
              </p>
            </div>
            <template v-else>
              <div
                :class="cn('flex min-h-0 flex-1 flex-col transition-opacity duration-fast', sending && 'opacity-50')"
              >
                <p
                  v-if="shown.error"
                  class="text-sm text-destructive"
                  role="alert"
                >
                  {{ shown.error }}
                </p>
                <template v-else-if="response">
                  <div class="flex items-center gap-3 text-xs">
                    <span
                      class="flex items-center gap-1.5 text-sm font-medium"
                      :class="statusTextClass[statusTone(response.status)]"
                    >
                      <StatusDot :tone="statusTone(response.status)" />
                      {{ response.status }} {{ response.statusText }}
                    </span>
                    <span class="tabular-nums text-muted-foreground">{{ formatDuration(response.durationMs) }}</span>
                    <span class="tabular-nums text-muted-foreground">{{ formatSize(response.size) }}</span>
                    <button
                      type="button"
                      class="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
                      :aria-expanded="showHeaders"
                      @click="showHeaders = !showHeaders"
                    >
                      <ChevronRight
                        class="h-3 w-3 transition-transform duration-fast"
                        :class="showHeaders && 'rotate-90'"
                      />
                      Headers · {{ response.headers.length }}
                    </button>
                  </div>
                  <dl
                    v-if="showHeaders"
                    class="mt-2 grid max-h-36 shrink-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-border-subtle bg-surface-1 px-3 py-2 text-xs"
                  >
                    <template v-for="(header, index) in response.headers" :key="index">
                      <dt class="text-muted-foreground">{{ header.name }}</dt>
                      <dd class="min-w-0 break-all font-mono text-foreground">{{ header.value }}</dd>
                    </template>
                  </dl>
                  <div
                    class="mt-3 min-h-0 flex-1 overflow-auto rounded-md border border-border-subtle bg-surface-1"
                  >
                    <p v-if="response.binary" class="p-3 text-xs text-muted-foreground">
                      A binary body ({{ formatSize(response.size) }}), not shown.
                    </p>
                    <p v-else-if="!body" class="p-3 text-xs text-muted-foreground">No body.</p>
                    <pre
                      v-else
                      class="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-foreground"
                    ><template v-if="tokens"><span v-for="(token, index) in tokens" :key="index" :class="TOKEN_CLASS[token.kind]">{{ token.text }}</span></template><template v-else>{{ body.text }}</template></pre>
                  </div>
                  <p v-if="response.truncated" class="mt-1.5 text-2xs text-muted-foreground">
                    Showing the first {{ formatSize(response.size) }}.
                  </p>
                </template>
              </div>
            </template>
          </div>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
