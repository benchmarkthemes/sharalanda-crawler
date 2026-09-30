# sharalanda-crawler

Crawls the [Shopify Theme Store](https://themes.shopify.com/themes) on a schedule and commits the
results back to this repo. No dependencies — plain Node (22+) using the built-in `fetch`.

## Jobs

| Workflow | Schedule | Script | Output |
| --- | --- | --- | --- |
| Crawl Shopify Theme Store | hourly | `scripts/crawl-theme-store.mjs` | `data/theme-rankings.json` |
| Crawl Shopify Theme Details | daily, 03:30 UTC | `scripts/sync-themeradars.mjs` then `scripts/crawl-theme-details.mjs` | `data/theme-details.json`, `data/themeradars.json` |

Both walk `?page=N` until a page returns no theme cards, so ranking order is document order across
pages. Each writes a `*.meta.json` sibling with the crawl timestamp and counts.

### Rankings (hourly)

Just the leaderboard — array index is theme store position:

```json
["Triumph", "Purevea", "Stack", "Wonder", "Prestige"]
```

### Details (daily)

One object per theme, in ranking order, with the listing card data plus everything scraped from the
card's own page, plus the ThemeRadars cache (the "What's included" feature list is deliberately not
collected):

```jsonc
{
  "position": 5,
  "name": "Prestige",
  "handle": "prestige",
  "url": "https://themes.shopify.com/themes/prestige",
  "price": 400,
  "isFree": false,
  "badge": null,
  "image": "https://cdn.shopify.com/theme-store/....jpg",
  "strapline": "Designed for premium, high-end brand appeal",
  "metaDescription": "Prestige comes with 3 ready-made designs for your store. …",
  "author": "Maestrooo",
  "authorUrl": "/designers/maestrooo",
  "version": "11.4.0",
  "lastUpdated": "July 03, 2026",
  "themeId": 855,
  "presetHandle": "prestige",
  "themeLaunchedAt": "2018-06-01",
  "launchVersion": "1.0.0",
  "releaseCount": 191,
  "presetLaunchedAt": "2018-06-01",
  "presetLaunchedAtSource": "default-preset",
  "themeRadars": {
    "id": "prestige-prestige",
    "author": "Maestrooo",
    "authorCountry": "France",
    "categories": ["bags"],
    "rating": "91%",
    "status": "Activated",
    "isNew": false,
    "currentRank": 31, "previousRank": 473, "rankChange": 461,
    "currentReviews": 868, "reviewsChange": 0,
    "firstSeenAt": "2025-07-18T03:53:17.918Z"
  },
  "usps": [{ "title": "Shine like a diamond", "description": "Expertly crafted to …" }],
  "presets": ["Prestige", "Couture", "Vogue", "Strass", "Signature"],
  "presetCount": 5,
  "reviews": { "positiveRate": 91, "count": 859, "breakdown": { "positive": 781, "neutral": 14, "negative": 64 } }
}
```

A non-default preset with a known launch date carries the preset's own date instead:

```jsonc
{
  "name": "Strass",
  "handle": "prestige",
  "presetHandle": "strass",
  "themeLaunchedAt": "2018-06-01",
  "presetLaunchedAt": "2026-03-06",
  "presetLaunchedAtSource": "release-note",
  "presetLaunchedAtVersion": "11.0.0"
}
```

`themeLaunchedAt` is the date of the theme's oldest release, read from its version-history modal
(`…/presets/<preset>/modal_version_details`, which needs `Accept: */*` — it 404s on `text/html`).
That is usually when `1.0.0` went live, but some long-standing themes have no `1.0.0` in their
history — Dawn's oldest entry is `2.0.0` (2021-08-31) and District's is `2.0.0` (2017-01-17) — so
the oldest release is used instead and `launchVersion` records which version that was. The modal is
theme-wide (every preset of a theme returns byte-identical history), so it is fetched once per theme
— ~344 requests rather than one per card.

A theme whose detail page fails after retries still gets a row — with the listing card fields and an
`error` string — so one bad page doesn't lose a ranking slot. If more than 10% of detail pages fail,
the run aborts without writing, on the assumption that the markup changed rather than the data.

## Running locally

```bash
node scripts/crawl-theme-store.mjs    # ~1 min
node scripts/crawl-theme-details.mjs  # ~20 min (~1,225 cards + ~344 histories)
THEMERADARS_API_KEY=... node scripts/sync-themeradars.mjs   # ~2 min, spends API quota
THEMERADARS_BUDGET=0 node scripts/sync-themeradars.mjs      # recompute, no quota spent
```

## Notes

- Parsing is regex-based against the theme store's server-rendered HTML. The selectors live in
  `scripts/lib/theme-store.mjs` and the `parse*` functions in `scripts/crawl-theme-details.mjs`;
  a store redesign is the thing most likely to break a run.
- Requests are throttled (750ms between listing pages; 2 workers with a 700ms gap for detail pages).
  The store starts returning 429 above roughly 2 requests/second. A 429 or 5xx trips a *shared*
  cooldown — every worker waits, honouring `Retry-After` when sent — before retrying.
- Both workflows need **Settings → Actions → General → Workflow permissions** set to *Read and
  write* so the bot can commit results.

## Themes vs presets — and the two launch dates

Most listing cards are **presets**, not themes: the store has ~344 themes across ~1,300 presets, and
959 presets have a handle that differs from their parent theme's. So "Swirl" is a preset of `eurus`,
and "Bijou" a preset of `allure`. Two separate fields keep this honest:

- **`themeLaunchedAt`** — the parent theme's launch, from the oldest entry in its version history.
  Always populated. Shared by every preset of that theme.
- **`presetLaunchedAt`** — when *this preset* launched. **Null unless genuinely known**, so a consumer
  can tell the difference rather than showing a theme's date as a preset's.

`presetLaunchedAtSource` says where the date came from, in the order they are preferred:

| Source | Meaning | Accuracy |
| --- | --- | --- |
| `default-preset` | The preset the theme launched with, so its date *is* the theme's | Exact |
| `release-note` | The developer announced it ("…introduce Strass, a new preset…") | Exact, with `presetLaunchedAtVersion` |
| `themeradars-first-seen` | ThemeRadars first observed the preset on this date | Within a few days |
| `null` | Predates every available source | Unknown |

### Why ThemeRadars dates have a floor

`createdAt` from the API is **when ThemeRadars first saw a preset, not when it launched**. They
imported the whole store on **2025-07-18** — 309 of the first 403 cached entries carry that exact
date — so anything on or before it means only "existed by then". Prestige's own preset reports
2025-07-18 against a real launch of 2018-06-01, while Strass reports 2026-03-10 against a real
2026-03-06. Only dates strictly after the import day are used, and `scripts/sync-themeradars.mjs`
derives that floor from the biggest single-day spike rather than hardcoding it.

Release notes are the only source reaching back before the import, covering roughly a third of
non-default presets — which is why both sources are kept.

## ThemeRadars API

Set `THEMERADARS_API_KEY` as a repository secret (**Settings → Secrets and variables → Actions**).
The sync step is skipped when the secret is absent, and the crawl still runs without it.

The free tier allows **100 requests/day** and 60/minute, against ~1,300 presets, so a daily full
refresh is impossible. Instead:

1. The list endpoint (4 requests) refreshes all ~317 master themes — the default presets — including
   live rank and review deltas.
2. The remaining budget backfills presets never seen before, one request each.

Launch dates are immutable, so each preset only needs fetching once: the initial backfill takes about
12 days, after which only brand-new presets consume quota. The cache lives in `data/themeradars.json`
and is committed, so progress survives between runs. `THEMERADARS_BUDGET=0` recomputes the derived
fields from the cache without spending any quota.

Non-default presets are absent from the list endpoint but retrievable individually at
`/themes/{theme}-{preset}`; the ids come from the store's own sitemap.
