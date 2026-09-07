# The Allotment Ledger

A static site, hosted free on GitHub Pages, that helps Indian IPO applicants
work out how to split PAN cards and money across investor categories to
maximise the chance of winning SEBI's draw-of-lots allotment for a specific
Mainboard or SME IPO.

You tell it:
- how many unique PAN applicants you have, and
- how much total money you're willing to put in,

and it tells you how many PANs to put into each eligible category (Retail /
sNII / bNII on Mainboard, or Individual / NII on SME), how much each should
apply with, and the resulting estimated probability that **at least one**
of your applications gets an allotment.

## How it's put together

```
index.html, style.css, app.js   → the site itself (pure static, no build step)
data/ipos.json                  → cached IPO + subscription data, read by app.js
scripts/scrape.py               → scrapes chittorgarh.com into data/ipos.json
.github/workflows/scrape.yml    → runs scrape.py on a schedule and commits the result
```

**Why a scraper + scheduled commit, instead of fetching chittorgarh.com live
from the browser?** GitHub Pages only serves static files — there's no
server to make same-origin requests through, and chittorgarh.com doesn't
send the CORS headers that would let a visitor's browser fetch it directly.
So a GitHub Action fetches the data server-side every ~20 minutes and
commits `data/ipos.json`; the site then reads that file from its own
domain, same-origin, instantly, for every visitor — one polite scrape per
interval, not one per pageview.

The trade-off: numbers are refreshed every ~20 minutes, not tick-by-tick.
That's stated on the page itself. Subscription figures move fastest in the
last few hours of bidding — for anything time-critical, cross-check the
live number on chittorgarh.com or your broker's app before you actually
apply.

## Setting it up

1. Push this repo to GitHub.
2. **Settings → Pages** → set source to "Deploy from a branch" → `main` /
   `(root)`.
3. **Settings → Actions → General → Workflow permissions** → set to
   "Read and write permissions", so the scheduled workflow can commit
   `data/ipos.json` back to the repo.
4. **Actions tab** → find "Refresh IPO data" → "Run workflow" to trigger
   the first scrape by hand, rather than waiting for the cron. Open the
   resulting commit and skim `data/ipos.json` before trusting it.
5. Before relying on this in production, check
   `https://www.chittorgarh.com/robots.txt` and their Terms of Use, and
   keep the scrape interval (in `.github/workflows/scrape.yml`) long enough
   to be a good citizen — 20–30 minutes is plenty for this use case.

## Being honest about the scraper's reliability

This was built without live network access to test requests against
chittorgarh.com's actual HTML — `scripts/scrape.py` was written defensively
(matching table rows by header text like "Price Band", "Lot Size",
"Subscription (times)", rather than brittle CSS classes) based on the
current page structure, but websites change their markup without notice.
Concretely:

- Run the workflow by hand after first deploying and check the output.
- If a field for a live IPO comes back `null` or missing, chittorgarh has
  likely tweaked something — the relevant `_find_*` / `parse_*` helper in
  `scrape.py` is the place to fix it.
- The site surfaces scraper warnings inline (see the `notes` field per IPO)
  so a partial failure is visible on the page instead of silently wrong.

## The odds model, and its limits

- Each lottery-style category (Retail/Individual, sNII, bNII) is modelled
  as: every valid application is one independent ticket, with a per-ticket
  win probability of roughly `1 / subscription-times` for that category —
  this matches how SEBI's draw-of-lots is commonly explained (e.g. "5 lakh
  applicants for 1 lakh lots ≈ 1-in-5 odds"). It's an approximation: the
  real process is a finite draw without replacement, so true odds shift
  slightly as more lots are handed out, and this also assumes final
  subscription figures won't move much from the last scrape — untrue in
  the closing hours of bidding.
- Applying for more than one lot inside a lottery category does **not**
  improve that ticket's odds, so the optimizer always sizes each
  application at the category's minimum qualifying amount, and instead
  spreads PANs and money across categories/tickets.
- bNII is technically proportionate allotment, only *becoming* a lottery
  once oversubscription pushes the pro-rata share below one lot — this
  tool treats it as lottery-style throughout, which is the common case for
  a heavily-subscribed issue but an approximation for a mildly subscribed
  one.
- QIB is excluded — individuals can't apply in that category.

This is a decision aid, not a guarantee, and isn't affiliated with SEBI,
any exchange, or any registrar.
