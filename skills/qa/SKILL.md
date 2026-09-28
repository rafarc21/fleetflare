---
name: qa
description: Unified quality gate for all deliveries. Validates tracking, page quality, site-wide checks, and e-commerce funnel flows with evidence production. Replaces cro-validate.
---

# QA

Unified quality gate for every delivery — CRO variants, new pages, or full site launches.
All checks must pass before a delivery is considered complete.

## Scopes

Scopes nest. Each includes everything from the scope above it.

| Scope | When to use | What it adds |
|-------|-------------|--------------|
| `tracking` | Verify Zaraz events fire correctly | Event interception, parameter validation, dedup check |
| `page` | Single page delivery or CRO variant | Console errors, links, meta, favicon, responsive, headings, alt text, a11y, Lighthouse, visual check |
| `site` | Full site delivery | Navigation, footer, SEO, sitemap, Shopify data accuracy, forms, custom widgets, store policies |
| `funnel` | E-commerce site delivery | Add to cart, cart, checkout, discount codes, e2e checkout with real payment, tracking values, auto-refund |

## Prerequisites

- **agent-browser** installed: `bun install -g agent-browser && agent-browser install`
- **Dev server** running: `bun run dev` (or production URL for live site QA)
- **GitHub MCP** configured (for issue management)
- **ffmpeg** installed: `brew install ffmpeg` (for video conversion)
- For `funnel` scope: `SHOPIFY_ADMIN_API_TOKEN` in `.env` with scopes: `read_orders`, `write_orders`, `read_discounts`, `write_discounts`, `write_files`, `read_files`
- For evidence upload: same Shopify Admin API token (uses `write_files`)

## Input

The operator specifies:
- **scope**: `tracking`, `page`, `site`, or `funnel`
- **target**: URL to test (defaults to `http://localhost:4321`)
- **pages** (for `page` scope): specific page path(s) to test (defaults to all pages in `src/pages/`)

Read `client.json` for:
- `type` — determines which event table to use (ecommerce vs leadgen)
- `tracking` — GA4/Meta/Google Ads IDs for event verification
- `shopify` — store URL for data accuracy checks and Admin API calls
- `qa.features` — client-specific widgets to verify
- `qa.testProduct` — product to use for funnel test
- `qa.discountCodePrefix` — prefix for QA discount codes

## Setup

1. Create `evidence/` directory in project root (gitignored)
2. Start video recording: `agent-browser record start ./evidence/qa-session.webm`
3. Open the target URL: `agent-browser open <target>`
4. Verify the page loads: `agent-browser wait --load networkidle`

## Scope: tracking

Verify all Zaraz tracking events fire correctly with the right parameters.

### Checks

For each page in the site (or the specified page):

**T1. Page view event fires on load**
- `agent-browser open <page-url>`
- Wait for network idle
- Check network requests for `cdn-cgi/zaraz/` calls
- Verify `page_view` event fires with correct page path parameter

**T2. Interactive elements have Zaraz attributes**
- `agent-browser snapshot -i` to get the page structure
- Verify all `<a>`, `<button>`, `<form>` elements that are conversion-relevant have `data-zaraz-event` attributes
- Cross-reference against the canonical event table for the client type (ecommerce or leadgen — see `docs/platform-spec.md`)

**T3. Events fire on interaction**
- For each interactive element with `data-zaraz-event`:
  - `agent-browser click <ref>` (or `fill` + `submit` for forms)
  - Monitor network requests for the corresponding Zaraz/GA4/Meta event
  - Verify event name and parameters match expectations
  - `agent-browser screenshot --annotate ./evidence/tracking-<event-name>.png`

**T4. No duplicate events**
- Verify each action fires exactly one event per platform (no double-counting)
- Check Meta Pixel deduplication (event_id parameter present)

**T5. No unexpected events**
- Verify no extra events fire beyond what's in the canonical event table
- Flag any unknown event names

**T6. A/B test variant parameter (if applicable)**
- If `ab-tests.json` has active tests, verify `test_variant` parameter is set on relevant events
- Value should match the assigned variant ID

### Pass criteria
ALL events for the client type fire correctly with correct parameters. No duplicates. No unexpected events.

## Scope: page

Everything in `tracking` scope, plus the following checks per page.

### Checks

**P1. No console errors**
- Navigate to the page
- Capture all console messages
- Filter out known benign errors (favicon 404, browser extension noise)
- FAIL if any real console errors remain
- `agent-browser screenshot --annotate ./evidence/page-console.png`

**P2. All links and buttons work**
- `agent-browser snapshot -i` to get all `<a>` and `<button>` elements
- For each link: verify `href` is not empty, not `#`, and not a dead link
- For internal links: `agent-browser click <ref>`, verify navigation succeeds (no 404)
- For external links: verify the URL is well-formed (do not follow — just validate format)
- For buttons: verify they are not disabled and have an accessible label

**P3. Meta title and description**
- Verify `<title>` tag exists and is not empty
- Verify `<meta name="description">` exists and is not empty
- Verify title length is 30-60 characters (SEO best practice)
- Verify description length is 120-160 characters

**P4. Favicon**
- Verify `<link rel="icon">` or `<link rel="shortcut icon">` exists
- Verify the favicon URL returns 200

**P5. Desktop layout (1280px)**
- `agent-browser resize 1280 800`
- Verify `document.documentElement.scrollWidth <= document.documentElement.clientWidth` (no horizontal scroll)
- `agent-browser screenshot --annotate ./evidence/page-desktop.png`

**P6. Tablet layout (768px)**
- `agent-browser resize 768 1024`
- `agent-browser screenshot --annotate ./evidence/page-tablet.png`
- Visual check: content adapts, no overlapping elements, touch targets are adequate

**P7. Mobile layout (375px)**
- `agent-browser resize 375 812`
- Verify text is readable (font sizes >= 14px for body text)
- Verify no elements overflow the viewport
- `agent-browser screenshot --annotate ./evidence/page-mobile.png`

**P8. No overlapping or cut-off elements**
- At each breakpoint (1280, 768, 375), take screenshots
- AI visual analysis: check for overlapping text, cut-off images, elements extending beyond viewport
- This is a judgment call — flag anything suspicious

**P9. Heading hierarchy**
- Extract all heading elements (H1-H6)
- Verify exactly one H1 per page
- Verify headings follow logical order (no skipping levels, e.g., H1 → H3)

**P10. Image alt text**
- Find all `<img>` elements
- Verify each has a non-empty `alt` attribute
- Flag decorative images that should have `alt=""`

**P11. Accessibility checks**
- **Keyboard navigation**: Tab through all interactive elements, verify visible focus indicators
- **Color contrast**: Run Lighthouse accessibility audit, verify score > 90
- **ARIA labels**: Check custom components (modals, dropdowns, carousels) have appropriate ARIA attributes

**P12. Lighthouse scores**
Run Lighthouse via agent-browser or CLI:
```bash
bunx lighthouse <page-url> --output=json --output-path=./evidence/lighthouse.json --quiet --chrome-flags="--headless"
```
Required:
- Performance > 90
- Accessibility > 90

Extract scores from JSON output. Screenshot the Lighthouse report.

**P13. Images and assets optimized**
- Check image file sizes via Lighthouse audit
- Verify images use CDN URLs (Shopify CDN or Cloudflare)
- Check for lazy loading on below-fold images (`loading="lazy"`)

**P14. No large unused scripts**
- Check Lighthouse "Unused JavaScript" and "Unused CSS" audits
- Flag any bundles over 100KB with >50% unused code

### Pass criteria
All checks pass. Lighthouse Performance > 90, Accessibility > 90.

## Scope: site

Everything in `page` scope applied to ALL pages, plus the following site-wide checks.

### Page discovery

1. Read `src/pages/` directory to find all `.astro` page files
2. Map file paths to URL paths (e.g., `src/pages/products/[handle].astro` → need product handles from Shopify)
3. Also fetch `/sitemap.xml` and extract all URLs
4. Union both lists — test every unique URL

### Checks

**S1. Main navigation**
- Click each nav item, verify it navigates to the correct page
- Verify the current page is highlighted (active state) in the nav
- `agent-browser screenshot --annotate ./evidence/site-nav.png`

**S2. Mobile navigation**
- `agent-browser resize 375 812`
- Click hamburger/menu icon, verify menu opens
- Verify menu items are visible and clickable
- Click hamburger again (or outside), verify menu closes
- `agent-browser screenshot --annotate ./evidence/site-mobile-nav.png`

**S3. Dropdowns and submenus**
- Identify any nav items with dropdowns (hover or click triggered)
- Trigger each dropdown, verify subitems display
- Click a subitem, verify navigation

**S4. Footer links**
- Find all links in `<footer>`
- Verify each link works (navigate, verify no 404)
- Verify store policies are linked (shipping, returns, privacy) — check for links containing "policy", "shipping", "returns", "privacy", "terms"

**S5. Unique meta per page**
- Collect `<title>` and `<meta name="description">` from every page
- Verify no two pages share the same title
- Verify no two pages share the same description

**S6. Canonical URLs**
- Verify every page has `<link rel="canonical">` pointing to itself (or the correct canonical)

**S7. Open Graph and Twitter Card tags**
- Verify every page has: `og:title`, `og:description`, `og:image`, `og:url`
- Verify every page has: `twitter:card`, `twitter:title`, `twitter:description`

**S8. Sitemap and robots.txt**
- Fetch `<target>/sitemap.xml` — verify 200 response, valid XML, contains all pages
- Fetch `<target>/robots.txt` — verify 200 response, contains `Sitemap:` directive

**S9. Shopify data accuracy** (ecommerce clients only)
- Query Shopify Storefront API for products and collections
- For each product page: compare displayed title, price, images, variants against API data
- For each collection page: compare listed products against API data
- Flag any mismatches (stale data, wrong prices, missing products)

**S10. Forms**
- For each form on the site (contact, newsletter, account):
  - **Submit with valid data**: fill all fields with test data, submit, verify success message
  - **Submit with invalid data**: leave required fields empty, verify validation messages appear
  - **Submit with bad email**: enter malformed email, verify validation catches it
  - `agent-browser screenshot --annotate ./evidence/site-form-<name>.png`

**S11. Custom widgets** (from `client.json` → `qa.features`)
- For each feature in `qa.features`:
  - Navigate to the specified page(s)
  - Verify the element matching `selector` is visible and non-empty
  - Take a screenshot
  - AI visual check: does the widget look correct and functional?

**S12. Dynamic checkout buttons**
- On product pages and cart page, verify dynamic payment buttons render (PayPal, Shop Pay, etc.)
- These come from Shopify's checkout SDK — verify they load

### Pass criteria
All checks pass across all pages. No data mismatches with Shopify. All forms work. All widgets render.

## Scope: funnel

Everything in `site` scope, plus end-to-end checkout flow testing.

### Prerequisites

- `SHOPIFY_ADMIN_API_TOKEN` in `.env` with scopes: `read_orders`, `write_orders`, `read_discounts`, `write_discounts`, `write_files`, `read_files`
- `SHOPIFY_STORE_URL` in `.env` (e.g., `mystore.myshopify.com`)
- `qa.testProduct` configured in `client.json`
- A payment method configured on the Shopify store (Shopify Payments test mode recommended)

### Checks

**F1. Add to cart**
- Navigate to the test product page
- Select a variant (if applicable)
- Click add-to-cart button
- Verify cart updates (item count badge, cart drawer opens, etc.)
- Verify tracking: `add_to_cart` event fires with correct product data and value
- `agent-browser screenshot --annotate ./evidence/funnel-add-to-cart.png`

**F2. Cart functionality**
- Open cart (drawer or page)
- Verify correct product, quantity, and price displayed
- Change quantity: verify totals update
- Add another item: verify cart shows both items with correct total
- Remove an item: verify cart updates
- `agent-browser screenshot --annotate ./evidence/funnel-cart.png`

**F3. Cart drawer/mini-cart**
- If the site uses a cart drawer:
  - Verify it opens when items are added
  - Verify it displays correct items, quantities, and totals
  - Verify the checkout button is present and visible

**F4. Checkout redirect**
- Click the checkout button
- Verify the browser navigates to Shopify checkout (URL contains `checkout.shopify.com` or the store's checkout domain)
- `agent-browser screenshot --annotate ./evidence/funnel-checkout-redirect.png`

**F5. E2E checkout flow with 99% discount**

This is the full end-to-end test. Record video for the entire flow.

```
agent-browser record start ./evidence/funnel-e2e.webm
```

**Step 1 — Create discount code** (Shopify Admin API):
```graphql
mutation {
  discountCodeBasicCreate(basicCodeDiscount: {
    title: "QA Test 99% Off"
    code: "<QA_PREFIX>-<timestamp>"
    startsAt: "<now>"
    endsAt: "<now + 24h>"
    customerGets: {
      value: { percentage: 0.99 }
      items: { all: true }
    }
    customerSelection: { all: true }
    usageLimit: 1
    appliesOncePerCustomer: true
  }) {
    codeDiscountNode { id }
    userErrors { field message }
  }
}
```
Save the discount code ID for cleanup. Use `qa.discountCodePrefix` from `client.json` as the prefix.

**Step 2 — Navigate to product page:**
- `agent-browser open <target>/<test-product-path>`
- Verify product loads with correct data

**Step 3 — Add to cart:**
- Click add-to-cart
- Verify cart updates

**Step 4 — Go to checkout:**
- Click checkout button
- Wait for Shopify checkout to load: `agent-browser wait --url "*checkout*"`
- `agent-browser screenshot --annotate ./evidence/funnel-checkout.png`

**Step 5 — Apply discount code:**
- Find the discount code input field
- `agent-browser fill <discount-input-ref> "<discount-code>"`
- Submit the discount
- Verify the discount is applied (total reflects ~99% reduction)
- `agent-browser screenshot --annotate ./evidence/funnel-discount-applied.png`

**Step 6 — Fill shipping information:**
- Fill email: `qa-test@<client-domain>` (or a test email from client.json)
- Fill shipping address with test data:
  - Name: "QA Test"
  - Address: "123 Test St"
  - City: "Test City"
  - State/Province: select first available
  - Zip: "10001" (or appropriate for country)
  - Country: "United States" (or client's country)
- Continue to shipping method
- Select first available shipping method
- Continue to payment

**Step 7 — Complete payment:**
- If Shopify Payments test mode:
  - Card number: `4242 4242 4242 4242`
  - Expiry: any future date (e.g., `12/28`)
  - CVC: `123`
  - Name: "QA Test"
- Click "Pay now" / "Complete order"
- Wait for thank you page: `agent-browser wait --url "*thank_you*" --timeout 30000`
- `agent-browser screenshot --annotate ./evidence/funnel-thank-you.png`

**Step 8 — Capture order details from thank you page:**
- Extract order number from the page
- Extract order total (should be ~1% of product price)
- `agent-browser get text <order-number-ref>` to capture the order number

**Step 9 — Verify tracking values:**
- Verify `purchase` event fired during checkout
- Verify the `value` parameter matches the actual charged amount (~1% of product price), NOT the pre-discount price
- Verify `transaction_id` matches the Shopify order number
- Verify `items` array contains the correct product(s)

**Step 10 — Stop recording:**
```
agent-browser record stop
```

**Step 11 — Refund the order** (Shopify Admin API):

First, query the order by number to get the order ID and line item IDs:
```graphql
query {
  orders(first: 1, query: "name:#<order-number>") {
    nodes {
      id
      name
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 10) {
        nodes { id quantity }
      }
    }
  }
}
```

Then calculate the suggested refund:
```graphql
query {
  order(id: "<order-gid>") {
    suggestedRefund(suggestFullRefund: true) {
      amountSet { shopMoney { amount currencyCode } }
      refundLineItems {
        lineItem { id }
        quantity
      }
    }
  }
}
```

Then create the refund:
```graphql
mutation {
  refundCreate(input: {
    orderId: "<order-gid>"
    notify: false
    note: "Automated QA refund — test order"
    shipping: { fullRefund: true }
    refundLineItems: [
      { lineItemId: "<line-item-gid>", quantity: 1, restockType: NO_RESTOCK }
    ]
  }) {
    refund {
      id
      totalRefundedSet { shopMoney { amount currencyCode } }
    }
    userErrors { field message }
  }
}
```

**Step 12 — Cancel the order** (optional, after refund):
```graphql
mutation {
  orderCancel(
    orderId: "<order-gid>"
    reason: OTHER
    notifyCustomer: false
    refund: false
    restock: false
    staffNote: "Automated QA cancellation — test order"
  ) {
    orderCancelUserErrors { field message }
  }
}
```

**Step 13 — Delete the discount code:**
```graphql
mutation {
  codeDiscountDelete(id: "<discount-gid>") {
    deletedCodeDiscountId
    userErrors { field message }
  }
}
```

### Pass criteria
Full checkout completes. Payment processes. Tracking values match charged amount. Refund succeeds. Cleanup completes.

## Evidence Production

### During checks
- Take annotated screenshots at key moments: `agent-browser screenshot --annotate ./evidence/<name>.png`
- Record video for complex flows (funnel scope): `agent-browser record start/stop`

### After all checks
1. Stop any active recording
2. Convert WebM videos to MP4:
   ```bash
   ffmpeg -i ./evidence/<name>.webm -c:v libx264 -pix_fmt yuv420p ./evidence/<name>.mp4
   ```
3. Upload all evidence files to Shopify CDN:

   **Step A — Create staged upload:**
   ```graphql
   mutation {
     stagedUploadsCreate(input: [
       {
         filename: "<filename>"
         mimeType: "<image/png or video/mp4>"
         fileSize: "<bytes>"
         resource: <IMAGE or VIDEO>
         httpMethod: POST
       }
     ]) {
       stagedTargets {
         url
         resourceUrl
         parameters { name value }
       }
       userErrors { field message }
     }
   }
   ```

   **Step B — Upload file to staged URL** (multipart POST with returned parameters)

   **Step C — Register file:**
   ```graphql
   mutation {
     fileCreate(files: [
       {
         alt: "QA evidence — <check-name>"
         contentType: <IMAGE or VIDEO>
         originalSource: "<resourceUrl from step A>"
       }
     ]) {
       files {
         id
         fileStatus
         ... on MediaImage { image { url } }
         ... on Video { sources { url mimeType } }
       }
       userErrors { field message }
     }
   }
   ```

   **Step D — Poll until READY:**
   Query the file by ID until `fileStatus` is `READY`. Collect the CDN URL.

4. Include CDN URLs in the QA report

### Size limits
- Images: max 20MB per file
- Videos: max 1GB, max 10 minutes, max 4096x4096

## Issue Management

When QA finds failures, create GitHub issues for tracking and visibility.

### On failure
For each failed check:
```bash
gh issue create \
  --title "QA: <check-name> failed — <short description>" \
  --body "<details of failure, expected vs actual, screenshot link>" \
  --label "qa" \
  --label "<scope>"
```

### Fixing flow
1. All failures logged as GitHub issues with label `qa`
2. Agent picks an issue, adds "in progress" label
3. Agent fixes the issue
4. Agent re-runs just that check to verify the fix
5. If fixed: agent closes the issue with a comment linking to the evidence
6. If not fixable (external dependency, needs human decision): agent adds "blocked" label and a comment explaining why
7. After all issues addressed: full regression pass (re-run the entire scope)

### GitHub Project board
If a GitHub Project board exists for the repo, add QA issues to it automatically:
```bash
gh project item-add <project-number> --owner <org> --url <issue-url>
```

## QA Report

After all checks complete (and any fixes are applied), generate the QA report.

### Format

```markdown
# QA Report — <domain>

**Date:** <date>
**Tested URL:** <url>
**Scope:** <scope>
**Result:** <passed>/<total> PASS
**Duration:** <time>

---

## Evidence Summary

| # | Check | Result | Screenshot | Video |
|---|-------|--------|------------|-------|
| T1 | Page view event fires | PASS | [view](cdn-url) | — |
| T2 | Zaraz attributes present | PASS | [view](cdn-url) | — |
| ... | ... | ... | ... | ... |
| F5 | E2E checkout flow | PASS | [view](cdn-url) | [watch](cdn-url) |

## E2E Funnel Summary

_(funnel scope only)_

| Detail | Value |
|--------|-------|
| Product tested | <product name> ($<price>) |
| Discount code | <code> (99% off) |
| Amount charged | $<amount> |
| Shopify order | #<number> |
| Tracking events | page_view, view_item, add_to_cart, begin_checkout, purchase |
| Purchase event value | $<amount> (matches charged amount) |
| Refund processed | Yes (notify: false, restock: none) |
| Order cancelled | Yes |
| Discount deleted | Yes |

## Issues Found & Resolved

- [FIXED] <description> — [GH issue #N](link)
- [FIXED] <description> — [GH issue #N](link)

## Issues Requiring Human Attention

- [BLOCKED] <description> — [GH issue #N](link)

## Notes

<any additional observations or recommendations>
```

### Output

Save the report to `evidence/qa-report.md` in the client repo.
Output the full report to the terminal so the operator can review.

## Output File

### `evidence/validation.json`

```json
{
  "validatedAt": "<ISO timestamp>",
  "scope": "<tracking|page|site|funnel>",
  "target": "<URL tested>",
  "result": "pass|fail",
  "summary": {
    "total": 44,
    "passed": 44,
    "failed": 0,
    "blocked": 0
  },
  "checks": [
    {
      "id": "T1",
      "name": "Page view event fires",
      "scope": "tracking",
      "passed": true,
      "evidence": {
        "screenshot": "<cdn-url or local path>",
        "video": null
      },
      "notes": ""
    }
  ],
  "funnel": {
    "orderId": "<shopify-order-gid>",
    "orderNumber": "#1234",
    "amountCharged": "0.50",
    "discountCode": "QA-TEST-1710835200",
    "refunded": true,
    "cancelled": true,
    "discountDeleted": true
  },
  "issues": {
    "created": ["<gh-issue-url>"],
    "fixed": ["<gh-issue-url>"],
    "blocked": []
  }
}
```

## Failure Handling

- **Single check fails**: Log it, create GitHub issue, continue to next check (do NOT fail-fast for QA — we want the full picture)
- **Multiple failures**: After completing all checks, report all failures. Begin fixing from highest severity.
- **Shopify API errors**: Retry once with exponential backoff. If still failing, mark the check as `blocked` and continue.
- **agent-browser crashes**: Restart the browser session (`agent-browser close && agent-browser open <url>`), retry the check once.
- **Funnel test payment fails**: Log the error, skip remaining funnel checks, mark all as `blocked`. Do NOT leave orphan discount codes — always attempt cleanup.

## Invocation

Operator says:
- "Run QA tracking" → scope: tracking
- "Run QA on /products/widget" → scope: page, target: that page
- "Run full QA" → scope: site
- "Run QA funnel" → scope: funnel
- "QA this page" → scope: page, target: current page

When invoked from the CRO orchestrator: scope is always `page`, target is the variant page.

## Reference

- `docs/platform-spec.md` — canonical event tables, client.json schema
- `playbooks/tracking-validation.md` — tracking validation methodology
- `configs/zaraz-base.json` — Zaraz trigger/tool configuration
- Shopify Admin API: `refundCreate`, `orderCancel`, `discountCodeBasicCreate`, `stagedUploadsCreate`, `fileCreate`
