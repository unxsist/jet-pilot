<script setup lang="ts">
/**
 * Enter a cluster by hand: API server, how to trust it, and a token or a
 * client certificate. "Test connection" checks it before anything is saved.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { CheckCircle2, CircleAlert, FolderOpen, Loader2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage, testConnection } from "@/lib/clusters/managed";
import { toSpec, type ManualForm } from "./forms";

const form = defineModel<ManualForm>({ required: true });
const emit = defineEmits<{ valid: [ok: boolean] }>();

const problems = computed(() => {
  const list: Partial<Record<keyof ManualForm, string>> = {};
  if (!form.value.name.trim()) list.name = "Give the cluster a name";
  if (!/^https?:\/\/[^\s/]+/.test(form.value.server.trim())) list.server = "An https:// address, e.g. https://k8s.example.com:6443";
  else if (form.value.server.trim().startsWith("http://") && form.value.ca !== "insecure")
    list.server = "Plain http needs “Don't verify”";
  if (form.value.ca === "pem" && !form.value.caPem.includes("BEGIN CERTIFICATE")) list.caPem = "Paste a PEM certificate";
  if (form.value.auth === "token" && !form.value.token.trim()) list.token = "Paste a bearer token";
  if (form.value.auth === "clientCert") {
    if (!form.value.certPem.includes("BEGIN CERTIFICATE")) list.certPem = "Paste the client certificate (PEM)";
    if (!/BEGIN (RSA |EC )?PRIVATE KEY/.test(form.value.keyPem)) list.keyPem = "Paste the private key (PEM)";
  }
  return list;
});
const valid = computed(() => Object.keys(problems.value).length === 0);
watch(valid, (ok) => emit("valid", ok), { immediate: true });

const touched = reactive(new Set<string>());
const show = (key: keyof ManualForm) => (touched.has(key) ? problems.value[key] : undefined);

const loadFile = async (key: "caPem" | "certPem" | "keyPem") => {
  const path = await open({ multiple: false, title: "Choose a PEM file" });
  if (!path || Array.isArray(path)) return;
  form.value[key] = await readTextFile(path).catch(() => form.value[key]);
  touched.add(key);
};

const testing = ref(false);
const result = ref<{ ok: boolean; text: string } | null>(null);
const test = async () => {
  for (const key of Object.keys(form.value)) touched.add(key);
  if (!valid.value) return;
  testing.value = true;
  result.value = null;
  try {
    const outcome = await testConnection(toSpec(form.value));
    result.value = outcome.ok
      ? { ok: true, text: `Connected · Kubernetes ${outcome.serverVersion ?? ""}`.trim() }
      : { ok: false, text: outcome.message ?? "Couldn't connect" };
  } catch (e) {
    result.value = { ok: false, text: errorMessage(e) };
  } finally {
    testing.value = false;
  }
};
watch(form, () => (result.value = null), { deep: true });
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3">
      <label for="manual-name" class="pt-1.5 text-sm font-medium">Name</label>
      <div class="space-y-1">
        <Input id="manual-name" v-model="form.name" placeholder="homelab" spellcheck="false" @blur="touched.add('name')" />
        <p v-if="show('name')" class="text-xs text-destructive">{{ show("name") }}</p>
      </div>

      <label for="manual-server" class="pt-1.5 text-sm font-medium">API server</label>
      <div class="space-y-1">
        <Input id="manual-server" v-model="form.server" class="font-mono text-xs" placeholder="https://k8s.example.com:6443" spellcheck="false" @blur="touched.add('server')" />
        <p v-if="show('server')" class="text-xs text-destructive">{{ show("server") }}</p>
      </div>

      <span class="pt-1.5 text-sm font-medium">Trust</span>
      <div class="space-y-2">
        <Tabs v-model="form.ca">
          <TabsList aria-label="Certificate authority">
            <TabsTrigger value="system" class="px-2.5">System</TabsTrigger>
            <TabsTrigger value="pem" class="px-2.5">CA certificate</TabsTrigger>
            <TabsTrigger value="insecure" class="px-2.5">Don't verify</TabsTrigger>
          </TabsList>
        </Tabs>
        <template v-if="form.ca === 'pem'">
          <Textarea v-model="form.caPem" rows="3" class="font-mono text-2xs" placeholder="-----BEGIN CERTIFICATE-----" @blur="touched.add('caPem')" />
          <div class="flex items-center justify-between">
            <p class="text-xs text-destructive">{{ show("caPem") }}</p>
            <Button size="sm" variant="ghost" @click="loadFile('caPem')"><FolderOpen class="h-3.5 w-3.5" /> From file…</Button>
          </div>
        </template>
        <p v-else-if="form.ca === 'insecure'" class="flex items-start gap-1.5 text-xs text-warning">
          <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" />
          The server's identity isn't checked. Only for test clusters on networks you trust.
        </p>
        <p v-else class="text-xs text-muted-foreground">Trusted when its certificate is signed by an authority your system trusts.</p>
      </div>

      <span class="pt-1.5 text-sm font-medium">Credentials</span>
      <div class="space-y-2">
        <Tabs v-model="form.auth">
          <TabsList aria-label="Credentials">
            <TabsTrigger value="token" class="px-2.5">Token</TabsTrigger>
            <TabsTrigger value="clientCert" class="px-2.5">Client certificate</TabsTrigger>
            <TabsTrigger value="none" class="px-2.5">None</TabsTrigger>
          </TabsList>
        </Tabs>
        <template v-if="form.auth === 'token'">
          <Input v-model="form.token" type="password" class="font-mono text-xs" placeholder="eyJhbGciOi…" autocomplete="off" @blur="touched.add('token')" />
          <p v-if="show('token')" class="text-xs text-destructive">{{ show("token") }}</p>
        </template>
        <template v-else-if="form.auth === 'clientCert'">
          <div class="grid grid-cols-2 gap-2">
            <div class="space-y-1">
              <Textarea v-model="form.certPem" rows="3" class="font-mono text-2xs" placeholder="Certificate (PEM)" @blur="touched.add('certPem')" />
              <div class="flex items-center justify-between">
                <p class="text-2xs text-destructive">{{ show("certPem") }}</p>
                <Button size="sm" variant="ghost" class="h-6" @click="loadFile('certPem')"><FolderOpen class="h-3 w-3" /> File…</Button>
              </div>
            </div>
            <div class="space-y-1">
              <Textarea v-model="form.keyPem" rows="3" class="font-mono text-2xs" placeholder="Private key (PEM)" @blur="touched.add('keyPem')" />
              <div class="flex items-center justify-between">
                <p class="text-2xs text-destructive">{{ show("keyPem") }}</p>
                <Button size="sm" variant="ghost" class="h-6" @click="loadFile('keyPem')"><FolderOpen class="h-3 w-3" /> File…</Button>
              </div>
            </div>
          </div>
        </template>
        <p class="text-xs text-muted-foreground">
          Stored in your system keychain, never in a plain kubeconfig file.
        </p>
      </div>

      <label for="manual-namespace" class="pt-1.5 text-sm font-medium">Namespace</label>
      <Input id="manual-namespace" v-model="form.namespace" placeholder="default" spellcheck="false" />
    </div>

    <div class="flex items-center gap-3 rounded-lg border bg-surface-1 px-3 py-2">
      <Button size="sm" variant="outline" :disabled="testing" @click="test">
        <Loader2 v-if="testing" class="h-3.5 w-3.5 animate-spin" />
        Test connection
      </Button>
      <span v-if="result" class="flex min-w-0 items-center gap-1.5 text-xs" :class="result.ok ? 'text-success' : 'text-destructive'">
        <CheckCircle2 v-if="result.ok" class="h-3.5 w-3.5 shrink-0" />
        <CircleAlert v-else class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate" :title="result.text">{{ result.text }}</span>
      </span>
      <span v-else class="text-xs text-muted-foreground">Checks the address, trust and credentials without saving anything.</span>
    </div>
  </div>
</template>
