import { readFileSync } from "node:fs";
import pluginVue from "eslint-plugin-vue";
import pluginSecurity from "eslint-plugin-security";
import prettierConfig from "eslint-config-prettier/flat";
import {
  defineConfigWithVueTs,
  vueTsConfigs,
} from "@vue/eslint-config-typescript";

// Globals for APIs auto-imported by unplugin-auto-import (see vite.config.ts).
const autoImport = JSON.parse(
  readFileSync(new URL("./.eslintrc-auto-import.json", import.meta.url), "utf8")
);

const isProduction = process.env.NODE_ENV === "production";

export default defineConfigWithVueTs(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "src/auto-imports.d.ts",
    ],
  },
  pluginVue.configs["flat/recommended"],
  vueTsConfigs.recommended,
  pluginSecurity.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      ecmaVersion: 2021,
      globals: autoImport.globals,
    },
    rules: {
      "no-var": "error",
      "no-console": isProduction ? "warn" : "off",
      "no-debugger": isProduction ? "warn" : "off",
      "comma-dangle": ["error", "only-multiline"],
    },
  }
);
