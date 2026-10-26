#!/usr/bin/env node
// Contract check: every database call the site makes exists in the migrated schema, takes the
// argument names the call sends, and can be run by whoever makes the call. Run it through
// check.sh, which builds the database and passes its catalog (catalog.sql) as the first argument:
//   node tests/contract/check.js <catalog.json> [FILE...]
// Without FILEs it scans the site: assets/**/*.js, the pages' inline scripts (*.html) and the
// Edge Functions (supabase/functions/**/*.ts). The calls it reads:
//   sb.rpc('name', { p_a: …, p_b }) and core.v2.call('name', { … })   a function in public
//     (any call('name', …) or x.call('name', …) whose first argument is a plain string counts)
//   .from('table')                                                     a table or view in public
// Who makes the call: the signed-out pages (day.js, day.html, share.html) as anon, the Edge
// Functions as authenticated or service_role (it depends on the key), everything else as
// authenticated. A call matches a function the way PostgREST picks one: every name sent is one
// of its arguments, and every argument without a default is sent.
// Prints "PASS  …" / "FAIL  …  (detail)" lines and the totals; exits non-zero if anything failed.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
let pass = 0;
let fail = 0;
function report(ok, name, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  (${detail})`); }
}

// ============================================
// SCANNER: a small JavaScript tokenizer, enough to tell code from comments, strings,
// template literals and regular expressions, and to find the calls above in the code.
// ============================================
function lex(src, firstLine = 1) {
  const toks = [];
  const n = src.length;
  const exprs = [];   // open ${…} expressions: the brace depth that closes each, and its template
  let i = 0;
  let line = firstLine;
  let depth = 0;
  const push = (t, v, l) => toks.push({ t, v, line: l });

  // A "/" starts a regular expression unless it follows something that ends a value.
  function regexOk() {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === 'p') return !(p.v === ')' || p.v === ']' || p.v === '}');
    if (p.t === 'id') return /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(p.v);
    return false;
  }

  // Template text from i up to the closing backtick, or up to "${" (then the code inside is
  // tokenized as usual and the text resumes at its closing brace).
  function templateText(tok) {
    while (i < n) {
      const c = src[i];
      if (c === '\\') { tok.v += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { i++; return; }
      if (c === '$' && src[i + 1] === '{') { tok.expr = true; i += 2; exprs.push({ depth, tok }); return; }
      if (c === '\n') line++;
      tok.v += c;
      i++;
    }
  }

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2) < 0 ? n : src.indexOf('*/', i + 2) + 2;
      line += (src.slice(i, end).match(/\n/g) || []).length;
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const l = line;
      let v = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { v += src[i + 1]; i += 2; continue; }
        v += src[i++];
      }
      i++;
      push('str', v, l);
      continue;
    }
    if (c === '`') {
      const tok = { t: 'tpl', v: '', expr: false, line };
      toks.push(tok);
      i++;
      templateText(tok);
      continue;
    }
    if (c === '/' && regexOk()) {
      const l = line;
      let inClass = false;
      i++;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      push('re', '', l);
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      push('id', src.slice(i, j), line);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      push('num', src.slice(i, j), line);
      i = j;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { push('p', '...', line); i += 3; continue; }
    if (c === '?' && src[i + 1] === '.' && !/[0-9]/.test(src[i + 2] || '')) { push('p', '.', line); i += 2; continue; }   // a?.b
    if (c === '{') { depth++; push('p', c, line); i++; continue; }
    if (c === '}') {
      const open = exprs[exprs.length - 1];
      if (open && open.depth === depth) { exprs.pop(); i++; templateText(open.tok); continue; }
      depth--;
      push('p', c, line);
      i++;
      continue;
    }
    push('p', c, line);
    i++;
  }
  return toks;
}

// The top-level keys of the object literal whose "{" is toks[j]. dynamic = it also has a
// spread or a computed key, so the full list of names isn't known here.
function objectKeys(toks, j) {
  const keys = [];
  let dynamic = false;
  let depth = 0;
  let expectKey = true;
  for (let k = j; k < toks.length; k++) {
    const t = toks[k];
    if (depth === 1 && expectKey && !(t.t === 'p' && t.v === '}')) {
      if (t.t === 'id' || t.t === 'str' || t.t === 'num') keys.push(t.v);
      else dynamic = true;   // ...spread, [computed]
      expectKey = false;
    }
    if (t.t === 'p') {
      if ('{[('.includes(t.v)) depth++;
      else if ('}])'.includes(t.v)) { depth--; if (depth === 0) break; }
      else if (t.v === ',' && depth === 1) expectKey = true;
    }
  }
  return { keys, dynamic };
}

// Every call in one file's tokens: { kind: 'rpc' | 'table', name, line, keys, known }.
//   keys:  the argument names sent, or null when the arguments aren't written out at the call
//   known: the names that are written out (with a spread, some of them)
// A call whose name isn't a plain string (core's own generic helper) is only counted.
function findCalls(toks) {
  const calls = [];
  let unnamed = 0;
  const isP = (k, v) => toks[k] && toks[k].t === 'p' && toks[k].v === v;
  const isId = (k, v) => toks[k] && toks[k].t === 'id' && toks[k].v === v;
  const literal = (t) => (t && (t.t === 'str' || (t.t === 'tpl' && !t.expr)) ? t.v : null);
  for (let i = 0; i < toks.length; i++) {
    let kind = null;
    let at = -1;
    if (isP(i, '.') && isId(i + 1, 'rpc') && isP(i + 2, '(')) { kind = 'rpc'; at = i + 3; }
    else if (isId(i, 'call') && isP(i + 1, '(') && !isId(i - 1, 'function') && literal(toks[i + 2]) !== null) {
      kind = 'rpc'; at = i + 2;   // core.v2.call('f', …), or call('f', …) after const { call } = core.v2
    } else if (isP(i, '.') && isId(i + 1, 'from') && isP(i + 2, '(')
             && !(toks[i - 1] && toks[i - 1].t === 'id' && /^(Array|Buffer|Object|storage)$/.test(toks[i - 1].v))) { kind = 'table'; at = i + 3; }
    if (!kind) continue;
    const name = literal(toks[at]);
    if (name === null) { if (kind === 'rpc') unnamed++; continue; }
    const call = { kind, name, line: toks[at].line };
    if (kind === 'rpc') {
      if (isP(at + 1, ')') || (isP(at + 1, ',') && isP(at + 2, ')'))) { call.keys = []; call.known = []; }
      else if (isP(at + 1, ',') && isP(at + 2, '{')) {
        const o = objectKeys(toks, at + 2);
        call.keys = o.dynamic ? null : o.keys;
        call.known = o.keys;
      } else { call.keys = null; call.known = []; }
    }
    calls.push(call);
  }
  return { calls, unnamed };
}

// The inline scripts of a page, each with the line it starts on.
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const type = (m[1].match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    out.push({ code: m[2], line: 1 + (html.slice(0, start).match(/\n/g) || []).length });
  }
  return out;
}

function scanFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const parts = /\.html?$/i.test(file) ? inlineScripts(src) : [{ code: src, line: 1 }];
  const out = { calls: [], unnamed: 0 };
  for (const p of parts) {
    const r = findCalls(lex(p.code, p.line));
    out.calls.push(...r.calls);
    out.unnamed += r.unnamed;
  }
  return out;
}

// ============================================
// WHO CALLS, AND THE SITE'S FILES
// ============================================
const ROLE_LABEL = { anon: 'signed out', authenticated: 'signed in', server: 'Edge Function' };
function roleOf(rel) {
  if (/^supabase\/functions\//.test(rel)) return 'server';
  if (/(^|\/)(day\.js|day\.html|share\.html)$/.test(rel)) return 'anon';
  return 'authenticated';
}
function canUse(entry, role) {
  return role === 'server' ? entry.authenticated || entry.service_role : entry[role];
}

function walk(dir, test, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(e.name)) out.push(p);
  }
  return out;
}
function siteFiles() {
  return [
    ...walk(path.join(root, 'assets'), (f) => f.endsWith('.js')),
    ...fs.readdirSync(root).filter((f) => f.endsWith('.html')).sort().map((f) => path.join(root, f)),
    ...walk(path.join(root, 'supabase/functions'), (f) => f.endsWith('.ts')),
  ];
}

// ============================================
// CHECKS
// ============================================
function signature(f) {
  return `${f.name}(${f.args.map((a, k) => (k < f.required ? a : `${a}?`)).join(', ')})`;
}

// null when the call fits, otherwise what's wrong.
function checkRpc(call, role, catalog) {
  const fns = catalog.functions.filter((f) => f.name === call.name);
  if (!fns.length) return `there is no function public.${call.name}`;
  const sent = call.keys || call.known;
  const fits = fns.filter((f) => sent.every((k) => f.args.includes(k))
                                 && (call.keys === null || f.args.slice(0, f.required).every((a) => call.keys.includes(a))));
  if (!fits.length) {
    return `the call sends {${sent.join(', ')}} but the database has ${fns.map(signature).join(' and ')}`
           + (fns.some((f) => f.required < f.args.length) ? ' (? = has a default)' : '');
  }
  if (call.keys !== null && fits.length > 1) {
    return `ambiguous: ${fits.map(signature).join(' and ')} all take these arguments, so PostgREST refuses the call`;
  }
  if (!fits.some((f) => canUse(f, role))) {
    return `${role === 'server' ? 'neither authenticated nor service_role' : role} may not execute public.${call.name}`;
  }
  return null;
}

function checkTable(call, role, catalog) {
  const t = catalog.tables.find((x) => x.name === call.name);
  if (!t) return `there is no table or view public.${call.name}`;
  if (role === 'anon') return `a signed-out page reads public.${call.name} directly; anon sees no rows there, so use a token function`;
  if (!canUse(t, role)) return `${role === 'server' ? 'neither authenticated nor service_role' : role} has no rights on public.${call.name}`;
  return null;
}

// The scanner on parser-sample.js: what it must find, and the look-alikes it must skip.
function selfCheck() {
  const r = scanFile(path.join(__dirname, 'parser-sample.js'));
  const got = r.calls.map((c) => (c.kind === 'rpc'
    ? `rpc ${c.name}(${c.keys === null ? `?${c.known.join(',')}` : c.keys.join(',')})`
    : `table ${c.name}`));
  const want = [
    'rpc whoami()', 'rpc complete_task(p_id,p_occurrence,p_done_on,p_note)', 'rpc agenda(p_from,p_to)', 'rpc late_items()',
    'rpc dynamic_args(?)', 'rpc with_spread(?p_x)', 'table tasks', 'table events', 'table people', 'rpc heads_up(p_day)',
  ];
  const names = (list) => list.map((s) => s.replace(/\(.*$/, '')).join(' ');
  report(names(got) === names(want), 'scanner: finds sb.rpc, core.v2.call, call and .from calls, and skips comments, strings, templates, regexes, Array.from and fn.call',
         `got ${names(got)}`);
  report(got.join(' ') === want.join(' '), 'scanner: reads argument names (plain, shorthand, quoted, nested values, trailing comma; ? = not all known)',
         `got ${got.join(' ')}`);
  report(r.unnamed === 2, 'scanner: counts sb.rpc calls whose name is only known at run time', `got ${r.unnamed}`);
  report(r.calls.find((c) => c.name === 'agenda').line === 11, 'scanner: line numbers', `got ${r.calls.find((c) => c.name === 'agenda').line}`);
}

function main() {
  const [catalogFile, ...only] = process.argv.slice(2);
  if (!catalogFile) {
    console.log('FAIL  contract: no catalog given (run tests/contract/check.sh)');
    process.exit(1);
  }
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  selfCheck();

  const files = only.length ? only.map((f) => path.resolve(f)) : siteFiles();
  const seen = new Map();   // one check per distinct call: kind, name, argument names, caller
  let unnamed = 0;
  for (const file of files) {
    const inside = !path.relative(root, file).startsWith('..');
    const rel = inside ? path.relative(root, file).split(path.sep).join('/') : file;
    const role = roleOf(rel);
    const r = scanFile(file);
    unnamed += r.unnamed;
    for (const c of r.calls) {
      const args = c.kind !== 'rpc' ? '' : c.keys === null ? `?${c.known.join(',')}` : c.keys.join(',');
      const key = [c.kind, c.name, args, role].join('|');
      if (!seen.has(key)) seen.set(key, { call: c, role, where: [] });
      seen.get(key).where.push(`${rel}:${c.line}`);
    }
  }

  const all = [...seen.values()].sort((a, b) => (a.call.kind + a.call.name).localeCompare(b.call.kind + b.call.name));
  for (const { call, role, where } of all) {
    const at = where[0] + (where.length > 1 ? ` +${where.length - 1} more` : '');
    if (call.kind === 'rpc') {
      const args = call.keys === null
        ? `{${call.known.length ? `${call.known.join(', ')}, ` : ''}…}: arguments not all written out at the call, so only those are checked`
        : `{${call.keys.join(', ')}}`;
      const problem = checkRpc(call, role, catalog);
      report(!problem, `rpc ${call.name} ${args}, ${ROLE_LABEL[role]}  [${at}]`, problem);
    } else {
      const problem = checkTable(call, role, catalog);
      report(!problem, `table ${call.name}, ${ROLE_LABEL[role]}  [${at}]`, problem);
    }
  }

  // The site has always made these calls; if the scan misses them, the scanner is broken.
  if (!only.length) {
    const has = (kind, name, role) => all.some((x) => x.call.kind === kind && x.call.name === name && x.role === role);
    report(has('rpc', 'whoami', 'authenticated') && has('table', 'projects', 'authenticated') && has('rpc', 'get_shared_project', 'anon'),
           'the scan finds the calls the site is known to make (whoami, projects, get_shared_project)', 'one of them is missing');
  }

  const rpcs = all.filter((x) => x.call.kind === 'rpc').length;
  console.log(`   scanned ${files.length} files: ${rpcs} distinct function calls, ${all.length - rpcs} distinct table calls`
              + (unnamed ? `, ${unnamed} call(s) with a name only known at run time (not checked)` : ''));
  console.log(`== contract: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (require.main === module) main();
module.exports = { lex, findCalls, objectKeys, inlineScripts, checkRpc, checkTable };
