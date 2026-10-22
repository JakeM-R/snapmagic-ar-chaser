# SnapMagic AR chaser

Who do we invoice this month, who owes us money this fortnight, and what do I send each of them?

The page runs in two steps. **Month-end billing** turns a contracts file into this month's invoices. **Aging & chasers** runs every two weeks on open invoices. Billed invoices hand straight into the aging run, so the loop is bill, age, chase.

## Step 1: Month-end billing

Upload a contracts CSV (one row per contract, from HubSpot or a Sheet), or use the demo contracts, and pick the month:

1. **Who to bill:** active contracts on their cycle. Monthly bills every month, quarterly every third month from the start month, annual in the start month. Mid-month starts and ends are prorated by day. Usage units × unit price become their own line.
2. **One invoice per customer,** a line per contract, numbered `INV-YYMM-001` onwards, issued on the last day of the month and due on the customer's terms.
3. **Checked before sending:** no billing email, a PO required but missing, a monthly bill that moved 25% or more on last month for no contract reason, duplicate contracts, and bad rows. Contracts ending within 60 days get a renewal note.
4. **Last month to this month:** a waterfall from last month's total to this one, with a reason for every change (new, ended, price change, usage, quarterly or annual bill). It reconciles to the cent.
5. **Outputs:** a cover email per invoice (edit, copy or open in Gmail), a printable invoice (print or save as PDF), a CSV laid out for QuickBooks Online's invoice import, and **Send to aging run**, which adds the invoices to step 2 as open AR.

## Step 2: Aging & chasers

A working prototype by Jake Makking-Robinson for SnapMagic's finance operations remit: "run aging reports every two weeks, answer billing questions." Upload a HubSpot or QuickBooks invoice export (or use the demo data) and the page gives you:

1. **A to-do headline:** customers to chase, total outstanding and the amount over 30 days, with the run date and the next run 14 days out.
2. **Aging by customer:** current, 1–30, 31–60, 61–90 and 90+ buckets, sorted by dollars at risk, with a count of excluded rows (paid, zero or negative balance, missing due date, duplicate invoice #).
3. **Chaser drafts:** one email per customer covering every open invoice, tiered by the oldest overdue invoice. Each draft can be edited, copied or opened in Gmail. Tier 5, accounts over 20% of AR and records with a missing email are flagged "Needs action." Each overdue customer shows when they were last contacted (optional "Last contacted" column), and an Actioned tick clears "Needs action" and logs today as the last contact. Ticks are kept in your browser only.
4. **Slack summary:** a three-line digest for the CEO.
5. **Make it run itself:** a Google Apps Script that applies the same aging and rubric to a Sheet every other Monday, saves Gmail drafts and posts the digest to Slack. Setup takes five steps.

**Demo data is fictional** and labelled on the page and on every row. The customers are generic (Customer A to L), and in demo mode every dollar figure on the page shows as `$xx`. The bars keep their proportions, and an uploaded export shows real amounts. The dates are generated relative to today, so the demo looks the same whenever it's opened.

## Layout

| Path | What |
|---|---|
| `site/ar.js` | Core: CSV parser, column mapper, aging, rubric, templates, validator and Slack digest. Has no DOM or network code, so the same file runs in the browser, in Node tests and in Apps Script. |
| `site/billing.js` | Billing core: contract column mapper, billing cycles, proration, usage, flags, the bridge, QuickBooks import CSV, cover emails and the hand-off to AR. Pure, like `ar.js`, and uses `ar.js` for parsing. |
| `site/demo.js` | Demo data: 30 invoices and 13 contracts across 12 generic customers (A to L), with every edge case seeded. |
| `site/app.js`, `site/index.html` | The page. |
| `site/sheet-runner.js` | Apps Script glue. The page builds `Code.gs` by joining `ar.js` and this file, so the scheduled script uses the same code as the page. |
| `worker/` | Cloudflare Worker that drafts with Claude. Rate-capped, and it builds the prompt itself, so callers can't use it as an open proxy. |
| `tests/billing.test.js` | Billing: cycles, proration, usage, grouping, flags, terms, the bridge reconciling, and the hand-off ageing as open AR. |
| `tests/ar.test.js` | The PRD test set plus checks on the validator, the demo data and the Apps Script. Uses mocked Sheets, Gmail and Slack. |

## How drafting works

Parsing and aging run in the browser. With no Worker configured, the page uses fixed templates for each tier, so an external viewer always gets output. With a Worker configured, the page sends one summary per customer (name, balances, days overdue, invoice list and late history, but no emails or raw rows). Claude writes the body. Every model draft is then checked in the browser against the hard rules:

- Figures, day counts and invoice numbers must come from the input.
- No legal or collections language.
- No fees unless the terms field states one.
- Under 120 words, with no exclamation marks.
- The configured sign-off must be present.

A draft that fails any check is replaced by the template, and the card says why. The subject line is always computed in code.

Template bodies never include the customer name, so a hostile name in the export can't steer the text. The test set includes a prompt-injection case.

### Deploying the Worker

```bash
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

Then put the Worker URL in `<meta name="worker-url">` in `site/index.html`. `ALLOWED_ORIGINS` in `wrangler.toml` limits which pages can call it. The per-IP cap is 10 requests per 10 minutes. To add a hard daily cap of 300 requests, bind a KV namespace as `RATE` (instructions are in `wrangler.toml`).

## Run locally

```bash
node --test tests/*.test.js
python3 -m http.server -d site
```

GitHub Pages deploys `site/` on every push to `main`, after the tests pass.

## Notes and open items

- **Palette:** the values are the PRD's by-eye samples from snapeda.com (orange `#EE8038`, slate navy `#34507A`, indigo `#1F1F6E`, surface `#F5F5F5`/`#E2E2E2`). The build environment couldn't reach snapeda.com, so they haven't been eyedropped yet.
- **Logo:** "Built for SnapMagic" shows as a text wordmark for the same reason. Their unmodified logo file still needs adding to the header.
- **Dates:** slash dates are read as US format (MM/DD/YYYY), as US HubSpot and QuickBooks exports produce them.
- **Late history:** the late-history modifiers need a paid-date column. Without one, tone follows tier.
- **Billing:** the Apps Script automates the aging run only; billing runs on the page. Invoices are numbered per run, so a re-run reuses numbers until QuickBooks takes over numbering. Taxes, discounts and credit notes aren't modelled.
- **Out of scope:** live HubSpot or QuickBooks auth, sending email, DSO trends, multi-currency and payroll.
- **Next (+5 working days):** promise-to-pay tracking. Log a customer's committed date, and the next run checks it before drafting: kept, broken (step up a tier) or pending (skip).
