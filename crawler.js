'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://themes.shopify.com/themes';
const OUTPUT_FILE = path.join(__dirname, 'themes.json');
const DELAY_MS = 1500;
const MAX_PAGES = 50;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ThemeStoreCrawler/1.0; +https://github.com/benchmarkthemes/sharalanda-crawler)';

/**
 * Perform an HTTPS GET request, following up to 5 redirects.
 * @param {string} url
 * @param {number} [redirectCount]
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function get(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('Too many redirects'));
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const location = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
          res.resume(); // Drain to free socket
          get(location, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Search a parsed JSON object recursively for an array that looks like
 * a list of Shopify theme objects with a "name" field.
 * @param {unknown} obj
 * @param {number} [depth]
 * @returns {string[]}
 */
function searchForThemes(obj, depth = 0) {
  if (depth > 10 || obj == null || typeof obj !== 'object') return [];

  if (Array.isArray(obj)) {
    // If this array's first element has a "name" string, assume it's themes.
    if (obj.length > 0) {
      const first = obj[0];
      if (
        first &&
        typeof first === 'object' &&
        typeof first.name === 'string' &&
        first.name.length > 0
      ) {
        const names = obj
          .map((t) => (t && typeof t.name === 'string' ? t.name.trim() : ''))
          .filter(Boolean);
        if (names.length >= 3) return names;
      }
    }
    for (const item of obj) {
      const result = searchForThemes(item, depth + 1);
      if (result.length > 0) return result;
    }
    return [];
  }

  // Prioritise well-known container keys
  for (const key of ['themes', 'items', 'results', 'products']) {
    if (Array.isArray(obj[key])) {
      const names = obj[key]
        .filter((t) => t && typeof t === 'object')
        .map((t) => {
          const n = t.name || t.title || t.themeName;
          return typeof n === 'string' ? n.trim() : '';
        })
        .filter(Boolean);
      if (names.length > 0) return names;
    }
  }

  for (const value of Object.values(obj)) {
    const result = searchForThemes(value, depth + 1);
    if (result.length > 0) return result;
  }

  return [];
}

/**
 * Try to extract theme names from the Next.js __NEXT_DATA__ JSON block.
 * @param {string} html
 * @returns {string[]}
 */
function extractFromNextData(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s
  );
  if (!match) return [];

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  return searchForThemes(data);
}

/**
 * Fallback: extract theme names using HTML/JSON regex patterns.
 * @param {string} html
 * @returns {string[]}
 */
function extractFromHtml(html) {
  const patterns = [
    // Inline JSON: "name":"ThemeName","handle":"..."
    /"name"\s*:\s*"([A-Z][^"]{1,60})"\s*,\s*"handle"\s*:/g,
    // data attribute
    /data-theme-name="([^"]+)"/g,
    // class-based heading
    /class="[^"]*theme[^"]*name[^"]*"[^>]*>\s*([A-Z][^<]{1,60})\s*</gi,
  ];

  for (const pattern of patterns) {
    const matches = [...html.matchAll(pattern)];
    if (matches.length >= 3) {
      return matches.map((m) => m[1].trim());
    }
  }

  return [];
}

async function crawl() {
  console.log('Starting Shopify theme store crawl…\n');
  const allThemes = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const url = `${BASE_URL}?page=${page}`;
    console.log(`Fetching page ${page}: ${url}`);

    let response;
    try {
      response = await get(url);
    } catch (err) {
      console.error(`  Error fetching page ${page}: ${err.message}`);
      break;
    }

    if (response.statusCode === 404) {
      console.log(`  Page ${page} not found (404) — done.`);
      break;
    }

    if (response.statusCode !== 200) {
      console.log(`  Unexpected status ${response.statusCode} — stopping.`);
      break;
    }

    // Prefer structured Next.js data; fall back to HTML patterns.
    let themes = extractFromNextData(response.body);
    if (themes.length === 0) {
      themes = extractFromHtml(response.body);
    }

    if (themes.length === 0) {
      console.log(`  No themes found on page ${page} — stopping.`);
      break;
    }

    console.log(
      `  Found ${themes.length} themes: ${themes.slice(0, 3).join(', ')}…`
    );
    allThemes.push(...themes);

    page++;
    if (page <= MAX_PAGES) await sleep(DELAY_MS);
  }

  if (allThemes.length > 0) {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allThemes, null, 2));
    console.log(`\nSaved ${allThemes.length} themes to themes.json`);
  } else {
    console.error('\nNo themes found — themes.json was not updated.');
    process.exit(1);
  }
}

crawl().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
