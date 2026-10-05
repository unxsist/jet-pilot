<script setup lang="ts">
/**
 * Where a cluster runs, as the provider's mark (src/lib/clusters/providerGlyphs.ts,
 * from Simple Icons). Amazon and Microsoft don't allow their marks there, so
 * EKS and AKS get a text chip in their brand colour.
 */
import { PROVIDER_GLYPHS } from "@/lib/clusters/providerGlyphs";
import { PROVIDER_LABELS, localFlavor, type ProviderId } from "@/lib/clusters/provider";

const props = withDefaults(defineProps<{ provider: ProviderId; context?: string; size?: number }>(), {
  size: 16,
  context: "",
});

const TEXT_MARKS: Partial<Record<ProviderId, { text: string; hex: string }>> = {
  aws: { text: "AWS", hex: "FF9900" },
  azure: { text: "AZ", hex: "0078D4" },
};

const glyph = computed(() => {
  if (props.provider === "local") return PROVIDER_GLYPHS[localFlavor(props.context)] ?? PROVIDER_GLYPHS.kubernetes;
  if (props.provider === "other") return PROVIDER_GLYPHS.kubernetes;
  return PROVIDER_GLYPHS[props.provider];
});
const textMark = computed(() => TEXT_MARKS[props.provider]);

/* Very dark brand colours disappear on dark canvases: use the text colour there. */
const luminance = (hex: string) => {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const darkBrand = computed(() => !!glyph.value && luminance(glyph.value.hex) < 0.08);
</script>

<template>
  <span
    v-if="textMark"
    class="inline-flex shrink-0 items-center justify-center rounded-[4px] px-1 font-bold leading-none tracking-tight text-white"
    :style="{ background: `#${textMark.hex}`, height: `${size}px`, fontSize: `${Math.round(size * 0.5)}px`, minWidth: `${size}px` }"
    :title="PROVIDER_LABELS[provider]"
    role="img"
    :aria-label="PROVIDER_LABELS[provider]"
  >
    {{ textMark.text }}
  </span>
  <svg
    v-else-if="glyph"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    class="shrink-0"
    :class="darkBrand ? 'dark:[--brand:hsl(var(--foreground))]' : ''"
    :style="{ '--brand-color': `#${glyph.hex}` }"
    role="img"
    :aria-label="PROVIDER_LABELS[provider]"
  >
    <title>{{ PROVIDER_LABELS[provider] }}</title>
    <path :d="glyph.path" fill="var(--brand, var(--brand-color))" />
  </svg>
</template>
