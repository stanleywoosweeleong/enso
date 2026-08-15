/**
 * ENSO Monitor — Cloudflare Worker proxy
 * ---------------------------------------
 * NOAA CPC's index text files do not send an Access-Control-Allow-Origin
 * header, so a browser fetch from GitHub Pages is blocked by CORS.
 * This Worker fetches them server-side and re-serves with CORS enabled.
 *
 * Deploy:
 *   1. dash.cloudflare.com -> Workers & Pages -> Create Worker
 *   2. Paste this file, Deploy.
 *   3. Put the worker URL into PROXY in the PWA (window.ENSO_PROXY).
 *
 * Endpoints (append ?feed=<name>):
 *   ?feed=roni     -> RONI.ascii.txt   (RONI, seasonal 3-month mean, monthly update)
 *                     CPC adopted RONI as the OFFICIAL ENSO index in Feb 2026
 *                     (Information Statement 26-05), replacing ONI. Verified
 *                     live Aug 2026: header "SEAS YR ANOM", 3 columns.
 *   ?feed=oni      -> oni.ascii.txt    (traditional ONI, monthly) -- NOT used by
 *                     the app. CPC moved the ONI table to .../enso/oni/v6/ when
 *                     it rebuilt on ERSST v6; confirm this data file's version
 *                     before wiring it to anything.
 *   ?feed=weekly   -> wksst9120.for    (weekly Nino-region SST anomalies)
 *   ?feed=mjo      -> NOAA ROMI (MJO index, daily, near real-time)
 *   ?feed=dmimon   -> monthly DMI, source chain (PSL new path -> PSL gcos path).
 *                     Fallback for the IOD card when BoM publishes no figure.
 *   ?feed=iod      -> BOM ENSO wrap-up (current weekly IOD, SCRAPED -> JSON)
 *   ?feed=outlook  -> CPC ENSO discussion (alert status + synopsis, SCRAPED -> JSON)
 *
 * NOTE on iod: there is no clean machine-readable feed for the *current* weekly
 * IOD. BOM publishes it only as prose inside their ENSO wrap-up page. So for
 * iod we fetch that page and extract the value+date with a regex, returning
 * JSON: { value, asOf, ok }. This is intentionally fragile: if BOM changes
 * their wording the regex will miss, and we return { ok:false } so the APP can
 * show a LOUD "needs updating" notice instead of any stale/guessed number.
 * When that happens, update IOD_VALUE_RE / BOM_IOD_URL below.
 *
 * CACHING — read this before editing:
 * The PWA appends a &t=<timestamp> cache-buster to every request, so each
 * incoming URL is unique and this Worker's handler runs in full every time.
 * Upstream fetches survive that (cf.cacheTtl keys on the UPSTREAM url, which
 * has no buster), but everything the handler does AFTER the fetch did not —
 * including the Workers AI translation on ?feed=outlook, which was re-running
 * on every single page load for a synopsis that changes monthly.
 * Both scraped feeds are now cached with the Cache API under a NORMALISED key
 * (the buster stripped), so the scrape + translation happen once per TTL and
 * every other request is served from the edge. The plain passthrough feeds are
 * left uncached here — their upstream fetch is already cached and the body is
 * just text.
 */

const FEEDS = {
  roni:   'https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt',
  oni:    'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt',
  weekly: 'https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for',
  mjo:    'https://psl.noaa.gov/mjo/mjoindex/romi.cpcolr.1x.txt',
};

// ?feed=dmimon -- monthly Dipole Mode Index, the FALLBACK for the IOD card when
// BoM publishes no weekly figure. Tried in order; first 200 with parsable
// content wins, and the winner is stamped into X-ENSO-Source.
//
// Verified 15 Aug 2026:
//   - PSL new path is live; newest real month was 2026-05 (+0.146), later
//     months carry the -9999 missing flag. PSL runs ~2-3 months behind, which
//     is normal for a HadISST-derived monthly index -- the APP must age-label
//     it as monthly rather than judge it by weekly standards.
//   - The gcos_wgsp path still serves the same file, but PSL's own pages say
//     those timeseries are being taken down, so it is second, not first.
//   - JAMSTEC's dmi.monthly.txt is NOT here on purpose: it now returns only a
//     notice pointing at APL VirtualEarth, with no data at all. It still
//     answers 200, so a naive chain would treat it as a working source.
const DMI_MON_SOURCES = [
  { name: 'psl-monthly', url: 'https://psl.noaa.gov/data/timeseries/month/data/dmi.had.long.csv' },
  { name: 'psl-gcos',    url: 'https://psl.noaa.gov/gcos_wgsp/Timeseries/Data/dmi.had.long.data' },
];
// A source only counts as working if the body actually contains a plausible
// year-and-value pair. Reachability is not the same as data.
const DMI_MON_SANITY = /(18|19|20)\d{2}[-,\s][\s\S]{0,40}?-?\d+\.\d/;

// Feeds that are scraped and returned as JSON rather than proxied as text.
// Listed so the "unknown feed" error can name every valid feed — the old
// version reported only Object.keys(FEEDS) and so told callers that the two
// scraped feeds did not exist.
const SCRAPED = ['iod', 'outlook'];
// Served by their own handlers rather than the generic passthrough.
const CHAINED = ['dmimon'];
const ALL_FEEDS = [...Object.keys(FEEDS), ...SCRAPED, ...CHAINED].sort();

// Optional: restrict who may use this Worker. Leave empty to allow all.
// Anything not listed still gets data, but without CORS headers, so a browser
// on another origin cannot read it. Add your Pages origins here if the free
// tier ever gets close to its limits.
const ALLOWED_ORIGINS = [];

// --- IOD scrape config (the fragile part — update here if BOM changes) ---
const BOM_IOD_URL = 'https://www.bom.gov.au/climate/enso/';
// Matches e.g. "the IOD index is -0.13 °C", "(IOD) index is +1.25 °C for week
// ending...", or "(IOD) index was +0.01°C". Tolerant of an optional ")" after
// IOD, the minus being hyphen or unicode minus, and spacing/° variants.
const IOD_VALUE_RE = /IOD\)?\s*index\s+(?:is|was)\s*([+\-\u2212]?\d+(?:\.\d+)?)\s*[°º\u00b0]?\s*C/i;
// Captures an "as of" / "week ending" date, e.g. "As of 14 June 2026",
// "for week ending 17 September", "for the week ending 21 December 2025".
// The definite article is REQUIRED to be optional: BOM writes "for the week
// ending ..." on the current page, and the older pattern (no "the") silently
// returned no date at all -- which the app reads as "cannot age-check", so a
// value would display with its staleness guard disabled. Verified Aug 2026.
const IOD_DATE_RE = /(?:as\s+of|(?:for\s+)?(?:the\s+)?week\s+ending)\s+([0-9]{1,2}\s+[A-Za-z]+(?:\s+[0-9]{4})?)/i;
// How far either side of the value match we will look for that date. The two
// regexes used to scan the whole page independently, so the returned asOf could
// belong to a different paragraph than the value — and the app gates staleness
// on that date, so a borrowed date either masks an old value or hides a good
// one. Scoping the search keeps the pair honest; if no date is found nearby we
// return null, which the app treats as "cannot age-check" rather than "fresh".
const IOD_DATE_WINDOW = 400;
// BOM only quotes a figure while an IOD event is running. Between events they
// write prose only -- "the IOD index is now back to neutral", "the IOD is
// neutral" -- with no number anywhere on the page. Treating that as a scrape
// failure trains people to ignore the notice, so detect it explicitly and
// report it as what it is. We still refuse to invent a value.
const IOD_NEUTRAL_RE = /IOD\)?\s*(?:index\s+)?(?:is|are|has|have|now|remains?|returned?|back)[^.]{0,80}?neutral/i;

// --- ENSO outlook scrape config (CPC diagnostic discussion, monthly) ---
// Extracts the Alert System Status line ("La Niña Advisory", "El Niño Watch",
// "Not Active"...) and the Synopsis sentence(s). Fragile like the IOD scrape:
// if CPC rewords, the app just omits the outlook row (no stale/guessed text).
const CPC_OUTLOOK_URL = 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml';
const OUTLOOK_STATUS_RE = /ENSO Alert System Status:\s*(.{2,60}?)\s*(?:Synopsis:|$)/;
// Stop at a period followed by whitespace, so decimals ("0.5°C") don't cut the
// sentence short. Common abbreviations are stepped over explicitly — "U.S."
// used to truncate the synopsis mid-clause.
const OUTLOOK_SYNOPSIS_RE = /Synopsis:\s*((?:[\s\S]{20,400}?[^\s])\.)(?=\s|$)/;
const OUTLOOK_ABBREV_RE = /\b(?:U\.S|U\.K|i\.e|e\.g|approx|Fig|Dr|Mr|Mrs|vs|etc|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/i;
// The issue date sits in the discussion header, after "issued by". Anchoring to
// that phrase stops us grabbing the first date-shaped string anywhere on the
// page (nav, archive links, footer) and handing the app a wrong issue date,
// which its 45-day gate would act on.
const OUTLOOK_DATE_RE = /issued\s+by[\s\S]{0,300}?(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/;
const OUTLOOK_DATE_FALLBACK_RE = /(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/;

// Cache TTLs for the assembled JSON responses (seconds).
const TTL = { iod: 3600, outlook: 21600 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function corsFor(request) {
  if (!ALLOWED_ORIGINS.length) return CORS;
  const origin = request.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return { ...CORS, 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  }
  const { 'Access-Control-Allow-Origin': _drop, ...rest } = CORS;
  return rest;
}

// Return a JSON body with CORS. `feed` is stamped into X-ENSO-Feed — it used to
// be hardcoded to 'iod', so outlook responses were labelled as IOD, which is
// exactly the header you would reach for while debugging the outlook feed.
function jsonRes(obj, feed, cors, ttl) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + (ttl || 3600),
      'X-ENSO-Feed': feed,
    },
  });
}

// Cache key with the app's &t= buster (and anything else) stripped, so all
// requests for one feed share a single cached entry.
function cacheKeyFor(request, feed) {
  const u = new URL(request.url);
  u.search = '?feed=' + feed;
  return new Request(u.toString(), { method: 'GET' });
}

// Strip tags and the entities that matter, then collapse whitespace, so the
// regexes see clean prose instead of markup.
function toText(raw) {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&deg;/gi, '\u00b0')
    .replace(/&#176;/g, '\u00b0')
    .replace(/&minus;/gi, '\u2212')
    .replace(/&ntilde;/gi, '\u00f1')
    .replace(/&#(\d+);/g, (m, n) => {
      const cp = parseInt(n, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
    })
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

async function scrapeIod() {
  const page = await fetch(BOM_IOD_URL, {
    cf: { cacheTtl: 3600, cacheEverything: true },
    headers: {
      'User-Agent': 'Mozilla/5.0 (ENSO-Monitor; orchard climate app)',
      'Accept': 'text/html',
    },
  });
  if (!page.ok) return { ok: false, reason: 'bom http ' + page.status };

  const html = toText(await page.text());
  const vm = html.match(IOD_VALUE_RE);
  if (!vm) {
    // No figure on the page. Two very different reasons, and the app shows a
    // different message for each -- so tell them apart here rather than
    // collapsing both into "broken".
    const nm = html.match(IOD_NEUTRAL_RE);
    if (nm) {
      // Date the statement so the app can age-check it. An undated "neutral"
      // is worthless: BOM prose from last year still parses. No date -> we
      // report a plain failure and let the loud notice stand.
      const nAt = nm.index || 0;
      const nFwd = html.slice(nAt, nAt + nm[0].length + IOD_DATE_WINDOW);
      let ndm = nFwd.match(IOD_DATE_RE);
      if (!ndm) {
        const nBack = html.slice(Math.max(0, nAt - IOD_DATE_WINDOW), nAt);
        const nAll = [...nBack.matchAll(new RegExp(IOD_DATE_RE.source, 'gi'))];
        ndm = nAll.length ? nAll[nAll.length - 1] : null;
      }
      if (ndm) {
        return { ok: false, neutral: true, asOf: ndm[1],
                 reason: 'bom reports neutral, no figure published', source: 'BOM' };
      }
    }
    // Regex missed -> BOM likely changed wording. Fail LOUD, not stale.
    return { ok: false, reason: 'pattern not found' };
  }
  const value = parseFloat(vm[1].replace('\u2212', '-'));
  if (isNaN(value)) return { ok: false, reason: 'parse failed' };

  // Look for the date near the value we just matched, FORWARD first: BOM writes
  // "the IOD index is +0.41 °C for week ending 9 August 2026", so the date that
  // belongs to this value follows it. Only if nothing follows do we take the
  // nearest preceding date. Searching the whole page (the old behaviour) would
  // pick up the ENSO section's date instead and hand the app the wrong week.
  const at = vm.index || 0;
  const fwd = html.slice(at, at + vm[0].length + IOD_DATE_WINDOW);
  let dm = fwd.match(IOD_DATE_RE);
  if (!dm) {
    const back = html.slice(Math.max(0, at - IOD_DATE_WINDOW), at);
    const all = [...back.matchAll(new RegExp(IOD_DATE_RE.source, 'gi'))];
    dm = all.length ? all[all.length - 1] : null;
  }
  const asOf = dm ? dm[1] : null;

  return { ok: true, value, asOf, source: 'BOM' };
}

async function scrapeOutlook(env) {
  const page = await fetch(CPC_OUTLOOK_URL, {
    cf: { cacheTtl: 21600, cacheEverything: true },
    headers: {
      'User-Agent': 'Mozilla/5.0 (ENSO-Monitor; orchard climate app)',
      'Accept': 'text/html',
    },
  });
  if (!page.ok) return { ok: false, reason: 'cpc http ' + page.status };

  const html = toText(await page.text());
  const sm = html.match(OUTLOOK_STATUS_RE);
  if (!sm) return { ok: false, reason: 'status pattern not found' };
  const status = sm[1].trim();

  // Extend past an abbreviation-final period rather than truncating there.
  let synopsis = null;
  const ym = html.match(OUTLOOK_SYNOPSIS_RE);
  if (ym) {
    synopsis = ym[1].trim();
    let guard = 0;
    while (OUTLOOK_ABBREV_RE.test(synopsis) && guard++ < 6) {
      const after = html.slice((ym.index || 0) + ym[0].length);
      const more = after.match(/^\s*([\s\S]{1,200}?[^\s])\.(?=\s|$)/);
      if (!more) break;
      synopsis = (synopsis + ' ' + more[1].trim() + '.').trim();
      ym[0] += more[0];
    }
  }

  const dm = html.match(OUTLOOK_DATE_RE) || html.match(OUTLOOK_DATE_FALLBACK_RE);
  const issued = dm ? dm[dm.length - 1] : null;

  // Optional: translate the synopsis to Chinese via Workers AI (m2m100).
  // Requires an AI binding named "AI" on this Worker (dashboard: Settings ->
  // Bindings -> Add -> Workers AI, variable name AI). If the binding is missing
  // or the call fails, synopsisZh is simply omitted and the app shows the
  // English original — graceful, never blocking the feed.
  // This is the expensive step, and it is why this whole response is cached:
  // it now runs once per TTL instead of once per page load.
  let synopsisZh = null;
  if (synopsis && env && env.AI) {
    try {
      const t = await env.AI.run('@cf/meta/m2m100-1.2b', {
        text: synopsis, source_lang: 'english', target_lang: 'chinese',
      });
      if (t && t.translated_text) synopsisZh = String(t.translated_text).trim();
    } catch (e) { /* translation is a bonus — never fail the feed for it */ }
  }

  return { ok: true, status, synopsis, synopsisZh, issued, source: 'NOAA CPC' };
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const feed = url.searchParams.get('feed');

    // --- Scraped feeds: assembled JSON, cached under a buster-free key ---
    if (feed === 'iod' || feed === 'outlook') {
      const key = cacheKeyFor(request, feed);
      const cache = caches.default;

      const hit = await cache.match(key);
      if (hit) {
        const out = new Response(hit.body, hit);
        Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
        out.headers.set('X-ENSO-Cache', 'hit');
        return out;
      }

      let payload;
      try {
        payload = feed === 'iod' ? await scrapeIod() : await scrapeOutlook(env);
      } catch (err) {
        payload = { ok: false, reason: 'fetch error: ' + String(err) };
      }

      const ttl = TTL[feed];
      const res = jsonRes(payload, feed, cors, ttl);
      res.headers.set('X-ENSO-Cache', 'miss');
      // Only cache a good scrape. A failure must be retried promptly, not
      // pinned at the edge for six hours (see cacheable below).
      // A confirmed, dated "neutral" is a successful scrape even though ok is
      // false -- cache it like one. Only genuine failures are left uncached so
      // they retry promptly.
      const cacheable = payload.ok === true || payload.neutral === true;
      if (cacheable && ctx && ctx.waitUntil) {
        ctx.waitUntil(cache.put(key, res.clone()));
      }
      return res;
    }

    // --- Monthly DMI: a chain, not a single upstream ---
    if (feed === 'dmimon') {
      for (const src of DMI_MON_SOURCES) {
        try {
          const up = await fetch(src.url, {
            cf: { cacheTtl: 21600, cacheEverything: true },
            headers: { 'User-Agent': 'ENSO-Monitor/1.0 (durian farm weather)' },
          });
          if (!up.ok) continue;
          const body = await up.text();
          if (!DMI_MON_SANITY.test(body)) continue;   // served, but not data
          return new Response(body, {
            headers: {
              ...cors,
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'public, max-age=21600',
              'X-ENSO-Feed': 'dmimon',
              'X-ENSO-Source': src.name,
            },
          });
        } catch (e) { /* try the next source */ }
      }
      return new Response(
        JSON.stringify({ error: 'all dmimon sources failed', tried: DMI_MON_SOURCES.map(s => s.name) }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    if (!feed || !FEEDS[feed]) {
      return new Response(
        JSON.stringify({ error: 'unknown feed', valid: ALL_FEEDS }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    try {
      const upstream = await fetch(FEEDS[feed], {
        cf: { cacheTtl: 1800, cacheEverything: true }, // 30 min edge cache
        headers: { 'User-Agent': 'ENSO-Monitor/1.0 (durian farm weather)' },
      });

      if (!upstream.ok) {
        return new Response(
          JSON.stringify({ error: 'upstream ' + upstream.status }),
          { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }

      const body = await upstream.text();
      return new Response(body, {
        headers: {
          ...cors,
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=1800',
          'X-ENSO-Feed': feed,
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'fetch failed', detail: String(err) }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }
  },
};
