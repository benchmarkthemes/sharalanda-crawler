/** Shared helpers for crawling themes.shopify.com. */

import { setTimeout as sleep } from 'node:timers/promises';

export const ORIGIN = 'https://themes.shopify.com';
export const LISTING_URL = `${ORIGIN}/themes`;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Strip tags from an HTML fragment and collapse whitespace. */
export function text(fragment) {
  if (fragment == null) return null;
  const stripped = decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || null;
}

/** First capture group of `re` against `html`, tag-stripped, or null. */
export function match(html, re) {
  const m = html.match(re);
  return m ? text(m[1]) : null;
}

/**
 * Shared cooldown gate. A 429 means the *whole* crawl is going too fast, so
 * every in-flight worker waits it out rather than each backing off alone.
 */
let cooldownUntil = 0;

const waitForCooldown = async () => {
  while (Date.now() < cooldownUntil) {
    await sleep(cooldownUntil - Date.now());
  }
};

export async function fetchHtml(url, { retries = 6, timeoutMs = 30000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    await waitForCooldown();

    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (res.status === 404) return null;

      if (res.status === 429 || res.status >= 500) {
        // Honour Retry-After when present, else back off hard: 15s, 30s, 60s…
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(15000 * 2 ** (attempt - 1), 120000);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs);
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/**
 * Parse the theme cards out of a listing page, in document (ranking) order.
 * Each card is an <a aria-label="Details about the <name> theme"> block.
 */
export function parseListingCards(html) {
  const cards = [];
  const cardRe = /<a\s+aria-label="Details about the ([^"]*?) theme"([\s\S]*?)<\/a>/g;

  for (const [, rawName, block] of html.matchAll(cardRe)) {
    const href = block.match(/href="([^"]*)"/)?.[1] ?? '';
    const path = decodeEntities(href).split('?')[0];
    const handle = path.match(/\/themes\/([^/]+)/)?.[1] ?? null;
    const priceValue = block.match(/<data[^>]*value="([\d.]+)"/)?.[1];

    cards.push({
      name: decodeEntities(rawName).trim(),
      handle,
      url: handle ? `${ORIGIN}/themes/${handle}` : null,
      price: priceValue === undefined ? null : Number(priceValue),
      isFree: priceValue === undefined ? null : Number(priceValue) === 0,
      badge: text(block.match(/role="status"[^>]*>([\s\S]*?)<\/span>/)?.[1]),
      positiveRate: toNumber(block.match(/aria-label="(\d+)% positive"/)?.[1]),
      image: block.match(/<img[\s\S]*?src="([^"]+)"/)?.[1]?.split('?')[0] ?? null,
    });
  }

  return cards;
}

export function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Walk /themes?page=N until a page yields no cards.
 * Returns every card in ranking order.
 */
export async function crawlListing({ maxPages = 200, delayMs = 750, onPage } = {}) {
  const cards = [];

  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchHtml(`${LISTING_URL}?page=${page}`);
    const pageCards = html ? parseListingCards(html) : [];

    onPage?.(page, pageCards.length, cards.length + pageCards.length);
    if (pageCards.length === 0) break;

    cards.push(...pageCards);
    await sleep(delayMs);
  }

  if (cards.length === 0) {
    throw new Error('No themes found — the theme store markup probably changed.');
  }
  return cards;
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
