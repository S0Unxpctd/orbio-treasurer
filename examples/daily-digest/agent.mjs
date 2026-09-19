#!/usr/bin/env node
/**
 * Fetches 1-3 RSS/Atom feeds, asks the Orbio Treasurer gateway (model: "auto") to summarise
 * them, prints the digest, and optionally posts it to a webhook. No dependencies beyond Node
 * built-ins (global fetch) — see the README's "What model: 'auto' does".
 *
 * S-10 fix (tasks/S-10.md Test report Blocker 3): the old default feeds included
 * theverge.com/rss/index.xml, which Cloudflare 403s for Node's default `fetch` (client-fingerprint
 * block, reproduced independent of network egress — identical `curl` from the same host got
 * 200). Both defaults below were verified live with `node -e "fetch(url).then(r=>console.log(r.status))"`
 * to return 200 with no browser User-Agent needed; a `User-Agent` is still sent on every feed
 * fetch as further insurance. A single feed failing (non-200 or network error) is now logged as
 * one line and skipped — the digest still runs on whichever feeds succeeded; only exhausting
 * every feed (or the gateway being unreachable) exits 1.
 */

const TREASURER_URL = process.env.ORBIO_TREASURER_URL;
const TREASURER_KEY = process.env.ORBIO_TREASURER_KEY;
const DEFAULT_FEEDS = 'https://hnrss.org/frontpage,https://github.blog/feed/';
const FEEDS = (process.env.FEEDS ?? DEFAULT_FEEDS)
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean)
  .slice(0, 3);
const FEED_USER_AGENT = 'orbio-agent/1.0';
const DIGEST_WEBHOOK_URL = process.env.DIGEST_WEBHOOK_URL;
const X_WEBHOOK_URL = process.env.X_WEBHOOK_URL;
const BASELINE_MODEL = process.env.BASELINE_MODEL;

/** One line, no stack trace, no key — ever (CLAUDE.md #4). */
function fail(message) {
  console.error(`agent: ${message}`);
  process.exitCode = 1;
}

/**
 * Minimal RSS/Atom <title> extraction — good enough for a digest, no XML parser dependency.
 * Skips the feed/channel's own <title> (always first in both RSS and Atom) so the digest lists
 * items, not the feed's own name.
 */
function extractTitles(xml, max) {
  const titles = [];
  const re = /<title[^>]*>([\s\S]*?)<\/title>/gi;
  let skippedFeedTitle = false;
  let match = re.exec(xml);
  while (match && titles.length < max) {
    const text = match[1]
      .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (!skippedFeedTitle) {
      skippedFeedTitle = true;
      match = re.exec(xml);
      continue;
    }
    if (text) titles.push(text);
    match = re.exec(xml);
  }
  return titles;
}

async function fetchFeedTitles(url, maxPerFeed) {
  const res = await fetch(url, { headers: { 'user-agent': FEED_USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return extractTitles(xml, maxPerFeed);
}

async function main() {
  if (!TREASURER_URL || !TREASURER_KEY) {
    fail('ORBIO_TREASURER_URL and ORBIO_TREASURER_KEY must be set (see .env.example)');
    return;
  }

  // Each feed is fetched independently (`allSettled`, never a single `Promise.all` that rejects
  // the whole batch on the first failure) — one bad feed logs one line and is skipped; the
  // digest still runs on whatever succeeded. Exit 1 only when every feed failed.
  const perFeed = Math.max(1, Math.ceil(6 / FEEDS.length));
  const results = await Promise.allSettled(FEEDS.map((url) => fetchFeedTitles(url, perFeed)));
  const items = [];
  let anyFeedSucceeded = false;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      anyFeedSucceeded = true;
      items.push(...result.value);
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : 'unknown error';
      console.error(`agent: feed ${FEEDS[i]} failed (${reason}) — skipping`);
    }
  }

  if (!anyFeedSucceeded) {
    fail('could not fetch any feed');
    return;
  }

  if (items.length === 0) {
    fail('no feed items found');
    return;
  }

  const prompt = [
    "Summarise today's tech headlines in 5 bullet points, plain text, no preamble:",
    ...items.map((title, i) => `${i + 1}. ${title}`),
  ].join('\n');

  let res;
  try {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${TREASURER_KEY}`,
    };
    if (BASELINE_MODEL) headers['x-baseline-model'] = BASELINE_MODEL;
    res = await fetch(`${TREASURER_URL.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: prompt }] }),
    });
  } catch {
    fail('could not reach the Treasurer gateway');
    return;
  }

  if (!res.ok) {
    // Never print the response body verbatim — a fixed message plus the status is enough to
    // diagnose, and it can't ever echo back anything sensitive.
    fail(`Treasurer gateway returned ${res.status}`);
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    fail('Treasurer gateway returned an unreadable response');
    return;
  }

  const summary = body?.choices?.[0]?.message?.content;
  if (typeof summary !== 'string' || summary.length === 0) {
    fail('Treasurer gateway response had no summary');
    return;
  }

  console.log(summary);

  const model = res.headers.get('x-treasurer-model');
  const costUsd = res.headers.get('x-treasurer-cost-usd');
  const baselineUsd = res.headers.get('x-treasurer-baseline-usd');
  if (model) {
    const cost = costUsd ? `, $${costUsd}` : '';
    const baseline = baselineUsd ? ` vs $${baselineUsd} baseline` : '';
    console.log(`\n(routed to ${model}${cost}${baseline})`);
  }

  for (const [label, url] of [
    ['DIGEST_WEBHOOK_URL', DIGEST_WEBHOOK_URL],
    ['X_WEBHOOK_URL', X_WEBHOOK_URL],
  ]) {
    if (!url) continue;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: summary }),
      });
    } catch {
      // Best-effort: a broken webhook shouldn't fail the run — the digest already printed above.
      console.error(`agent: ${label} post failed (digest already printed above)`);
    }
  }
}

await main();
