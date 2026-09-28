import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            REVIEW_READ_TOKEN: "read-tok",
            REVIEW_WRITE_TOKEN: "write-tok",
            REVIEW_READ_TOKENS: JSON.stringify({ "acme-read-tok": "acme" }),
          },
        },
      },
    },
  },
});
