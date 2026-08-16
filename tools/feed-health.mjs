#!/usr/bin/env node
/**
 * Feed health check — ENSO Monitor + SUHU
 * =======================================
 * Every failure this project has hit came back HTTP 200. JAMSTEC served a
 * redirect notice instead of data. PSL retired a path. BoM reworded the
 * sentence a regex depended on. ERDDAP handed over a product that is two weeks
 * behind by design. CPC replaced ONI with RONI. In every case the app kept
 * rendering and nobody was told.
 *
 * So this checks four things per feed, in order, and a pass on an earlier one
 * means nothing about the later ones:
 *
 *   1. REACHABLE   — did it answer at all
 *   2. PARSABLE    — is the body the shape we expect, not a notice page
 *   3. FRESH       — is the newest datum inside that feed's own budget
 *   4. EXPECTED    — did the source we wanted answer, or did a fallback
 *
 * Step 4 is the one that has no visible symptom. A silent fallback to OISST's
 * final product looks perfectly healthy and is a fortnight stale.
 *
 * Exit codes: 0 = all good (warnings allowed), 1 = at least one FAIL.
 */

// ERDDAP answered 403 to a GitHub runner and 522 through the Cloudflare Worker
// on 16 Aug 2026 while serving a browser the same URL perfectly. The feeds that
// passed that morning all send a Mozilla-prefixed UA; the ones that were
// refused did not. Identify honestly, but in the shape servers accept.
const UA = 'Mozilla/5.0 (compatible; enso-feed-health/1.0; +https://github.com/stanleywoosweeleong)';

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
                 jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

// Overlapping 3-month seasons, in order, indexed by their CENTRE month.
const SEASONS = ['DJF','JFM','FMA','MAM','AMJ','MJJ','JJA','JAS','ASO','SON','OND','NDJ'];

const days = (ts) => (Date.now() - ts) / 864e5;

/* ---------------- parsers: each returns { ts, note } or throws -------------- */

export function parseRoni(text){
  const rows = text.trim().split(/\r?\n/).slice(1)
    .map(l => l.trim().split(/\s+/)).filter(p => p.length >= 3 && !isNaN(parseFloat(p[2])));
  if (!rows.length) throw new Error('no SEAS YR ANOM rows');
  const [seas, yr, anom] = rows[rows.length - 1];
  const m = SEASONS.indexOf(seas);
  if (m < 0) throw new Error('unknown season "' + seas + '"');
  // NDJ and DJF straddle the year boundary; CPC labels them by the later year.
  return { ts: Date.UTC(+yr, m, 15), note: `${seas} ${yr} = ${anom}` };
}

export function parseWeekly(text){
  const rows = text.split(/\r?\n/)
    .map(l => l.match(/^\s*(\d{2})([A-Z]{3})(\d{4})\s+(.+)$/)).filter(Boolean);
  if (!rows.length) throw new Error('no week rows');
  const last = rows[rows.length - 1];
  const nums = last[4].match(/-?\d+\.\d/g) || [];
  if (nums.length < 8) throw new Error(`only ${nums.length} values on the last row, expected 8`);
  const mo = MONTHS[last[2].toLowerCase()];
  if (mo === undefined) throw new Error('bad month ' + last[2]);
  return { ts: Date.UTC(+last[3], mo, +last[1]),
           note: `${last[1]}${last[2]}${last[3]}  3.4=${nums[5]}` };
}

export function parseDmiMonthly(text){
  let best = null;
  for (const line of String(text).replace(/<[^>]+>/g, ' ').split(/\r?\n/)){
    const s = line.trim(); if (!s) continue;
    const csv = s.match(/^(\d{4})-(\d{2})-\d{2}\s*,\s*(-?\d+(?:\.\d+)?)/);
    const keep = (y, m, v) => {
      if (!isFinite(v) || v <= -90 || v >= 90) return;
      if (!best || y > best.y || (y === best.y && m > best.m)) best = { y, m, v };
    };
    if (csv){ keep(+csv[1], +csv[2], parseFloat(csv[3])); continue; }
    const t = s.split(/\s+/).map(Number);
    if (t.length < 2 || !Number.isInteger(t[0]) || t[0] < 1870 || t[0] > 2100) continue;
    t.slice(1, 13).forEach((v, k) => keep(t[0], k + 1, v));
  }
  if (!best) throw new Error('no monthly values (a notice page parses to nothing)');
  return { ts: Date.UTC(best.y, best.m - 1, 15),
           note: `${best.y}-${String(best.m).padStart(2,'0')} = ${best.v}` };
}

export function parseProseDate(s){
  const m = String(s || '').match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) throw new Error('no date in "' + s + '"');
  const mo = MONTHS[m[2].slice(0,3).toLowerCase()];
  if (mo === undefined) throw new Error('bad month in "' + s + '"');
  return Date.UTC(+m[3], mo, +m[1]);
}

/* ---------------- the checks ------------------------------------------------ */

export function buildChecks(proxy){
  const P = (q) => `${proxy}?feed=${q}&t=${Date.now()}`;
  return [
    // 80 days, not 45: RONI is a 3-month mean labelled by its CENTRE month and
    // published monthly, so its newest value is ~60 days back even when the
    // feed is perfectly healthy. A tighter budget would fire every morning.
    { name: 'roni (CPC, official index)', url: P('roni'), budget: 80,
      check: t => parseRoni(t) },

    { name: 'weekly Niño (CPC)', url: P('weekly'), budget: 12,
      check: t => parseWeekly(t) },

    { name: 'dmimon (PSL monthly DMI)', url: P('dmimon'), budget: 110,
      check: t => parseDmiMonthly(t) },

    { name: 'sst field (OISST grid)', url: P('sst&var=anom&date=last'), budget: 10,
      check: t => {
        const o = JSON.parse(t);
        if (o.ok !== true) throw new Error(o.reason || 'ok:false');
        if (!o.points) throw new Error('zero grid points');
        return { ts: Date.parse(o.date + 'T12:00:00Z'),
                 note: `${o.date}  ${o.points} pts  via ${o.source}`,
                 // Two different things, and the old message conflated them.
                 // A MIRROR is the same near-real-time product from another
                 // host: the data is right, but redundancy is gone. The FINAL
                 // product is genuinely two weeks old. Only the second is the
                 // failure with no visible symptom; the first is worth knowing
                 // because you are now down to your last NRT source.
                 warn: o.source === 'oisst-nrt' ? null
                     : o.source.indexOf('oisst-nrt') === 0
                       ? `primary host refused; serving NRT from ${o.source} — redundancy gone`
                       : `fell back to ${o.source}, the ~2-week-old final product` };
      } },

    { name: 'outlook (CPC discussion)', url: P('outlook'), budget: 45,
      check: t => {
        const o = JSON.parse(t);
        if (o.ok !== true) throw new Error(o.reason || 'ok:false');
        if (!o.status) throw new Error('no alert status parsed');
        if (!o.synopsis) throw new Error('status parsed but synopsis did not');
        return { ts: parseProseDate(o.issued), note: `${o.status} — issued ${o.issued}` };
      } },

    { name: 'iod (BoM wrap-up)', url: P('iod'), budget: 21,
      check: t => {
        const o = JSON.parse(t);
        // Three legitimate outcomes, and only one of them is a fault.
        if (o.ok === true) return { ts: parseProseDate(o.asOf), note: `${o.value} °C as of ${o.asOf}` };
        if (o.neutral === true) return { ts: parseProseDate(o.asOf),
          note: `BoM reports neutral, no figure (dated ${o.asOf})` };
        throw new Error(o.reason || 'scrape failed');
      } },

    { name: 'mjo (NOAA ROMI)', url: P('mjo'), budget: 14,
      check: t => {
        const rows = t.split(/\r?\n/).map(l => l.trim().split(/\s+/).map(Number))
          .filter(p => p.length >= 4 && Number.isInteger(p[0]) && p[0] > 1970 && p[0] < 2100);
        if (!rows.length) throw new Error('no ROMI rows');
        const r = rows[rows.length - 1];
        return { ts: Date.UTC(r[0], r[1] - 1, r[2]),
                 note: `${r[0]}-${r[1]}-${r[2]}` };
      } },

    // Upstream, bypassing the Worker. When a proxied feed fails, this says
    // whether the source broke or the Worker did -- two very different mornings.
    { name: 'upstream: CPC RONI file', direct: true, budget: 80,
      url: 'https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt',
      check: t => parseRoni(t) },

    // Both ERDDAP hosts, so "the mirror is also down" and "only the primary is
    // refusing us" are distinguishable at a glance.
    { name: 'upstream: ERDDAP (coastwatch)', direct: true, budget: 6,
      url: 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/ncdcOisst21NrtAgg.das',
      check: t => dasAge(t) },
    { name: 'upstream: ERDDAP (upwell mirror)', direct: true, budget: 6,
      url: 'https://upwell.pfeg.noaa.gov/erddap/griddap/ncdcOisst21NrtAgg.das',
      check: t => dasAge(t) },
  ];
}

export function dasAge(t){
  const m = t.match(/time_coverage_end\s+"([^"]+)"/);
  if (!m) throw new Error('no time_coverage_end in the .das');
  return { ts: Date.parse(m[1]), note: 'newest slice ' + m[1].slice(0,10) };
}

/* ---------------- runner ---------------------------------------------------- */

export async function runChecks(checks, fetchFn = fetch){
  const out = [];
  for (const c of checks){
    const row = { name: c.name, status: 'FAIL', age: null, note: '' };
    let bodyText = null;
    try {
      const r = await fetchFn(c.url, { headers: { 'User-Agent': UA } });
      if (!r.ok){
        // 403 from a datacentre IP is a refusal, not an outage -- worth saying
        // so, because the instinct on seeing it is to go looking for downtime.
        row.note = `HTTP ${r.status}` + (r.status === 403 ? ' (refused, not down — check UA / IP block)' : '');
        out.push(row); continue;
      }
      const body = bodyText = await r.text();
      // No blanket minimum length. A 36-byte body turned out to be
      // {"ok":false,"reason":"bom http 403"} -- the Worker naming the exact
      // fault -- and the guard reported "body only 36 bytes" instead, hiding
      // the one thing worth knowing. Let each parser judge; an unparsable body
      // produces a real message anyway.
      if (!body){ row.note = 'empty body'; out.push(row); continue; }
      const res = c.check(body);
      row.age = days(res.ts);
      row.note = res.note;
      if (!isFinite(row.age)){ row.note += ' — unparsable date'; out.push(row); continue; }
      if (row.age > c.budget){
        row.status = 'FAIL';
        row.note += ` — ${row.age.toFixed(0)}d old, budget ${c.budget}d`;
      } else if (res.warn){
        row.status = 'WARN';
        row.note += ` — ${res.warn}`;
      } else {
        row.status = 'OK';
      }
    } catch (e){
      row.note = String(e && e.message || e);
      // Show what actually came back. Guessing at a parse failure from the
      // message alone wastes a morning; 120 characters of the body usually
      // ends the guessing immediately.
      if (bodyText) row.note += ' — got: ' + snippet(bodyText);
    }
    out.push(row);
  }
  return out;
}

// One line, no markdown-breaking characters, short enough for a table cell.
export function snippet(s, n = 120){
  const t = String(s).replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  return (t.length > n ? t.slice(0, n) + '…' : t) || '(empty)';
}

export function report(rows){
  const ico = s => s === 'OK' ? '✅' : s === 'WARN' ? '⚠️' : '❌';
  const lines = ['| | feed | age | detail |', '|---|---|---|---|'];
  for (const r of rows){
    lines.push(`| ${ico(r.status)} | ${r.name} | ${r.age == null ? '—' : r.age.toFixed(1) + 'd'} | ${r.note} |`);
  }
  const bad = rows.filter(r => r.status === 'FAIL');
  const warn = rows.filter(r => r.status === 'WARN');
  lines.push('', bad.length
    ? `**${bad.length} feed(s) failing:** ${bad.map(r => r.name).join(', ')}`
    : warn.length ? `All feeds answering; ${warn.length} warning(s).`
                  : 'All feeds healthy.');
  return lines.join('\n');
}

/* ---------------- CLI ------------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`){
  const proxy = process.env.ENSO_PROXY || 'https://enso-proxy.standphoto.workers.dev';
  const rows = await runChecks(buildChecks(proxy));
  const md = report(rows);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY){
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
  process.exit(rows.some(r => r.status === 'FAIL') ? 1 : 0);
}
