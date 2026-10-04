<script setup lang="ts">
import { type Component, isVNode } from "vue";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-vue-next";
import { useToast } from "./use-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from ".";

const { toasts } = useToast();

const icons: Record<string, { icon: Component; class: string }> = {
  destructive: { icon: XCircle, class: "text-destructive" },
  success: { icon: CheckCircle2, class: "text-success" },
  warning: { icon: AlertTriangle, class: "text-warning" },
  info: { icon: Info, class: "text-info" },
};
</script>

<template>
  <ToastProvider>
    <Toast v-for="toast in toasts" :key="toast.id" v-bind="toast">
      <component
        :is="icons[toast.variant].icon"
        v-if="toast.variant && icons[toast.variant]"
        :class="['mt-0.5 h-4 w-4 shrink-0', icons[toast.variant].class]"
        aria-hidden="true"
      />
      <div class="grid min-w-0 flex-1 gap-0.5">
        <ToastTitle v-if="toast.title">
          {{ toast.title }}
        </ToastTitle>
        <template v-if="toast.description">
          <ToastDescription v-if="isVNode(toast.description)">
            <component :is="toast.description" />
          </ToastDescription>
          <ToastDescription v-else>
            {{ toast.description }}
          </ToastDescription>
        </template>
        <ToastClose />
      </div>
      <component :is="toast.action" />
    </Toast>
    <ToastViewport />
  </ToastProvider>
</template>
