#!/usr/bin/env node
/**
 * Crawls the Shopify Theme Store listing pages and records the ordered
 * position of every theme.
 *
 * Output: data/theme-rankings.json  -> ["Triumph", "Purevea", ...]
 *         data/theme-rankings.meta.json -> run metadata
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const BASE_URL = 'https://themes.shopify.com/themes';
const OUT_DIR = path.resolve('data');
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MAX_PAGES = 200; // hard stop so a layout change can't loop forever
const DELAY_MS = 750; // be polite between page requests
const MAX_RETRIES = 4;

/** Each theme card is an <a aria-label="Details about the <name> theme" ...>. */
const CARD_RE = /aria-label="Details about the ([^"]*?) theme"/g;

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

async function fetchPage(page) {
  const url = `${BASE_URL}?page=${page}`;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const backoff = 1000 * 2 ** (attempt - 1);
        console.warn(`  retry ${attempt}/${MAX_RETRIES - 1} for page ${page}: ${err.message}`);
        await sleep(backoff);
      }
    }
  }
  throw lastError;
}

function parseThemes(html) {
  return [...html.matchAll(CARD_RE)].map((m) => decodeEntities(m[1]));
}

async function main() {
  const themes = [];
  let pagesCrawled = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchPage(page);
    const names = parseThemes(html);

    if (names.length === 0) {
      console.log(`page ${page}: 0 themes — end of listing`);
      break;
    }

    pagesCrawled = page;
    themes.push(...names);
    console.log(`page ${page}: ${names.length} themes (total ${themes.length})`);

    await sleep(DELAY_MS);
  }

  if (themes.length === 0) {
    throw new Error('No themes found — the theme store markup probably changed.');
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'theme-rankings.json'), `${JSON.stringify(themes, null, 2)}\n`);
  await writeFile(
    path.join(OUT_DIR, 'theme-rankings.meta.json'),
    `${JSON.stringify(
      {
        crawledAt: new Date().toISOString(),
        pagesCrawled,
        themeCount: themes.length,
        source: BASE_URL,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\nWrote ${themes.length} themes from ${pagesCrawled} pages.`);
  console.log(`Top 5: ${JSON.stringify(themes.slice(0, 5))}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
