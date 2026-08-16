#!/usr/bin/env node
/**
 * Data builder — runs on the GitHub runner, not in a user's request
 * =================================================================
 * Two feeds could never be made reliable from inside a Cloudflare Worker:
 *
 *   OISST grids  — ERDDAP takes seconds per query and answered coastwatch 403
 *                  and 522 from Cloudflare IPs. On 16 Aug 2026 the same Worker
 *                  got NRT at 12:12 and the two-week-old final product at
 *                  12:24. Nothing had changed. It is latency and load, not a
 *                  block, and no amount of header tuning converges on it.
 *   BoM IOD      — 403 to Cloudflare IPs AND to GitHub runners. Retired
 *                  entirely; the DMI is computed from OISST instead.
 *
 * The GitHub runner reaches both without trouble: it has minutes rather than
 * milliseconds, and it is not on a datacentre range those servers throttle.
 * So the fetching moves here, the result is committed, and the app reads
 * static JSON from its own origin — no CORS, no proxy, no timeout, cached by
 * the service worker, and it works offline.
 *
 * Feeds that already answer in milliseconds (roni, weekly, mjo, outlook,
 * dmimon) stay on the Worker. They were green in every run; do not move them.
 *
 * Layout, chosen so the repo does not balloon:
 *   data/sst/index.json           small manifest: grid geometry + dates held
 *   data/sst/anom-YYYY-MM-DD.json one frame, written ONCE and never rewritten
 *   data/dmi.json                 tiny, rewritten daily (computed DMI)
 * One new ~8 KB file per variable per day, older ones pruned from the tree.
 */

import { writeFile, readFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (compatible; ENSO-Monitor-builder/1.0; +https://github.com/stanleywoosweeleong)';

const ERDDAP = [
  { name: 'coastwatch', base: 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/' },
  { name: 'upwell',     base: 'https://upwell.pfeg.noaa.gov/erddap/griddap/' },
];
const DATASETS = [
  { name: 'nrt',   id: 'ncdcOisst21NrtAgg' },   // ~1 day behind
  { name: 'final', id: 'ncdcOisst21Agg' },      // ~2 weeks behind BY DESIGN
];

// 2 deg cells. The Niño boxes are 50-60 deg wide and the source is a smoothed
// analysis, so 1.5 -> 2 deg costs nothing visible and takes a frame from
// ~13.7 KB to ~7.8 KB, which matters when one is committed every day.
const LAT0 = -30, LAT1 = 30, LON0 = 100, LON1 = 290, STRIDE = 8;
const STEP = 0.25 * STRIDE;
const FILL = -32768;

const WEEKS = 12;          // frames kept, matching the weekly Niño 3.4 card
const KEEP_DAYS = 120;     // prune frames older than this from the working tree
const OUT = 'data';

// ERDDAP rate-limits. On 16 Aug 2026 a cold start fetched 12 `anom` frames
// happily and then got 403 from ALL FOUR sources on the very first `sst`
// request -- two independent hosts do not fail together, so that is a quota,
// not an outage. It also explains the Worker flipping between NRT and the
// final product minutes apart: the budget was sometimes already spent.
//
// So: pace the requests, and cap how many NEW frames one run may fetch. Frames
// are permanent once written, so a cold start simply finishes over a few runs
// and steady state is one new frame per variable per day -- two requests.
const PACE_MS = 2500;          // between ERDDAP requests
const MAX_NEW_PER_RUN = 6;     // across all variables
const RATE_LIMIT_BACKOFF_MS = 20000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- helpers */

async function get(url, { tries = 3, timeout = 60000, headers = {} } = {}){
  let last, rateLimited = false;
  for (let i = 1; i <= tries; i++){
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': UA, ...headers } });
      clearTimeout(timer);
      if (!r.ok){
        last = new Error('http ' + r.status);
        // 403/429 here means quota, not refusal -- the same URL worked a
        // moment ago. Retrying in four seconds just spends more of it.
        rateLimited = (r.status === 403 || r.status === 429);
      }
      else return await r.text();
    } catch (e){ clearTimeout(timer); last = e; }
    if (i < tries) await sleep(rateLimited ? RATE_LIMIT_BACKOFF_MS : 4000 * i);
  }
  throw last || new Error('failed');
}

function packGrid(csv){
  const nlat = Math.round((LAT1 - LAT0) / STEP) + 1;
  const nlon = Math.round((LON1 - LON0) / STEP) + 1;
  const g = new Int16Array(nlat * nlon).fill(FILL);
  let date = null, n = 0;
  for (const line of csv.split('\n')){
    if (!line) continue;
    const c = line.split(',');
    if (c.length < 5) continue;
    if (!date) date = c[0].slice(0, 10);
    const la = +c[2], lo = +c[3], v = parseFloat(c[4]);
    if (!isFinite(la) || !isFinite(lo)) continue;
    const iy = Math.round((la - LAT0) / STEP), ix = Math.round((lo - LON0) / STEP);
    if (iy < 0 || iy >= nlat || ix < 0 || ix >= nlon) continue;
    if (!isFinite(v) || v <= -9.98) continue;      // land or gap
    g[iy * nlon + ix] = Math.max(-32000, Math.min(32000, Math.round(v * 100)));
    n++;
  }
  if (!n) throw new Error('no parsable values (an ERDDAP error page parses to nothing)');
  return { date, nlat, nlon, points: n,
           data: Buffer.from(g.buffer).toString('base64') };
}

// Split across variables. A single shared pool meant `anom` spent all six and
// `sst` got none -- for as many runs as it took, which is how sst ended up with
// an empty index while anom looked healthy.
let budget = MAX_NEW_PER_RUN, lastCall = 0;
async function paced(fn){
  const wait = PACE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fn();
}

async function fetchFrame(variable, dateSel){
  const q = `${variable}[${dateSel}][(0.0)]`
    + `[(${LAT0}):${STRIDE}:(${LAT1})][(${LON0}):${STRIDE}:(${LON1})]`;
  const tried = [];
  // Every host x the NRT product first; only then consider the final product.
  for (const ds of DATASETS){
    for (const host of ERDDAP){
      const tag = `oisst-${ds.name}-${host.name}`;
      try {
        const csv = await paced(() => get(host.base + ds.id + '.csv0?' + encodeURIComponent(q)));
        if (csv.indexOf(',') < 0) { tried.push(tag + ' not-csv'); continue; }
        const p = packGrid(csv);
        return { ...p, variable, source: tag, scale: 100, fill: FILL,
                 lat0: LAT0, lon0: LON0, step: STEP, ok: true };
      } catch (e){ tried.push(tag + ' ' + (e.message || e)); }
    }
  }
  throw new Error(tried.join(' | '));
}

/* ------------------------------------------------------- IOD, computed ---
 * BoM answers 403 to Cloudflare Workers AND to GitHub runners -- it blocks
 * datacentre ranges broadly, so relocating the scrape does not help and no
 * header makes a difference. Scraping it from CI is a dead end.
 *
 * So compute the Dipole Mode Index instead, from the same OISST analysis the
 * SST layer already uses (Saji & Yamagata 1999):
 *
 *   DMI = mean SST anomaly over the WEST box  (50-70E, 10S-10N)
 *       - mean SST anomaly over the EAST box  (90-110E, 10S-0)
 *
 * One extra ERDDAP request covers both boxes. This is NOT BoM's published
 * number: BoM uses its own analysis and baseline, so expect small differences
 * in magnitude. The sign and the crossings of +/-0.4 are what matter, and the
 * app labels it as computed so nobody reads it as BoM's figure.
 */
const DMI_W = { latS: -10, latN: 10, lonW: 50, lonE: 70 };
const DMI_E = { latS: -10, latN:  0, lonW: 90, lonE: 110 };

function boxMean(rows, box){
  let sum = 0, n = 0;
  for (const r of rows){
    if (r.lat < box.latS || r.lat > box.latN) continue;
    if (r.lon < box.lonW || r.lon > box.lonE) continue;
    sum += r.v; n++;
  }
  if (!n) throw new Error('no ocean cells in box');
  return { mean: sum / n, cells: n };
}

async function buildDmi(dateSel){
  // One query spanning both boxes: 10S-10N, 50-110E.
  const q = `anom[${dateSel}][(0.0)][(-10):${STRIDE}:(10)][(50):${STRIDE}:(110)]`;
  const tried = [];
  for (const ds of DATASETS){
    for (const host of ERDDAP){
      const tag = `oisst-${ds.name}-${host.name}`;
      try {
        const csv = await paced(() => get(host.base + ds.id + '.csv0?' + encodeURIComponent(q)));
        const rows = [];
        let date = null;
        for (const line of csv.split('\n')){
          const c = line.split(',');
          if (c.length < 5) continue;
          if (!date) date = c[0].slice(0, 10);
          const lat = +c[2], lon = +c[3], v = parseFloat(c[4]);
          if (!isFinite(lat) || !isFinite(lon) || !isFinite(v) || v <= -9.98) continue;
          rows.push({ lat, lon, v });
        }
        if (rows.length < 50) { tried.push(tag + ' too few cells'); continue; }
        const w = boxMean(rows, DMI_W), e = boxMean(rows, DMI_E);
        const dmi = w.mean - e.mean;
        return {
          ok: true, value: Math.round(dmi * 100) / 100,
          west: Math.round(w.mean * 100) / 100,
          east: Math.round(e.mean * 100) / 100,
          cells: { west: w.cells, east: e.cells },
          date, source: tag, computed: true,
          method: 'DMI = mean OISST anomaly 50-70E,10S-10N minus 90-110E,10S-0 (Saji & Yamagata). Computed here, not BoM\u2019s published value.',
        };
      } catch (err){ tried.push(tag + ' ' + (err.message || err)); }
    }
  }
  throw new Error(tried.join(' | '));
}

/* --- BoM: removed ---------------------------------------------------------
 * The BoM IOD scrape used to live here. It is gone, not disabled: BoM answers
 * 403 to Cloudflare Workers and to GitHub runners alike, with every User-Agent
 * and navigation-header combination tried on 16 Aug 2026. There is no request
 * from CI they will answer, so keeping a tripwire only produced a permanent
 * amber row that trains you to skim the report. The DMI is computed above.
 * ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------ main */

const iso = (d) => d.toISOString().slice(0, 10);

// Snap a date back to the most recent FRIDAY (UTC).
//
// The weekly grid used to be anchored on whatever `(last)` returned, which
// moves every day as NRT advances. On 16 Aug 2026 newest went from 08-14 to
// 08-15 and the whole 12-date grid shifted by one day: every frame already on
// disk was orphaned, nothing matched, and the index was written with
// "dates":[] -- the app then had a variable it could never load.
//
// A fixed weekday makes the grid stable, so a frame fetched once stays valid
// for the twelve weeks it is wanted. Friday because every frame committed so
// far already falls on one; changing the phase would orphan them all again.
const WEEKDAY = 5;                       // 0=Sun … 5=Fri
function snapWeekly(dateStr){
  const t = Date.parse(dateStr + 'T12:00:00Z');
  const back = (new Date(t).getUTCDay() - WEEKDAY + 7) % 7;
  return iso(new Date(t - back * 864e5));
}

async function writeIfChanged(file, obj){
  const next = JSON.stringify(obj);
  if (existsSync(file)){
    try { if ((await readFile(file, 'utf8')) === next) return false; } catch {}
  }
  await writeFile(file, next);
  return true;
}

async function main(){
  const variables = (process.env.SST_VARS || 'anom,sst').split(',').map(s => s.trim()).filter(Boolean);
  const perVar = Math.max(2, Math.floor(MAX_NEW_PER_RUN / Math.max(1, variables.length)));
  await mkdir(path.join(OUT, 'sst'), { recursive: true });
  const log = [];
  let hardFail = null;

  for (const v of variables){
    // Anchor on the date the SERVER gives us, never on today's date -- the
    // feed runs a day or two behind and guessing asks for frames that do not
    // exist yet.
    budget = perVar;                    // fresh allowance for each variable
    let newest;
    try { newest = await fetchFrame(v, '(last)'); }
    catch (e){
      // Only fatal when there is nothing at all for this variable. Once frames
      // exist, a rate-limited run is a pause, not a breakage -- the app keeps
      // serving what is committed and feed-health watches the age.
      const held = (await readdir(path.join(OUT, 'sst')).catch(() => []))
        .filter(f => f.startsWith(v + '-')).length;
      const msg = `${v}: newest frame failed — ${e.message}`;
      if (held){ log.push(`warn ${msg} (holding ${held} committed frames)`); }
      else { hardFail = msg; log.push('FAIL ' + msg); }
      continue;
    }

    // Build the grid off the snapped anchor, not off `newest` itself.
    const anchor = snapWeekly(newest.date);
    const base = Date.parse(anchor + 'T12:00:00Z');
    const dates = [];
    for (let i = 0; i < WEEKS; i++) dates.push(iso(new Date(base - i * 7 * 864e5)));
    if (anchor !== newest.date){
      log.push(`note ${v}: newest is ${newest.date}, grid anchored on ${anchor} (weekly phase)`);
    }

    let wrote = 0, have = 0, deferred = 0;
    for (const d of dates){
      const file = path.join(OUT, 'sst', `${v}-${d}.json`);
      if (existsSync(file)){ have++; continue; }         // never refetch a frame
      if (budget <= 0){ deferred++; continue; }          // finish on the next run
      try {
        // Reuse the `(last)` payload only when it happens to land on the grid.
        const f = d === newest.date ? newest : await fetchFrame(v, `(${d}T12:00:00Z)`);
        await writeFile(file, JSON.stringify(f));
        wrote++; budget--;
      } catch (e){ log.push(`warn ${v} ${d}: ${e.message}`); budget--; }
    }

    const kept = dates.filter(d => existsSync(path.join(OUT, 'sst', `${v}-${d}.json`)));
    await writeIfChanged(path.join(OUT, 'sst', `index-${v}.json`), {
      variable: v, dates: kept, newest: newest.date, source: newest.source,
      lat0: LAT0, lon0: LON0, step: STEP, nlat: newest.nlat, nlon: newest.nlon,
      scale: 100, fill: FILL, builtAt: new Date().toISOString(),
    });
    // An index with no dates is unusable: the app fetches it, finds nothing and
    // sits on "loading" forever. That is a failure, not a quiet success.
    if (!kept.length){
      hardFail = hardFail || `${v}: index would be EMPTY (anchor ${anchor}, budget ${perVar})`;
      log.push(`FAIL ${v}: no frames on the grid — index left as-is`);
      continue;
    }
    log.push(`ok   ${v}: newest ${newest.date} via ${newest.source}, ${wrote} new, ${have} cached, `
           + `${kept.length} in index${deferred ? `, ${deferred} deferred to the next run` : ''}`);
  }

  // Prune frames nobody will ask for again.
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  for (const f of await readdir(path.join(OUT, 'sst'))){
    const m = f.match(/-(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && Date.parse(m[1]) < cutoff) await unlink(path.join(OUT, 'sst', f));
  }

  // Computed DMI first -- it works. The BoM scrape is attempted afterwards
  // only so that if they ever stop blocking CI we notice and can prefer their
  // published figure again.
  try {
    const dmi = await buildDmi('(last)');
    const file = path.join(OUT, 'dmi.json');
    let hist = [];
    try { hist = JSON.parse(await readFile(file, 'utf8')).history || []; } catch {}
    hist = hist.filter(h => h.date !== dmi.date).concat([{ date: dmi.date, value: dmi.value }])
               .sort((a, b) => a.date < b.date ? -1 : 1).slice(-26);
    await writeIfChanged(file, { ...dmi, history: hist, builtAt: new Date().toISOString() });
    log.push(`ok   dmi: ${dmi.value} (W ${dmi.west} / E ${dmi.east}) ${dmi.date} via ${dmi.source}, ${hist.length} in history`);
  } catch (e){
    log.push('warn dmi: ' + (e.message || e));
  }

  console.log(log.join('\n'));
  const { appendFileSync } = await import('node:fs');
  if (process.env.GITHUB_STEP_SUMMARY){
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + log.join('\n') + '\n```\n');
  }
  // Hand the reason to the workflow so the failing step can NAME it. "See the
  // job summary" makes you go and look; the point of an alert is to arrive
  // already knowing.
  if (process.env.GITHUB_OUTPUT){
    appendFileSync(process.env.GITHUB_OUTPUT, 'reason=' + (hardFail || '').replace(/\n/g, ' ') + '\n');
  }
  if (hardFail){ console.error('\nbuild incomplete: ' + hardFail); process.exit(1); }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

export { packGrid, fetchFrame, buildDmi, boxMean, DMI_W, DMI_E };
