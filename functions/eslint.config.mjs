// Flat-config wrapper around the project's existing .eslintrc.js.
//
// ESLint 8.57 auto-detects eslint.config.* searching upward from cwd. Without
// this file, running `npm run lint` in functions/ picks up the repo-root
// eslint.config.mjs (ESLint 9 toolchain, not installed here) and crashes.
// Wrapping .eslintrc.js via FlatCompat keeps eslint-config-google semantics
// while making the lint boundary deterministic - no ESLINT_USE_FLAT_CONFIG
// environment variable needed.
import {FlatCompat} from "@eslint/eslintrc";
import js from "@eslint/js";
import {createRequire} from "node:module";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default compat.config(require("./.eslintrc.js"));
