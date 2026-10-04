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
  <!-- Escape (and any other dismissal) closes the dialog like a Close button -->
  <AlertDialog
    v-if="dialog"
    :open="true"
    @update:open="(open: boolean) => !open && dialog?.close()"
  >
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ dialog.title }}</AlertDialogTitle>
        <AlertDialogDescription
          class="max-h-[50vh] overflow-y-auto whitespace-pre-line break-words"
          >{{ dialog.message }}</AlertDialogDescription
        >
      </AlertDialogHeader>
      <component
        :is="dialog.component"
        v-if="dialog.component"
        v-bind="dialog.props"
        @close-dialog="dialog.close"
      />
      <AlertDialogFooter v-if="dialog.buttons && dialog.buttons.length > 0">
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
