// Wrangler's bundler treats *.html imports as raw-text modules by default
// (deployment-bundle/rules.ts's DEFAULT_MODULE_RULES: {type:"Text",
// globs:["**/*.txt","**/*.html","**/*.sql"]}) — verified against the pinned
// wrangler dist; no wrangler.jsonc `rules` entry needed, and
// @cloudflare/vitest-pool-workers shares the same bundling path (it reads
// this project's own wrangler.jsonc — see vitest.config.ts), so the import
// resolves identically under `wrangler dev` and under the test suite.
// TypeScript still needs telling what the shape is.
declare module "*.html" {
  const content: string;
  export default content;
}
