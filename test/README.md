# Smoke harness

`node test/smoke.mjs` stubs the DOM, `window.supabase` and `location`, evaluates `app.js` against
them, lets it sign in and load, then drives it by firing the hashchange listeners it registered.
Every query goes to the **real** database, so the pages render the figures the site renders.
Writes are stubbed — the harness reads production and must never change it.

```sh
export $(grep -E '^SUPABASE_(URL|SERVICE_ROLE_KEY)=' ../family-office-agentic-orchestration/.env | xargs)
node test/smoke.mjs
```

The key is read from the environment and is never committed here.

| Flag | Effect |
| --- | --- |
| `--route '#stan/<id>'` | walk one route only, skip the interaction tests |
| `--dump` | write the rendered page to `../family-office-agentic-orchestration/preview/_page.html` |
| `--empties` | list every empty state rendered |

## Why the assertions look like this

Almost every bug this site has had rendered as a **plausible number**, not an error:

- a contribution table summing to 200%, because a dated set was loaded without filtering to the newest run
- a 5-year CAGR of +466% from a stub price before a fund traded
- tabs that drew correctly and did nothing, because the handler was never wired
- a monthly grid that silently blanked when its table crossed PostgREST's 1000-row cap
- two tables truncated for weeks with no symptom at all, found by the cap check on this file's first run

None of those throw. So the assertions are mostly about **internal agreement** — a total matching
its parts, a figure matching the same figure elsewhere on the page, a control actually changing
what it claims to change. That is the shape these failures take.

Specifically it checks that: every route renders without a loading state or load error and with no
literal `undefined`/`NaN`/`[object Object]`; no unranged query comes back at the 1000-row cap;
retired hashes still redirect; the scatter plots and its tabs change it; staging a classification
previews before saving; contribution totals ~100%; each donut wedge's ticker weights add to the
wedge; the monthly grid's current year equals the trailing YTD on the same card; the breakdown's
allocation column totals 100% of resolved equity; Annie's scorecard agrees with itself, an ungraded
model shows dashes rather than zeroes, and the equity curve draws one hover target per trade;
Sven's matrix carries every index and its news window switches.

## Adding a check

Prefer one that would have caught a real bug, and assert agreement rather than existence. "The
table rendered" passes while the numbers are wrong; "the total equals its rows" does not.
