#!/usr/bin/env bun
/**
 * Applies the estate schema (src/directus/schema.ts) to a live Directus.
 *
 * This is the step that turns "schema as code" from a claim into a fact: the
 * declaration in the repo is what the instance gets, reviewed in a PR, and
 * re-appliable after a bad migration. Nothing here is hand-clicked.
 *
 *   DIRECTUS_URL=https://estate.example.com \
 *   DIRECTUS_ADMIN_TOKEN=<admin static token> \
 *   bun run scripts/directus-schema.ts [--dry-run]
 *
 * TWO DIFFERENT CREDENTIALS, ON PURPOSE:
 *   DIRECTUS_ADMIN_TOKEN  used ONLY here, by a human, to create structure.
 *   DIRECTUS_TOKEN        the Worker's, read-only, set with `wrangler secret
 *                         put`. It must NOT be able to alter the schema.
 * If those two are ever the same value, a bug in a request handler can drop
 * a column. See src/env.ts.
 *
 * SAFE TO RE-RUN. Every step probes first: existing collections and fields
 * are left alone, missing ones are created. Nothing is deleted and nothing is
 * altered — a field whose declaration drifted is REPORTED so a human decides,
 * because a Directus type change can discard the column's data.
 *
 * `--dry-run` prints what would be created without writing anything.
 *
 * Not type-checked by `bun run check` (scripts/ is outside every tsconfig
 * project — same as scripts/build-page.ts), which is exactly why all the
 * logic lives in src/directus/schema-apply.ts and this file is only argument
 * parsing and printing.
 */
import { applyEstateSchema, type AdminConfig, type FetchLike } from "../src/directus/schema-apply";
import { ESTATE_SCHEMA } from "../src/directus/schema";

const url = process.env.DIRECTUS_URL?.trim().replace(/\/+$/, "");
const token = process.env.DIRECTUS_ADMIN_TOKEN?.trim();
const dryRun = process.argv.includes("--dry-run");

if (!url || !token) {
  console.error("DIRECTUS_URL and DIRECTUS_ADMIN_TOKEN must both be set.");
  console.error("DIRECTUS_ADMIN_TOKEN is the ADMIN token — not the Worker's read-only DIRECTUS_TOKEN.");
  process.exit(1);
}
if (!url.startsWith("https://")) {
  console.error(`DIRECTUS_URL must be https (got ${url}) — this request carries an admin token.`);
  process.exit(1);
}

if (dryRun) {
  console.log("dry run — nothing will be written\n");
  for (const c of ESTATE_SCHEMA) {
    console.log(`${c.collection}  (${c.fields.length} fields + id)`);
    for (const f of c.fields) {
      const flags = [
        f.nullable === false ? "required" : null,
        f.unique === true ? "unique" : null,
        f.relatedCollection ? `-> ${f.relatedCollection}` : null,
        f.choices ? `[${f.choices.join("|")}]` : null,
      ].filter(Boolean).join(" ");
      console.log(`  ${f.field.padEnd(20)} ${f.type.padEnd(10)} ${flags}`);
    }
    console.log("");
  }
  process.exit(0);
}

const cfg: AdminConfig = { url, token };
const doFetch: FetchLike = (target, init) => fetch(target, init);

const report = await applyEstateSchema(cfg, doFetch);

const show = (label: string, items: string[]): void => {
  if (items.length === 0) return;
  console.log(`${label} (${items.length}):`);
  for (const i of items) console.log(`  ${i}`);
};

show("collections created", report.collectionsCreated);
show("collections already present", report.collectionsExisting);
show("fields created", report.fieldsCreated);
show("relations created", report.relationsCreated);

if (report.mismatched.length > 0) {
  // Not fixed automatically — a Directus type change can discard data.
  console.warn("\nDECLARED DIFFERENTLY FROM THE LIVE INSTANCE — nothing was altered:");
  for (const m of report.mismatched) console.warn(`  ${m}`);
  console.warn("Reconcile by hand, or by editing src/directus/schema.ts to match reality.");
  process.exit(2);
}

console.log("\nestate schema applied.");
