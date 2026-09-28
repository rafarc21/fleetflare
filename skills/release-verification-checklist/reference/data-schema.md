# Data schema

A checklist is **data**. `render.ts` is the reusable shell — you never edit it
per-checklist.

```jsonc
{
  "title":    "Staging Verification — <batch>",   // <title> + H1
  "release":  "acme--2026-08-04-staging",       // mono chip; DO room; R2 page key; localStorage key
  "subtitle": "…HTML ok…",
  "password": "test1234",                         // shown in the info banner
  "clientNote": "…HTML ok… (optional)",
  "stats":   [ {"k":"PRs in batch","v":"17"}, {"k":"Deployed","v":"…","ok":true} ],
  "banners": [ {"kind":"good|info|warn","icon":"&check;","html":"…"} ],
  "legend":  [ {"cls":"ready","label":"Verify now"} ],   // optional; sensible default
  "roles": [
    {
      "email": "<role>@<your-domain>",            // see "Credential rows" below
      "name":  "QA (Exampleorg)",
      "items": [
        {
          "pr": 1314,
          "status": "ready|eye|blocked|clean|done|dark",
          "lab":   "one-line what-to-check",
          "where": "/c/$CLIENT/… (mono; the author inlines any variable, not the shell)",
          "verdict": { "k": "clean|eye|blocked|dark", "t": "what the automated pass already proved" },
          "steps": [ "step 1 (HTML ok — <b>, <code>, <span class='expect'|'nb'>)", "…" ]
        }
      ]
    }
  ],
  "footer": "…HTML ok… (what's explicitly NOT in this pass)"
}
```

## Status colours

`ready` / `clean` / `done` = green · `eye` = blue · `blocked` = red ·
`dark` = amber.

Pill labels: `ready`→"verify", `eye`→"eyeball", `blocked`→"blocked/manual",
`clean`→"no action", `done`→"auto-verified", `dark`→"dark launch".

## Credential rows

A role whose `email` starts with the repo's credential prefix renders
**copy-cred buttons** (click to copy email / password). Any other value renders
as a plain note — use that for "no login" or a real named person.

The prefix is currently the literal `editux` (Acme's test-account convention),
checked in `render.ts`'s shell JS. A repo with a different convention should
change that check when it adopts the skill.

## Trusted HTML

`lab`, `steps`, `verdict.t`, `subtitle`, `banners[].html`, `clientNote` and
`footer` are rendered as **author HTML, unescaped**. That is deliberate — it is
how a step embeds `<code>` and `<span class="expect">`. It also means a
checklist is only as trustworthy as whoever wrote its data file. Never build one
from unreviewed external input.

`title` and `release` are treated as text.

## Two footer modes

`render.ts` picks the storage promise at **render time**, from whether
`REVIEW_BASE` + `REVIEW_WRITE_TOKEN` are set:

- worker-bound → "…are **uploaded** to the review worker as you go…"
- pure-local → "Everything saves in **your browser only** … nothing is uploaded."

Baked into the served HTML rather than swapped in by script, so a blocked or
failed script cannot leave a reviewer reading "nothing is uploaded" on a page
that uploads. Greppable check on a worker-bound page:
`grep -c "nothing is uploaded"` must be `0`.

## Reviewer-added content

The page lets a reviewer add their own sections and items for issues the
checklist did not anticipate. Those come back under `addedRoles` / `addedItems`
in `GET /r/:release`. **Triage them too** — they are usually the findings you
did not think to ask for.
