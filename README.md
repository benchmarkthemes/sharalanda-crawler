# sharalanda-crawler

Crawls the [Shopify Theme Store](https://themes.shopify.com/themes) on a schedule and commits the
results back to this repo. No dependencies — plain Node (22+) using the built-in `fetch`.

## Jobs

| Workflow | Schedule | Script | Output |
| --- | --- | --- | --- |
| Crawl Shopify Theme Store | hourly | `scripts/crawl-theme-store.mjs` | `data/theme-rankings.json` |
| Crawl Shopify Theme Details | daily, 03:30 UTC | `scripts/crawl-theme-details.mjs` | `data/theme-details.json` |

Both walk `?page=N` until a page returns no theme cards, so ranking order is document order across
pages. Each writes a `*.meta.json` sibling with the crawl timestamp and counts.

### Rankings (hourly)

Just the leaderboard — array index is theme store position:

```json
["Triumph", "Purevea", "Stack", "Wonder", "Prestige"]
```

### Details (daily)

One object per theme, in ranking order, with the listing card data plus everything scraped from the
theme's own page (the "What's included" feature list is deliberately not collected):

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
  "usps": [{ "title": "Shine like a diamond", "description": "Expertly crafted to …" }],
  "presets": ["Prestige", "Couture", "Vogue", "Strass", "Signature"],
  "presetCount": 5,
  "reviews": { "positiveRate": 91, "count": 859, "breakdown": { "positive": 781, "neutral": 14, "negative": 64 } }
}
```

A theme whose detail page fails after retries still gets a row — with the listing card fields and an
`error` string — so one bad page doesn't lose a ranking slot. If more than 10% of detail pages fail,
the run aborts without writing, on the assumption that the markup changed rather than the data.

## Running locally

```bash
node scripts/crawl-theme-store.mjs    # ~1 min
node scripts/crawl-theme-details.mjs  # ~15 min (~1,200 detail pages)
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
