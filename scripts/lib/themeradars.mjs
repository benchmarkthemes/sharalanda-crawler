/**
 * Minimal ThemeRadars API client. https://themeradars.com/developers
 *
 * Free tier: 100 requests/day (resets UTC midnight) and 60 requests/minute, so
 * every call goes through a request budget and a 1.1s pacing gap.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = 'https://themeradars.com/api/v1';
const PACE_MS = 1100; // stay under 60 req/min

export class QuotaExhausted extends Error {}

export class ThemeRadars {
  constructor({ apiKey = process.env.THEMERADARS_API_KEY, budget = 90 } = {}) {
    if (!apiKey) throw new Error('THEMERADARS_API_KEY is not set');
    this.apiKey = apiKey;
    this.budget = budget;
    this.used = 0;
    this.lastCallAt = 0;
  }

  get remaining() {
    return this.budget - this.used;
  }

  async #request(path, { retries = 3 } = {}) {
    if (this.remaining <= 0) throw new QuotaExhausted(`request budget of ${this.budget} used up`);

    for (let attempt = 1; attempt <= retries; attempt++) {
      const gap = PACE_MS - (Date.now() - this.lastCallAt);
      if (gap > 0) await sleep(gap);

      this.used++;
      this.lastCallAt = Date.now();

      const res = await fetch(`${BASE_URL}${path}`, {
        signal: AbortSignal.timeout(30000),
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
        },
      });

      if (res.status === 404) return null;

      if (res.status === 429) {
        // Daily quota and per-minute throttle both return 429; only the latter
        // is worth waiting out.
        const retryAfter = Number(res.headers.get('retry-after'));
        if (!Number.isFinite(retryAfter) || retryAfter > 300) {
          throw new QuotaExhausted(`429 with retry-after=${res.headers.get('retry-after')}`);
        }
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!res.ok) {
        if (attempt === retries) throw new Error(`HTTP ${res.status} for ${path}`);
        await sleep(2000 * attempt);
        continue;
      }

      return res.json();
    }
    throw new Error(`exhausted retries for ${path}`);
  }

  /** One page of the master-theme list (default presets only). */
  async listPage(page, perPage = 100) {
    return this.#request(`/themes?page=${page}&perPage=${perPage}`);
  }

  /** Every master theme, following `meta.total`. */
  async listAll({ perPage = 100, maxPages = 20 } = {}) {
    const rows = [];
    let meta;

    for (let page = 1; page <= maxPages; page++) {
      const body = await this.listPage(page, perPage);
      const data = body?.data ?? [];
      meta = body?.meta;
      rows.push(...data);
      if (data.length < perPage || (meta?.total && rows.length >= meta.total)) break;
    }
    return { rows, meta };
  }

  /**
   * A single preset row. Non-default presets are absent from the list endpoint
   * but retrievable by id, which is `<theme handle>-<preset handle>`.
   */
  async getTheme(id) {
    const body = await this.#request(`/themes/${encodeURIComponent(id)}`);
    return body?.data ?? body ?? null;
  }
}

/** Fields worth keeping from an API row. */
export function pickFields(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    theme: row.name ?? null,
    preset: row.preset ?? null,
    author: row.author ?? null,
    authorCountry: row.authorAddress ?? null,
    price: row.price ?? null,
    isNew: row.new ?? null,
    status: row.status ?? null,
    categories: row.categories ?? [],
    rating: row.rating === '' ? null : (row.rating ?? null),
    currentRank: row.currentRank ?? null,
    previousRank: row.previousRank ?? null,
    rankChange: row.rankChange ?? null,
    currentReviews: row.currentReviews ?? null,
    previousReviews: row.previousReviews ?? null,
    reviewsChange: row.reviewsChange ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}
