#!/usr/bin/env node
/**
 * Keeps data/themeradars.json in sync with the ThemeRadars API.
 *
 * The free tier allows 100 requests/day, and there are ~1,300 presets, so this
 * cannot refetch everything daily. Instead:
 *
 *   1. The list endpoint (4 requests) refreshes every master theme — i.e. each
 *      theme's default preset — including live rank and review deltas.
 *   2. The remaining budget backfills presets we have never seen, one request
 *      each. Launch dates never change, so each preset only needs fetching
 *      once; after the initial ~10 day backfill only brand-new presets remain.
 *
 * Output: data/themeradars.json (committed, and the input the detail crawl
 *         merges from)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fetchHtml } from './lib/theme-store.mjs';
import { ThemeRadars, QuotaExhausted, pickFields } from './lib/themeradars.mjs';

const OUT_DIR = path.resolve('data');
const CACHE_PATH = path.join(OUT_DIR, 'themeradars.json');
const SITEMAP_URL = 'https://themes.shopify.com/sitemap_theme_en.xml';
const BUDGET = Number(process.env.THEMERADARS_BUDGET ?? 90);

async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } catch {
    return { entries: {} };
  }
}

/** Every `<theme handle>-<preset handle>` pair the store publishes. */
async function listPresetIds() {
  const xml = await fetchHtml(SITEMAP_URL, { accept: 'application/xml,text/xml,*/*' });
  if (!xml) throw new Error('could not fetch the theme sitemap');

  const ids = [];
  const re = /<loc>https:\/\/themes\.shopify\.com\/themes\/([^/<]+)\/presets\/([^<]+)<\/loc>/g;
  for (const [, theme, preset] of xml.matchAll(re)) {
    ids.push({ id: `${theme}-${preset}`, theme, preset });
  }
  if (ids.length === 0) throw new Error('sitemap contained no preset URLs');
  return ids;
}

/**
 * ThemeRadars imported the whole store in one go when they started, so a large
 * share of entries carry that single import date rather than a launch date. The
 * import day is therefore the floor: createdAt on or before it tells us only
 * "existed by then". A few stray records predate the import, so take the day
 * with the biggest spike rather than the earliest date.
 */
export function trackingFloor(entries) {
  const byDay = new Map();
  for (const e of Object.values(entries)) {
    if (!e.createdAt) continue;
    const day = e.createdAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  if (byDay.size === 0) return null;

  const [spikeDay, spikeCount] = [...byDay].sort((a, b) => b[1] - a[1])[0];
  const total = [...byDay.values()].reduce((a, b) => a + b, 0);
  // A genuine bulk import dwarfs normal daily discovery; without one, fall back
  // to the earliest date seen.
  if (spikeCount / total < 0.05) return [...byDay.keys()].sort()[0];
  return spikeDay;
}

async function main() {
  const cache = await loadCache();
  const entries = cache.entries ?? {};
  // Budget 0 recomputes the derived fields from the cache without calling the API.
  const recomputeOnly = BUDGET <= 0;
  const api = recomputeOnly ? null : new ThemeRadars({ budget: BUDGET });

  const before = Object.keys(entries).length;
  console.log(
    recomputeOnly
      ? `Cache holds ${before} presets. Recomputing derived fields only.`
      : `Cache holds ${before} presets. Budget: ${BUDGET} requests.`,
  );

  let listed = 0;
  let backfilled = 0;
  let missing = 0;
  let quotaHit = false;

  if (!recomputeOnly) try {
    // 1. Refresh every master theme (default presets) — cheap and keeps rank
    //    and review deltas current.
    const { rows, meta } = await api.listAll();
    listed = rows.length;
    console.log(`Listed ${listed} master themes (meta.total ${meta?.total ?? '?'}).`);
    for (const row of rows) {
      if (!row?.id) continue;
      entries[row.id] = { ...pickFields(row), fetchedAt: new Date().toISOString() };
    }

    // 2. Spend what is left on presets we have never fetched.
    const all = await listPresetIds();
    const pending = all.filter(({ id }) => !entries[id]);
    console.log(`${pending.length} presets not yet cached; ${api.remaining} requests left.`);

    for (const { id, theme, preset } of pending) {
      if (api.remaining <= 0) break;
      const row = await api.getTheme(id);
      if (row) {
        entries[id] = { ...pickFields(row), fetchedAt: new Date().toISOString() };
        backfilled++;
      } else {
        // Remember the miss so we do not spend quota on it every single day.
        entries[id] = {
          id,
          theme,
          preset,
          notFound: true,
          fetchedAt: new Date().toISOString(),
        };
        missing++;
      }
    }
  } catch (err) {
    if (!(err instanceof QuotaExhausted)) throw err;
    quotaHit = true;
    console.log(`Stopping early: ${err.message}`);
  }

  const floorDate = trackingFloor(entries);

  const total = Object.keys(entries).length;
  const usable = Object.values(entries).filter(
    (e) => e.createdAt && e.createdAt.slice(0, 10) > floorDate,
  ).length;

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    CACHE_PATH,
    `${JSON.stringify(
      {
        syncedAt: new Date().toISOString(),
        floorDate,
        floorNote:
          'ThemeRadars createdAt is when they first saw a preset, not when it launched. ' +
          'Entries dated floorDate existed before tracking began, so their date is a lower bound only.',
        presetCount: total,
        withUsableCreatedAt: usable,
        requestsUsed: api?.used ?? 0,
        quotaExhausted: quotaHit,
        entries,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\n${total} presets cached (+${total - before}). Listed ${listed}, backfilled ${backfilled}, ` +
      `not found ${missing}. Requests used: ${(api?.used ?? 0)}.`,
  );
  console.log(`Tracking floor ${floorDate}; ${usable} presets have a usable first-seen date.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
