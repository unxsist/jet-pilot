import { ref } from "vue";

/**
 * The describe people last chose (the native document or kubectl's text),
 * for the session: new Describe tabs open with it.
 */
export const preferredDescribeView = ref<"native" | "describe">("native");
