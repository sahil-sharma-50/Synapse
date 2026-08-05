import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "src-tauri/target", "node_modules"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // Every window here is a long-lived webview wiring up Tauri event
      // listeners in effects; a missing cleanup or a stale closure over
      // `generation`/`downloading` is the failure mode that actually bites.
      "react-hooks/exhaustive-deps": "error",

      // The React Compiler rules below flag patterns this app uses on purpose
      // and documents in place: a ref mirroring state so a debounced save reads
      // the latest text, and effects that reset local draft state when the
      // provider changes. They are real smells worth revisiting, but they are
      // not regressions, so they warn rather than block a PR. Demote to "off"
      // only with a reason; promote to "error" once the call sites are gone.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",

      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],

      // `_`-prefixed args are the convention for deliberately unused params.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Config and build files run in Node, not the browser.
    files: ["*.config.{js,ts}", "vite.config.ts", "vitest.config.ts"],
    languageOptions: { globals: globals.node },
  },
);
