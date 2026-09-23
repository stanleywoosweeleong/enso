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
 *   ?feed=sst      -> gridded OISST slice for the animated map layer.
 *                     &date=YYYY-MM-DD|last  &var=anom|sst
 *                     Returns base64 Int16 (value * 100), fill -32768.
 *
 * Add &fresh=1 to ANY scraped/chained feed to bypass the edge cache for one
 * request. Use it right after deploying a fix, otherwise the previous answer
 * is served until its TTL expires and the fix appears not to have worked.
 *   ?feed=iod      -> BOM ENSO wrap-up (SCRAPED -> JSON). RETIRED: BoM has
 *                     answered 403 to this Worker since 16 Aug 2026 and the app
 *                     no longer calls it. The IOD now comes from data/dmi.json
 *                     (computed daily from OISST), with ?feed=dmimon as fallback.
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
// Same idea for the plain passthrough feeds: a maintenance or error page served
// with 200 must become a 502 the app can fall back from, not "data".
const FEED_SANITY = {
  roni:   /\b[A-Z]{3}\s+(19|20)\d{2}\s+-?\d+\.\d/,          // "JAS 2026  0.62"
  oni:    /\b[A-Z]{3}\s+(19|20)\d{2}\s+\d+\.\d+\s+-?\d+\.\d/,
  weekly: /\d{2}[A-Z]{3}(19|20)\d{2}/,                          // "16SEP2026"
  mjo:    /^\s*(19|20)\d{2}\s+\d{1,2}\s+\d{1,2}\s/m,
};
const DMI_MON_SANITY = /(18|19|20)\d{2}[-,\s][\s\S]{0,40}?-?\d+\.\d/;

// Feeds that are scraped and returned as JSON rather than proxied as text.
// Listed so the "unknown feed" error can name every valid feed — the old
// version reported only Object.keys(FEEDS) and so told callers that the two
// scraped feeds did not exist.
const SCRAPED = ['iod', 'outlook', 'sst'];
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
// No page-wide fallback: the first date-shaped string on the page is usually
// nav or archive text. No anchored date -> issued:null, and the app drops it.

// --- SST field (?feed=sst) -------------------------------------------------
// A gridded slice of NOAA OISST v2.1, compacted to Int16 and base64'd, for the
// animated map layer.
//
// SOURCE ORDER MATTERS. ncdcOisst21Agg is the FINAL product and is TWO WEEKS
// behind by design -- checked 16 Aug 2026, its time_coverage_end was
// 2026-07-31. Using it would have produced an animation that looked current
// and was a fortnight stale. ncdcOisst21NrtAgg is the preliminary near-real-
// time aggregate (about 1 day behind) and goes first; the final is the
// fallback, and the response says which one answered.
//
// Default variable is 'anom', not 'sst', on purpose: raw SST over the tropics
// is dominated by the seasonal and latitudinal gradient, so an El Nino barely
// shows. The anomaly field is where the warm tongue is visible.
//
// Grid: 30S-30N, 100E-290E. The dataset is on a 0-360 longitude axis, so that
// Pacific window is CONTIGUOUS -- no antimeridian split, unlike everywhere
// else in this app.
// Mirrors, not just products. On 16 Aug 2026 coastwatch answered 403 to the
// GitHub runner and 522 through this Worker while serving a browser normally --
// the dataset was fine, the CLIENT was being refused. One host is a single
// point of failure; upwell carries the same ERDDAP datasets.
// Order: newest product first, then the same product on the mirror, and only
// then the two-week-old final product.
const SST_SOURCES = [
  { name: 'oisst-nrt',          id: 'ncdcOisst21NrtAgg', base: 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/' },
  { name: 'oisst-nrt-upwell',   id: 'ncdcOisst21NrtAgg', base: 'https://upwell.pfeg.noaa.gov/erddap/griddap/' },
  { name: 'oisst-final',        id: 'ncdcOisst21Agg',    base: 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/' },
  { name: 'oisst-final-upwell', id: 'ncdcOisst21Agg',    base: 'https://upwell.pfeg.noaa.gov/erddap/griddap/' },
];
const SST_LAT0   = -30, SST_LAT1 = 30;
const SST_LON0   = 100, SST_LON1 = 290;
const SST_STRIDE = 6;          // 6 x 0.25deg = 1.5deg cells
const SST_STEP   = 0.25 * SST_STRIDE;
const SST_FILL   = -32768;     // Int16 slot meaning "no value" (land, gap)
const SST_VARS   = { anom:1, sst:1 };

// Cache TTLs for the assembled JSON responses (seconds).
const TTL = { iod: 3600, outlook: 21600, sst: 43200 };

// ERDDAP refuses a bare token UA from cloud IPs (403 to a GitHub runner, 522
// through this Worker) while serving the same URL to a browser. The BoM and CPC
// scrapes in this file already used a Mozilla-prefixed UA and were never
// blocked, so every upstream call now uses the same one, with a contact URL.
const UA = 'Mozilla/5.0 (compatible; ENSO-Monitor/1.0; +https://stanleywoosweeleong.github.io/Newemso/)';

// BoM answered 403 to this Worker on 16 Aug 2026 even with the UA above, while
// serving the same page to a browser. A UA alone is a weak signal; filters
// commonly also want the headers a real navigation sends. These cost nothing
// and are what a browser would send anyway.
const PAGE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-AU,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

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
    cf: { cacheTtlByStatus: { '200-299': 3600, '404': 0, '500-599': 0 }, cacheEverything: true },
    headers: PAGE_HEADERS,
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

// Pull one time slice and pack it. Kept deliberately allocation-light: a manual
// character scan rather than split()/map(), because a Worker gets very little
// CPU per request and this is ~5000 rows.
async function fetchSst(params) {
  const v = params.get('var') || 'anom';
  if (!SST_VARS[v]) return { ok: false, reason: 'unknown variable' };
  const dateRaw = params.get('date');
  const t = (!dateRaw || dateRaw === 'last')
    ? '(last)'
    : '(' + dateRaw.slice(0, 10) + 'T12:00:00Z)';

  const q = v + '[' + t + '][(0.0)]'
    + '[(' + SST_LAT0 + '):' + SST_STRIDE + ':(' + SST_LAT1 + ')]'
    + '[(' + SST_LON0 + '):' + SST_STRIDE + ':(' + SST_LON1 + ')]';

  // Record EVERY attempt. Reporting only the last one hid what the primary
  // source did -- the message said "oisst-final http 522" and said nothing at
  // all about whether NRT had been refused.
  let body = null, used = null, tried = [];
  for (const src of SST_SOURCES) {
    try {
      const r = await fetch(src.base + src.id + '.csv0?' + encodeURIComponent(q), {
        cf: { cacheTtlByStatus: { '200-299': 21600, '404': 0, '500-599': 0 }, cacheEverything: true },
        headers: { 'User-Agent': UA },
      });
      if (!r.ok) { tried.push(src.name + ' http ' + r.status); continue; }
      const txt = await r.text();
      // ERDDAP answers errors with 200 + an HTML/text explanation, so check
      // that we actually got rows before accepting the source.
      if (txt.indexOf(',') < 0 || txt.length < 200) { tried.push(src.name + ' empty'); continue; }
      body = txt; used = src.name; break;
    } catch (e) { tried.push(src.name + ' ' + String(e)); }
  }
  if (!body) return { ok: false, reason: 'all sst sources failed: ' + tried.join(' | ') };

  const nlat = Math.round((SST_LAT1 - SST_LAT0) / SST_STEP) + 1;
  const nlon = Math.round((SST_LON1 - SST_LON0) / SST_STEP) + 1;
  const grid = new Int16Array(nlat * nlon).fill(SST_FILL);

  // csv0 columns: time,zlev,latitude,longitude,value
  let date = null, n = 0, i = 0, L = body.length;
  while (i < L) {
    let e = body.indexOf('\n', i); if (e < 0) e = L;
    const line = body.slice(i, e); i = e + 1;
    if (!line) continue;
    const c = line.split(',');
    if (c.length < 5) continue;
    if (!date) date = c[0].slice(0, 10);
    const la = +c[2], lo = +c[3], val = parseFloat(c[4]);
    if (!isFinite(la) || !isFinite(lo)) continue;
    const iy = Math.round((la - SST_LAT0) / SST_STEP);
    const ix = Math.round((lo - SST_LON0) / SST_STEP);
    if (iy < 0 || iy >= nlat || ix < 0 || ix >= nlon) continue;
    // NaN is land or a gap; -9.99 is the dataset's own fill value.
    if (!isFinite(val) || val <= -9.98) continue;
    grid[iy * nlon + ix] = Math.max(-32000, Math.min(32000, Math.round(val * 100)));
    n++;
  }
  if (!n) return { ok: false, reason: 'no parsable values' };

  // Int16Array -> bytes -> base64, in chunks so the argument list stays sane.
  const bytes = new Uint8Array(grid.buffer);
  let bin = '';
  for (let k = 0; k < bytes.length; k += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));
  }

  return {
    ok: true, source: used, variable: v, date: date,
    lat0: SST_LAT0, lon0: SST_LON0, step: SST_STEP,
    nlat: nlat, nlon: nlon, scale: 100, fill: SST_FILL,
    points: n, data: btoa(bin),
  };
}

// "Winter 2026-27" is ONE winter (Dec 2026 - Feb 2027). m2m100 renders it as
// "2026年至27年冬季", which reads as two winters. Name the winter by the year
// it starts in, both before translating (so the model gets an unambiguous
// phrase) and after (in case it invents the range anyway).
// Only the copy sent to the translator is changed; the English shown in the
// app keeps NOAA's original wording.
function zhSource(en) {
  return en
    .replace(/\bwinter\s+(\d{4})\s*[-\u2013\u2014\/]\s*\d{2,4}\b/gi, 'winter of $1')
    .replace(/\b(\d{4})\s*[-\u2013\u2014\/]\s*\d{2,4}\s+winter\b/gi, 'winter of $1');
}
function zhTidy(zh) {
  return zh
    // "2026年至27年冬季" / "2026-27年冬季" / "2026/2027年冬天" -> "2026年冬季"
    .replace(/(\d{4})\s*年?\s*(?:至|到|[-\u2013\u2014\/~])\s*(?:\d{4}|\d{2})\s*年?\s*(?:的)?\s*(冬季|冬天)/g, '$1年冬季')
    // ASCII punctuation between Chinese characters -> full-width
    .replace(/([\u4e00-\u9fff])\s*,\s*(?=[\u4e00-\u9fff\d])/g, '$1，')
    .replace(/([\u4e00-\u9fff%])\s*;\s*/g, '$1；');
}

async function scrapeOutlook(env) {
  const page = await fetch(CPC_OUTLOOK_URL, {
    cf: { cacheTtlByStatus: { '200-299': 21600, '404': 0, '500-599': 0 }, cacheEverything: true },
    headers: PAGE_HEADERS,
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

  const dm = html.match(OUTLOOK_DATE_RE);
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
        text: zhSource(synopsis), source_lang: 'english', target_lang: 'chinese',
      });
      if (t && t.translated_text) synopsisZh = zhTidy(String(t.translated_text).trim());
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
    if (feed === 'iod' || feed === 'outlook' || feed === 'sst') {
      // sst is per-date and per-variable, so those belong in the cache key.
      const key = feed === 'sst'
        ? cacheKeyFor(request, 'sst&date=' + (url.searchParams.get('date') || 'last')
                             + '&var=' + (url.searchParams.get('var') || 'anom'))
        : cacheKeyFor(request, feed);
      const cache = caches.default;

      // ?fresh=1 skips the READ but still writes, so a bad cached answer can be
      // replaced on demand. Without it, deploying a fix to a scraped or chained
      // feed changes nothing for up to the TTL -- six hours for outlook, twelve
      // for sst -- and it looks like the fix did not work.
      const fresh = url.searchParams.get('fresh') === '1';
      const hit = fresh ? null : await cache.match(key);
      if (hit) {
        const out = new Response(hit.body, hit);
        Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
        out.headers.set('X-ENSO-Cache', 'hit');
        return out;
      }

      let payload;
      try {
        payload = feed === 'iod'  ? await scrapeIod()
                : feed === 'sst'  ? await fetchSst(url.searchParams)
                :                   await scrapeOutlook(env);
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
            cf: { cacheTtlByStatus: { '200-299': 21600, '404': 0, '500-599': 0 }, cacheEverything: true },
            headers: { 'User-Agent': UA },
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
        cf: { cacheTtlByStatus: { '200-299': 1800, '404': 0, '500-599': 0 }, cacheEverything: true }, // 30 min, successes only
        headers: { 'User-Agent': UA },
      });

      if (!upstream.ok) {
        return new Response(
          JSON.stringify({ error: 'upstream ' + upstream.status }),
          { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }

      const body = await upstream.text();
      const sane = FEED_SANITY[feed];
      if (sane && !sane.test(body)) {
        return new Response(
          JSON.stringify({ error: 'upstream served no data rows', feed, bytes: body.length }),
          { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }
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
