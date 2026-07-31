#!/usr/bin/env node
/**
 * Crawls the Shopify Theme Store listing pages and records the ordered
 * position of every theme.
 *
 * Output: data/theme-rankings.json  -> ["Triumph", "Purevea", ...]
 *         data/theme-rankings.meta.json -> run metadata
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { crawlListing, LISTING_URL } from './lib/theme-store.mjs';

const OUT_DIR = path.resolve('data');

async function main() {
  let pagesCrawled = 0;

  const cards = await crawlListing({
    onPage: (page, count, total) => {
      if (count === 0) {
        console.log(`page ${page}: 0 themes — end of listing`);
        return;
      }
      pagesCrawled = page;
      console.log(`page ${page}: ${count} themes (total ${total})`);
    },
  });

  const themes = cards.map((card) => card.name);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'theme-rankings.json'), `${JSON.stringify(themes, null, 2)}\n`);
  await writeFile(
    path.join(OUT_DIR, 'theme-rankings.meta.json'),
    `${JSON.stringify(
      {
        crawledAt: new Date().toISOString(),
        pagesCrawled,
        themeCount: themes.length,
        source: LISTING_URL,
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
