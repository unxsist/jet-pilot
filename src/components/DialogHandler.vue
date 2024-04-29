<script setup lang="ts">
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

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
      <AlertDialogFooter v-if="dialog.buttons.length > 0">
        <Button
          v-for="(button, index) in dialog.buttons"
          :key="index"
          :variant="button.variant ?? 'default'"
          @click="button.handler(dialog)"
          >{{ button.label }}</Button
        >
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
