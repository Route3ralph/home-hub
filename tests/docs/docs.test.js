// The docs say what the code does. CLAUDE.md, README.md, docs/v2-design.md and tests/README.md are
// what the next person (or Claude session) works from, so this checks the parts of them that can
// drift from the code without anyone noticing:
//   • deploy steps 4 and 5 (CLAUDE.md, docs/v2-design.md §7, README "Upgrading to v2") name every
//     secret hub-jobs reads and every Vault secret supabase/cron.sql needs, and don't call a
//     required one optional;
//   • CLAUDE.md and tests/README.md name every suite tests/run.sh runs, and every public page;
//   • day.html carries the same ?v= as index.html (CLAUDE.md says so);
//   • docs/v2-design.md names every table, column, function and anon-callable function the
//     migrations add, and every signature it writes out has the migration's parameter names;
//   • example phone numbers are in the fictional 555-0100 to 555-0199 range.
// Reads files only: no database, no browser. Run alone with: node tests/docs/docs.test.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const results = [];
const check = (name, ok, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`;
  results.push(line);
  console.log(line);
};

// One "## …" section of a Markdown file: from the heading that matches to the next "## ".
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## /.test(l) && heading.test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}
// The numbered steps of a section ("4. …" at the start of a line, with whatever is indented under it).
function steps(text) {
  const out = {};
  let cur = null;
  for (const l of text.split('\n')) {
    const m = /^(\d+)\.\s/.exec(l);
    if (m) { cur = m[1]; out[cur] = l; } else if (cur && (/^\s/.test(l) || l === '')) out[cur] += `\n${l}`;
    else cur = null;
  }
  return out;
}
const words = (s) => new Set(s.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);

const DOCS = {
  'CLAUDE.md': section(read('CLAUDE.md'), /Deploy order/),
  'docs/v2-design.md §7': section(read('docs/v2-design.md'), /^## 7\. Deploy order/),
  'README.md "Upgrading to v2"': section(read('README.md'), /Upgrading to v2/),
};
for (const [doc, text] of Object.entries(DOCS)) check(`${doc}: has the deploy steps`, !!steps(text)['4'] && !!steps(text)['5'], text.slice(0, 100));

// ---------------------------------------------------------------------
// Deploy step 4: the hub-jobs secrets
// ---------------------------------------------------------------------
// Everything hub-jobs reads from its environment, except what Supabase sets itself (SUPABASE_*).
const fnDir = 'supabase/functions/hub-jobs';
const fnSource = fs.readdirSync(path.join(ROOT, fnDir)).filter((f) => f.endsWith('.ts')).map((f) => read(`${fnDir}/${f}`)).join('\n');
const envNames = new Set();
for (const m of fnSource.matchAll(/(?:\benv\(|Deno\.env\.get\()\s*['"]([A-Z0-9_]+)['"]/g)) if (!/^SUPABASE_/.test(m[1])) envNames.add(m[1]);
// The function works without these (no health ping; "Home Hub" as the sender's name). The rest
// stop every run (stop 'config', or 503) until they are set.
const OPTIONAL = new Set(['HEALTHCHECK_URL', 'EMAIL_FROM_NAME']);
const REQUIRED = [...envNames].filter((n) => !OPTIONAL.has(n)).sort();
check('hub-jobs: the secrets it reads are the ones this test knows (add a new one to the docs and here)',
  [...envNames].sort().join() === ['EMAIL_FROM', 'EMAIL_FROM_NAME', 'HEALTHCHECK_URL', 'HUB_CRON_SECRET', 'RESEND_API_KEY', 'SITE_URL'].join(), [...envNames].sort());

for (const [doc, text] of Object.entries(DOCS)) {
  const step4 = steps(text)['4'] || '';
  const missing = [...envNames].filter((n) => !step4.includes(`\`${n}\``)).sort();
  check(`${doc}: deploy step 4 names every hub-jobs secret`, !missing.length, `missing ${missing.join(', ')}`);
  // "optional" right before a required name, or after it in the same clause, says it can be left out.
  const calledOptional = REQUIRED.filter((n) => {
    const at = step4.indexOf(`\`${n}\``);
    if (at < 0) return false;
    const before = step4.slice(Math.max(0, at - 12), at);
    const after = step4.slice(at + n.length + 2).split(/[`;\n]|, /)[0];
    return /optional/i.test(before) || /optional/i.test(after);
  });
  check(`${doc}: deploy step 4 doesn't call a required secret optional (${REQUIRED.join(', ')})`, !calledOptional.length, calledOptional);
}

// ---------------------------------------------------------------------
// Deploy step 5: the Vault secrets cron.sql reads
// ---------------------------------------------------------------------
const cron = read('supabase/cron.sql').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const vault = [...new Set([...cron.matchAll(/decrypted_secrets\s+\w+\s+where\s+\w+\.name\s*=\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
check('cron.sql: reads its Vault secrets by name', vault.length >= 2, vault);
for (const [doc, text] of Object.entries(DOCS)) {
  const step5 = steps(text)['5'] || '';
  const missing = vault.filter((n) => !step5.includes(`\`${n}\``));
  check(`${doc}: deploy step 5 names every Vault secret cron.sql needs (${vault.join(', ')})`, !missing.length && !/\bthe Vault secret\b(?!s)/i.test(step5),
    missing.length ? `missing ${missing.join(', ')}` : step5);
}

// ---------------------------------------------------------------------
// The test suites: CLAUDE.md and tests/README.md name every one tests/run.sh runs
// ---------------------------------------------------------------------
const runSh = read('tests/run.sh');
const caseBody = runSh.slice(runSh.indexOf('case $suite in'), runSh.indexOf('esac'));
const suites = {};
for (const m of caseBody.matchAll(/^\s{4}([a-z0-9]+)\)\n([\s\S]*?);;/gm)) {
  const p = /tests\/[\w./*-]+/.exec(m[2]);
  if (p) suites[m[1]] = p[0];
}
check('tests/run.sh: every suite runs something under tests/', Object.keys(suites).length >= 4, suites);
const defaults = ((/^\[\[ \$\{#suites\[@\]\} -eq 0 \]\] && suites=\(([^)]*)\)/m.exec(runSh) || [])[1] || '').split(/\s+/).filter(Boolean);
check('tests/run.sh: the default run is a list of its suites', defaults.length > 0 && defaults.every((s) => suites[s]), defaults);
const claude = read('CLAUDE.md');
const testsReadme = read('tests/README.md');
const before = section(claude, /Before every PR/);
for (const [name, p] of Object.entries(suites)) {
  check(`CLAUDE.md "Before every PR" names the ${name} suite (${p})`, before.includes(p), before.slice(0, 300));
  check(`tests/README.md names the ${name} suite (${p})`, testsReadme.includes(p));
}
const unknown = (/Unknown suite[^\n]*Use ([^\n]*)\./.exec(runSh) || [])[1] || '';
check('tests/run.sh: its "Unknown suite" message and header name every suite', Object.keys(suites).every((s) => new RegExp(`\\b${s}\\b`).test(unknown))
  && Object.values(suites).every((p) => runSh.split('set -u')[0].includes(p)), unknown);
const usage = (/tests\/run\.sh fn e2e\s+# only the suites named \(([^)]*)\)/.exec(testsReadme) || [])[1] || '';
check('tests/README.md: "only the suites named" lists every suite', Object.keys(suites).every((s) => new RegExp(`\\b${s}\\b`).test(usage)), usage);
const optionalSuites = Object.keys(suites).filter((s) => !defaults.includes(s));
for (const s of optionalSuites) {
  check(`CLAUDE.md and tests/README.md say the ${s} suite isn't in the default run`,
    new RegExp(`run\\.sh ${s}\\b`).test(claude) && new RegExp(`run\\.sh ${s}\\b`).test(testsReadme));
}

// ---------------------------------------------------------------------
// The public pages, and one ?v= for every page that loads the site's files
// ---------------------------------------------------------------------
const clientSec = section(claude, /Client code/);
for (const page of ['index.html', 'share.html', 'day.html']) {
  check(`CLAUDE.md "Client code" describes ${page}`, clientSec.includes(`\`${page}\``));
}
const versions = {};
for (const page of ['index.html', 'day.html']) {
  const html = read(page).replace(/<!--[\s\S]*?-->/g, '');
  versions[page] = [...new Set([...html.matchAll(/\?v=([^"'&\s>]*)/g)].map((m) => m[1]))];
}
const all = new Set(Object.values(versions).flat());
check('index.html and day.html carry one and the same ?v= (CLAUDE.md: bump them together)', all.size === 1 && !all.has(''), versions);
check('CLAUDE.md says day.html carries the same ?v= as index.html', /day\.html[^\n]*\?v=|\?v=[^\n]*day\.html/.test(clientSec));

// ---------------------------------------------------------------------
// docs/v2-design.md and the migrations
// ---------------------------------------------------------------------
const design = read('docs/v2-design.md');
const designWords = words(design);
const migrationFiles = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
const migrations = migrationFiles.map((f) => read(`supabase/migrations/${f}`)).join('\n');
const sqlNoComments = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const mig = sqlNoComments(migrations);
const baseline = sqlNoComments(read('supabase/schema.sql'));

// Top-level comma split (a default value can have commas inside brackets).
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// Functions: schema, name, the names of their (in) parameters.
function functions(sql) {
  const out = [];
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(public|private)\.(\w+)\s*\(/gi)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < sql.length && depth) { if (sql[i] === '(') depth++; if (sql[i] === ')') depth--; i++; }
    const args = splitArgs(sql.slice(start, i - 1)).filter((a) => !/^out\s/i.test(a));
    out.push({ schema: m[1].toLowerCase(), name: m[2].toLowerCase(), params: args.map((a) => a.split(/\s+/)[0].toLowerCase()),
      optional: args.every((a) => /\sdefault\s/i.test(a)) });
  }
  return out;
}
const migFns = functions(mig);
const allFns = [...functions(baseline), ...migFns];
const byName = new Map();
for (const f of allFns) (byName.get(f.name) || byName.set(f.name, []).get(f.name)).push(f);

// Every public function the migrations add or replace is in the design.
const publicFns = [...new Set(migFns.filter((f) => f.schema === 'public').map((f) => f.name))].sort();
const missingFns = publicFns.filter((n) => !designWords.has(n));
check(`docs/v2-design.md names every public function the migrations add (${publicFns.length})`, !missingFns.length, `missing ${missingFns.join(', ')}`);

// Every signature written out in the design has the real parameter names, in order. A signature is
// "f()" or arguments that are parameters: "p" or "p_…" (the migrations' naming), or a name and a type
// ("p_from date", "t public.tasks"), or any plain names after a schema ("private.series_after(t, p_after)").
// A call ("monday(start)", "series_after(greatest(due_date,
// done_on))") isn't one. "f()" for a function whose parameters all have defaults is a call too.
const PARAM = /^(?:out\s+)?(?:p(?:_[a-z0-9_]*)?|[a-z_][a-z0-9_]*\s+[a-z_][a-z0-9_.]*(?:\[\])?)(?:\s+[a-z_][a-z0-9_.]*(?:\[\])?|\s+default\s+\S+)*$/i;
const wrong = [];
let signatures = 0;
for (const m of design.matchAll(/(?<![\w.])(?:(public|private)\.)?([a-z_][a-z0-9_]*)\(([^()]*)\)/g)) {
  const cands = (byName.get(m[2]) || []).filter((f) => !m[1] || f.schema === m[1]);
  if (!cands.length) continue;
  const args = splitArgs(m[3]);
  // Written with its schema ("private.has_secrets(id)"), plain names count as parameters too.
  if (!args.every((a) => PARAM.test(a) || (m[1] && /^[a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_.]*(?:\[\])?)*$/i.test(a)))) continue;
  const names = args.filter((a) => !/^out\s/i.test(a)).map((a) => a.split(/\s+/)[0].toLowerCase());
  signatures++;
  if (!cands.some((f) => f.params.join() === names.join() || (!names.length && f.optional))) wrong.push(`${m[0]} → ${cands.map((f) => `${f.schema}.${f.name}(${f.params.join(', ')})`).join(' or ')}`);
}
check(`docs/v2-design.md: every function signature it writes out has the migration's parameter names (${signatures} checked)`, !wrong.length, wrong.join(' | '));

// The functions anon can call (the My day page and the share page) are the ones the design lists.
const anon = new Set();
for (const m of mig.matchAll(/grant\s+execute\s+on\s+function\s+public\.(\w+)\([^)]*\)\s+to\s+([^;]+);/gi)) if (/\banon\b/.test(m[2])) anon.add(m[1].toLowerCase());
const tokenSec = design.slice(design.indexOf('### Anonymous token functions'), design.indexOf('### ', design.indexOf('### Anonymous token functions') + 5));
const missingAnon = [...anon].filter((n) => !words(tokenSec).has(n)).sort();
check(`docs/v2-design.md "Anonymous token functions" lists every function anon can call (${[...anon].sort().join(', ')})`, anon.size > 0 && !missingAnon.length, `missing ${missingAnon.join(', ')}`);

// Every table, column and agenda_item field the migrations add is in the design.
const tables = [];
const columns = [];
for (const m of mig.matchAll(/create\s+(table|type)\s+public\.(\w+)\s*(?:as\s*)?\(([\s\S]*?)\n\);/gi)) {
  tables.push(m[2]);
  for (const l of m[3].split('\n')) {
    const c = /^\s+([a-z_][a-z0-9_]*)\s+(?!key\b)[a-z]/i.exec(l);
    if (c && !/^(check|primary|unique|foreign|constraint|references)$/i.test(c[1])) columns.push(`${m[2]}.${c[1]}`);
  }
}
for (const m of mig.matchAll(/alter\s+table\s+public\.(\w+)\s+((?:\s*add\s+column\s+[^,;]+[,;])+)/gi)) {
  for (const c of m[2].matchAll(/add\s+column\s+(\w+)/gi)) columns.push(`${m[1]}.${c[1]}`);
}
const missingTables = tables.filter((t) => !designWords.has(t));
check(`docs/v2-design.md names every table and type the migrations add (${tables.length})`, tables.length > 0 && !missingTables.length, `missing ${missingTables.join(', ')}`);
const missingCols = columns.filter((c) => !designWords.has(c.split('.')[1]));
check(`docs/v2-design.md names every column the migrations add (${columns.length})`, columns.length > 0 && !missingCols.length, `missing ${missingCols.join(', ')}`);

// ---------------------------------------------------------------------
// Example data in the docs is fictional (CLAUDE.md "Test data"): phone numbers in 555-0100 to 555-0199
// ---------------------------------------------------------------------
for (const f of ['CLAUDE.md', 'README.md', 'docs/v2-design.md', 'tests/README.md']) {
  const bad = [...read(f).matchAll(/\b555-(\d{4})\b/g)].map((m) => m[0]).filter((n) => !/^555-01\d\d$/.test(n));
  check(`${f}: example phone numbers are fictional (555-0100 to 555-0199)`, !bad.length, bad);
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`== docs: ${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
