#!/usr/bin/env node
/**
 * Daily deep crawl of the Shopify Theme Store.
 *
 * Walks the listing pages for ranking + card data, then visits each card's page
 * for the strapline, its three USPs, the meta description, review stats,
 * presets and version history, and merges the ThemeRadars cache.
 *
 * Note that most listing cards are *presets*, not themes: the store has ~344
 * themes across ~1,300 presets. `themeLaunchedAt` is the parent theme's launch;
 * `presetLaunchedAt` is only set when this preset's own launch date is known.
 *
 * Output: data/theme-details.json
 *         data/theme-details.meta.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  crawlListing,
  fetchHtml,
  mapWithConcurrency,
  match,
  text,
  toNumber,
} from './lib/theme-store.mjs';

const OUT_DIR = path.resolve('data');
// The store rate-limits above roughly 2 requests/second; 2 workers with a
// 700ms gap keeps us under it. fetchHtml() adds a shared cooldown on 429.
const CONCURRENCY = 2;
const DELAY_MS = 700; // per worker, between detail pages
const MAX_FAILURE_RATE = 0.1;

function parseUsps(html) {
  const usps = [];
  const figcaptionRe =
    /<figcaption[^>]*>[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;

  for (const [, title, description] of html.matchAll(figcaptionRe)) {
    usps.push({ title: text(title), description: text(description) });
    if (usps.length === 3) break;
  }
  return usps;
}

function parseReviews(html) {
  const breakdown = { positive: null, neutral: null, negative: null };
  for (const [, kind, count] of html.matchAll(/aria-labelledby="ratings-meter-(\w+)-(\d+)"/g)) {
    if (kind in breakdown) breakdown[kind] = toNumber(count);
  }

  return {
    positiveRate: toNumber(match(html, /role="note">\s*([\d.]+)%\s*positive/)),
    count: toNumber(match(html, /role="note">\s*([\d,]+)\s*reviews?/)),
    breakdown,
  };
}

/**
 * Themes with a single preset have no Presets section at all; multi-preset
 * themes render a card stack, each card labelled `View <preset>`.
 */
function parsePresets(html) {
  const start = html.indexOf('>Presets<');
  if (start === -1) return [];

  const section = html.slice(start, start + 40000);
  const names = new Set();
  for (const [, name] of section.matchAll(/aria-label="View ([^"]+)"/g)) {
    const preset = text(name);
    if (preset) names.add(preset);
  }
  return [...names];
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** "June  1, 2018" -> "2018-06-01" (the store pads single-digit days). */
function toIsoDate(value) {
  const m = value?.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  const month = m && MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/**
 * The version-details modal lists every release, newest first, and is
 * theme-wide: every preset of a theme returns byte-identical history. The
 * oldest entry is the theme's launch; it is normally 1.0.0 but a few themes
 * joined the store at a later version.
 */
export function parseVersionHistory(html) {
  const parts = html.split(/<h3[^>]*>\s*Version ([^<]*?)\s*<\/h3>/);
  const releases = [];

  for (let i = 1; i < parts.length; i += 2) {
    const body = text(parts[i + 1]) ?? '';
    releases.push({ version: parts[i], date: toIsoDate(body), body });
  }
  if (releases.length === 0) return null;

  const first = releases.find((r) => r.version === '1.0.0') ?? releases[releases.length - 1];

  return {
    themeLaunchedAt: first.date,
    launchVersion: first.version,
    releaseCount: releases.length,
    releases,
  };
}

/**
 * Some developers announce new presets in their release notes:
 *
 *   v11.0.0 — "We're excited to introduce Strass, a new preset designed for…"
 *
 * Roughly a third of non-default presets are covered. Requires announcement
 * wording as well as the name, because a theme's own name recurs throughout its
 * notes and would otherwise match dozens of unrelated releases.
 */
export function findPresetAnnouncement(releases, presetHandle, presetName) {
  if (!releases?.length) return null;

  const needles = [presetHandle, presetName]
    .filter(Boolean)
    .map((s) => String(s).trim().replace(/[-\s]+/g, '[-\\s]?').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (needles.length === 0) return null;

  const nameRe = new RegExp(`\\b(?:${needles.join('|')})\\b`, 'gi');
  const announceRe = /\bnew preset\b|\bintroduc\w*\b|\badded\b[^.]{0,60}\bpreset\b/gi;

  // Require the name and the announcement wording to sit close together, so a
  // release that merely mentions the name somewhere and "introduces" something
  // unrelated elsewhere does not count.
  const hits = releases.filter((r) => {
    if (!r.date) return false;
    const nameAt = [...r.body.matchAll(nameRe)].map((m) => m.index);
    if (nameAt.length === 0) return false;
    const announceAt = [...r.body.matchAll(announceRe)].map((m) => m.index);
    return announceAt.some((a) => nameAt.some((n) => Math.abs(a - n) <= 120));
  });
  // Releases are newest-first, so the last hit is the earliest announcement.
  return hits.length ? hits[hits.length - 1] : null;
}

export function parseDetail(html) {
  // Paid themes render "$250 <span>USD</span>"; free themes just "Free".
  const priceBlock = html.match(/<p class="tw-text-heading-3xl[^"]*">([\s\S]*?)<\/p>/)?.[1];
  const currency = priceBlock?.match(/<span[^>]*>([A-Z]{3})<\/span>/)?.[1] ?? null;
  const presetUrl = html.match(/<meta property="og:url" content="([^"]+)"/)?.[1] ?? null;

  return {
    strapline: match(html, /<p class="[^"]*tw-text-heading-xl[^"]*tw-text-fg-secondary[^"]*">([\s\S]*?)<\/p>/),
    metaDescription: match(html, /<meta name="description" content="([^"]*)"/),
    author: match(html, /by\s*<a[^>]*href="#ReleaseNotes"[^>]*>([\s\S]*?)<\/a>/),
    authorUrl: html.match(/href="(\/designers\/[^"]+)"/)?.[1] ?? null,
    displayPrice: priceBlock ? text(priceBlock.replace(/<span[^>]*>[A-Z]{3}<\/span>/, '')) : null,
    currency,
    version: match(html, /<h3[^>]*>\s*Version ([^<]*?)\s*<\/h3>/),
    lastUpdated: match(html, /<h3[^>]*>\s*Version [^<]*?<\/h3>[\s\S]{0,200}?<span>\s*([^<]*?)\s*<\/span>/),
    themeId: toNumber(html.match(/data-monorail-click-tracking-theme-id-value="(\d+)"/)?.[1]),
    presetId: toNumber(html.match(/data-monorail-click-tracking-preset-id-value="(\d+)"/)?.[1]),
    presetUrl,
    presetHandle: presetUrl?.match(/\/presets\/([^/?#]+)/)?.[1] ?? null,
    usps: parseUsps(html),
    presets: parsePresets(html),
    presetCount: toNumber(html.match(/--presets-count:\s*(\d+)/)?.[1]) ?? 1,
    reviews: parseReviews(html),
  };
}

async function loadThemeRadars() {
  try {
    const cache = JSON.parse(await readFile(path.join(OUT_DIR, 'themeradars.json'), 'utf8'));
    return { entries: cache.entries ?? {}, floorDate: cache.floorDate ?? null };
  } catch {
    console.log('No ThemeRadars cache found — preset dates will rely on release notes only.');
    return { entries: {}, floorDate: null };
  }
}

/**
 * Decide this preset's own launch date, preferring exact sources. Left null
 * when only the parent theme's date is known, so consumers can tell the
 * difference rather than showing a theme date as a preset date.
 */
export function resolvePresetLaunch({ card, base, history, radar, floorDate }) {
  const isDefault = base.presetHandle != null && base.presetHandle === card.handle;

  if (isDefault && base.themeLaunchedAt) {
    return { presetLaunchedAt: base.themeLaunchedAt, presetLaunchedAtSource: 'default-preset' };
  }

  const announced = findPresetAnnouncement(history?.releases, base.presetHandle, card.name);
  // An announcement predating the theme itself would be a mismatched name.
  if (announced?.date && (!base.themeLaunchedAt || announced.date >= base.themeLaunchedAt)) {
    return {
      presetLaunchedAt: announced.date,
      presetLaunchedAtSource: 'release-note',
      presetLaunchedAtVersion: announced.version,
    };
  }

  // ThemeRadars first saw the preset on this date. Only usable when it is after
  // they began tracking, otherwise it is just the tracking start date.
  const firstSeen = radar?.createdAt?.slice(0, 10);
  if (firstSeen && floorDate && firstSeen > floorDate) {
    return { presetLaunchedAt: firstSeen, presetLaunchedAtSource: 'themeradars-first-seen' };
  }

  return { presetLaunchedAt: null, presetLaunchedAtSource: null };
}

async function main() {
  const { entries: radarEntries, floorDate } = await loadThemeRadars();
  console.log(
    `ThemeRadars cache: ${Object.keys(radarEntries).length} presets, tracking floor ${floorDate ?? 'unknown'}.`,
  );

  console.log('Crawling listing pages for rankings…');
  const cards = await crawlListing({
    onPage: (page, count, total) => console.log(`  page ${page}: ${count} cards (total ${total})`),
  });
  console.log(`Found ${cards.length} cards. Fetching detail pages…\n`);

  const failures = [];
  const historyFailures = [];
  let done = 0;

  // Version history is theme-wide, so fetch it once per theme rather than once
  // per card: ~344 requests instead of ~1,225.
  const historyCache = new Map();
  const getHistory = (themeHandle, presetUrl) => {
    if (!historyCache.has(themeHandle)) {
      historyCache.set(
        themeHandle,
        (async () => {
          // This endpoint returns a Turbo Stream and 404s unless Accept is */*.
          const html = await fetchHtml(`${presetUrl}/modal_version_details`, { accept: '*/*' });
          return html ? parseVersionHistory(html) : null;
        })(),
      );
    }
    return historyCache.get(themeHandle);
  };

  const themes = await mapWithConcurrency(cards, CONCURRENCY, async (card, index) => {
    const base = { position: index + 1, ...card };

    try {
      const html = card.url ? await fetchHtml(card.url) : null;
      if (!html) throw new Error('detail page not available');
      Object.assign(base, parseDetail(html));

      let history = null;
      if (base.presetUrl) {
        await sleep(DELAY_MS);
        history = await getHistory(card.handle, base.presetUrl);
        if (history) {
          const { releases, ...summary } = history;
          Object.assign(base, summary);
        } else {
          historyFailures.push(card.name);
        }
      }

      const radarId = base.presetHandle ? `${card.handle}-${base.presetHandle}` : null;
      const radar = radarId ? radarEntries[radarId] : null;

      Object.assign(base, resolvePresetLaunch({ card, base, history, radar, floorDate }));

      if (radar && !radar.notFound) {
        const { fetchedAt, createdAt, updatedAt, theme, preset, ...rest } = radar;
        base.themeRadars = { ...rest, firstSeenAt: createdAt, updatedAt, fetchedAt };
      } else {
        base.themeRadars = null;
      }
    } catch (err) {
      failures.push({ name: card.name, handle: card.handle, error: err.message });
      base.error = err.message;
    }

    delete base.presetUrl; // derivable from url + presetHandle
    done++;
    if (done % 100 === 0 || done === cards.length) {
      console.log(`  ${done}/${cards.length} cards (${failures.length} failed)`);
    }
    await sleep(DELAY_MS);
    return base;
  });

  const failureRate = failures.length / themes.length;
  if (failureRate > MAX_FAILURE_RATE) {
    console.error(failures.slice(0, 20));
    throw new Error(
      `${failures.length}/${themes.length} detail pages failed (>${MAX_FAILURE_RATE * 100}%) — aborting without writing.`,
    );
  }

  const bySource = {};
  for (const t of themes) {
    const key = t.presetLaunchedAtSource ?? 'unknown';
    bySource[key] = (bySource[key] ?? 0) + 1;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'theme-details.json'), `${JSON.stringify(themes, null, 2)}\n`);
  await writeFile(
    path.join(OUT_DIR, 'theme-details.meta.json'),
    `${JSON.stringify(
      {
        crawledAt: new Date().toISOString(),
        themeCount: themes.length,
        failureCount: failures.length,
        failures,
        withStrapline: themes.filter((t) => t.strapline).length,
        withThreeUsps: themes.filter((t) => t.usps?.length === 3).length,
        withThemeLaunchDate: themes.filter((t) => t.themeLaunchedAt).length,
        withPresetLaunchDate: themes.filter((t) => t.presetLaunchedAt).length,
        presetLaunchDateBySource: bySource,
        withThemeRadars: themes.filter((t) => t.themeRadars).length,
        distinctThemes: new Set(themes.map((t) => t.handle)).size,
        historyRequests: historyCache.size,
        historyFailureCount: historyFailures.length,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\nWrote ${themes.length} cards (${failures.length} failed).`);
  console.log('preset launch date by source:', bySource);
}

// Only crawl when run directly, so the parsers can be imported for testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
