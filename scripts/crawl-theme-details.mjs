#!/usr/bin/env node
/**
 * Daily deep crawl of the Shopify Theme Store.
 *
 * Walks the listing pages for ranking + card data, then visits each theme's
 * detail page for the strapline, its three USPs, the meta description, review
 * stats, presets, version and feature list.
 *
 * Output: data/theme-details.json
 *         data/theme-details.meta.json
 */

import { writeFile, mkdir } from 'node:fs/promises';
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
 * The version-details modal lists every release, newest first. The oldest
 * entry is the theme's launch; it is normally 1.0.0 but a few themes joined
 * the store at a later version.
 */
export function parseVersionHistory(html) {
  const releases = [];
  const releaseRe =
    /<h3[^>]*>\s*Version ([^<]*?)\s*<\/h3>\s*<p[^>]*>\s*([^<]*?)\s*<\/p>/g;

  for (const [, version, rawDate] of html.matchAll(releaseRe)) {
    releases.push({ version, date: toIsoDate(rawDate) });
  }
  if (releases.length === 0) return null;

  const first = releases.find((r) => r.version === '1.0.0') ?? releases[releases.length - 1];

  return {
    launchedAt: first.date,
    launchVersion: first.version,
    releaseCount: releases.length,
  };
}

export function parseDetail(html) {
  // Paid themes render "$250 <span>USD</span>"; free themes just "Free".
  const priceBlock = html.match(/<p class="tw-text-heading-3xl[^"]*">([\s\S]*?)<\/p>/)?.[1];
  const currency = priceBlock?.match(/<span[^>]*>([A-Z]{3})<\/span>/)?.[1] ?? null;

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
    presetUrl: html.match(/<meta property="og:url" content="([^"]+)"/)?.[1] ?? null,
    usps: parseUsps(html),
    presets: parsePresets(html),
    presetCount: toNumber(html.match(/--presets-count:\s*(\d+)/)?.[1]) ?? 1,
    reviews: parseReviews(html),
  };
}

async function main() {
  console.log('Crawling listing pages for rankings…');
  const cards = await crawlListing({
    onPage: (page, count, total) => console.log(`  page ${page}: ${count} themes (total ${total})`),
  });
  console.log(`Found ${cards.length} themes. Fetching detail pages…\n`);

  const failures = [];
  const historyFailures = [];
  let done = 0;

  const themes = await mapWithConcurrency(cards, CONCURRENCY, async (card, index) => {
    const base = { position: index + 1, ...card };

    try {
      const html = card.url ? await fetchHtml(card.url) : null;
      if (!html) throw new Error('detail page not available');
      Object.assign(base, parseDetail(html));

      // Launch date lives in the version-details modal, not the detail page.
      if (base.presetUrl) {
        await sleep(DELAY_MS);
        // This endpoint returns a Turbo Stream and 404s unless Accept is */*.
        const historyHtml = await fetchHtml(`${base.presetUrl}/modal_version_details`, {
          accept: '*/*',
        });
        const history = historyHtml ? parseVersionHistory(historyHtml) : null;
        if (history) Object.assign(base, history);
        else historyFailures.push(card.name);
      }
    } catch (err) {
      failures.push({ name: card.name, handle: card.handle, error: err.message });
      base.error = err.message;
    }

    done++;
    if (done % 50 === 0 || done === cards.length) {
      console.log(`  ${done}/${cards.length} detail pages (${failures.length} failed)`);
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
        withLaunchDate: themes.filter((t) => t.launchedAt).length,
        historyFailureCount: historyFailures.length,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\nWrote ${themes.length} themes (${failures.length} failed).`);
  console.log(JSON.stringify(themes[0], null, 2).slice(0, 900));
}

// Only crawl when run directly, so the parsers can be imported for testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
