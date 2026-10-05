<script setup lang="ts">
/*
 * Settings › Appearance › Themes: the library (ending in the add-a-theme
 * tile, with the themes folder one click away) and the Open VSX gallery.
 */
import { FolderOpen } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import ThemeLibrary from "@/components/settings/themes/ThemeLibrary.vue";
import AddTheme from "@/components/settings/themes/AddTheme.vue";
import ThemeGallery from "@/components/settings/themes/ThemeGallery.vue";
import { errorMessage } from "@/components/settings/themes/shared";
import { useTheme } from "@/providers/ThemeProvider";

const theme = useTheme();
const { toast } = useToast();

const openFolder = async () => {
  try {
    await theme.openFolder();
  } catch (e) {
    toast({ title: "Couldn't open the themes folder", description: errorMessage(e), variant: "destructive" });
  }
};
</script>

<template>
  <ThemeLibrary>
    <template #actions>
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground"
        title="Open the themes folder"
        aria-label="Open the themes folder"
        @click="openFolder"
      >
        <FolderOpen class="h-3.5 w-3.5" />
      </Button>
    </template>
    <template #add>
      <AddTheme />
    </template>
  </ThemeLibrary>
  <ThemeGallery />
</template>
