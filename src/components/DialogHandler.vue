<script setup lang="ts">
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { DialogProviderStateKey } from "@/providers/DialogProvider";
import { injectStrict } from "@/lib/utils";

const { dialog } = injectStrict(DialogProviderStateKey);
</script>

<template>
  <AlertDialog v-if="dialog" :open="true">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ dialog.title }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ dialog.message }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogAction
          v-for="(button, index) in dialog.buttons"
          :key="index"
          @click="button.handler(dialog)"
          >{{ button.label }}</AlertDialogAction
        >
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
