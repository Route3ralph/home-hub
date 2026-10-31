// The docs say what the code does. CLAUDE.md, README.md, docs/v2-design.md and tests/README.md are
// what the next person (or Claude session) works from, so this checks the parts of them that can
// drift from the code without anyone noticing:
//   • deploy steps 4 and 5 (CLAUDE.md, docs/v2-design.md §7, README "Upgrading to v2") name every
//     secret hub-jobs reads and every Vault secret supabase/cron.sql needs, and don't call a
//     required one optional;
//   • CLAUDE.md and tests/README.md name every suite tests/run.sh runs, and every public page, and
//     tests/README.md every browser and real-database test file, in that suite's section;
//   • day.html carries the same ?v= as index.html (CLAUDE.md says so); CLAUDE.md names the scripts
//     index.html and day.html load, in order, and day.html's stylesheets; and every way into day.html
//     (the ?x= day.js reads) is described in CLAUDE.md and docs/v2-design.md §4;
//   • the README says Share shows wherever the browser has Web Share (hub.js canShare), not phones only;
//   • docs/v2-design.md names every table, column, function and anon-callable function the
//     migrations add, and every signature it, docs/v1.1-google-calendar.md, docs/v1.2-kitchen.md or
//     docs/v1.3-homework.md writes out has the migration's parameter names;
//   • from migration 0004 (v1.2) on, docs/v2-design.md writes out every new table, added column
//     and constraint as the migration has it (in ```sql blocks), the signature of every public
//     function, every private function, and every function a migration renames;
//   • anon can call exactly the token functions the design counts;
//   • docs/v1.2-kitchen.md §2 counts the public and private functions migration 0004 adds, and
//     docs/v1.3-homework.md §2.1 what 0005 adds (tables by name, household columns, functions) and §3.6
//     the token functions anon can call;
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
// The function works without these (no health ping; "Home Hub" as the sender's name; without the
// Google key the calendar job stops with not_set_up and the morning email is unchanged; without the
// Anthropic key, v1.3 PR B, the homework_ai action answers not_set_up and everything else works). The
// rest stop every run (stop 'config', or 503) until they are set.
const OPTIONAL = new Set(['HEALTHCHECK_URL', 'EMAIL_FROM_NAME', 'GOOGLE_SA_JSON', 'ANTHROPIC_API_KEY']);
const REQUIRED = [...envNames].filter((n) => !OPTIONAL.has(n)).sort();
check('hub-jobs: the secrets it reads are the ones this test knows (add a new one to the docs and here)',
  [...envNames].sort().join() === ['ANTHROPIC_API_KEY', 'EMAIL_FROM', 'EMAIL_FROM_NAME', 'GOOGLE_SA_JSON', 'HEALTHCHECK_URL', 'HUB_CRON_SECRET', 'RESEND_API_KEY', 'SITE_URL'].join(), [...envNames].sort());

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
// tests/README.md describes every browser and real-database test file (its tables of suites), so a new one
// (v1.3's homework.test.js and tutor.test.js) is written up when it is added. Each is looked for in its
// own suite's section: e2e/ and realdb/ both have a homework.test.js, so the whole file would find one
// write-up for two files.
{
  const section = (heading) => {
    const at = testsReadme.indexOf(heading);
    if (at < 0) return '';
    const next = testsReadme.indexOf('\n## ', at + heading.length);
    return testsReadme.slice(at, next < 0 ? undefined : next);
  };
  const dirs = { 'tests/e2e': '## Browser tests (`e2e/`)', 'tests/realdb': '## Real-database tests (`realdb/`)' };
  const files = Object.keys(dirs).flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.test.js')).map((f) => `${d}/${f}`));
  const unnamed = files.filter((f) => !section(dirs[path.dirname(f)]).includes(`\`${path.basename(f)}\``)).sort();
  check(`tests/README.md names every browser and real-database test file in its suite's section (${files.length})`,
    files.length > 10 && Object.values(dirs).every((h) => section(h)) && !unnamed.length, `missing ${unnamed.join(', ')}`);
}
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

// CLAUDE.md "Client code" says what index.html and day.html load, in order: each script either page loads
// (index.html's page modules aside: "then the module files") is named in that page's line, in the page's order,
// and day.html's line names each of its stylesheets. So a script added to a page (v1.3's plan.js) is added there too.
{
  // The page's line, from "loads `" (its list of files) to the end of that sentence.
  const line = (re) => {
    const l = clientSec.split('\n').find((x) => re.test(x)) || '';
    const at = l.search(/\bloads `/);
    const s = at < 0 ? '' : l.slice(at);
    const end = s.search(/\.\s+[A-Z]/);
    return s.slice(0, end < 0 ? undefined : end + 1);
  };
  const loads = { 'index.html': line(/^- `index\.html` loads/), 'day.html': line(/^- `day\.html` is/) };
  for (const [page, text] of Object.entries(loads)) {
    const html = read(page).replace(/<!--[\s\S]*?-->/g, '');
    const srcs = [...html.matchAll(/<script\s+src="([^"?]+)/g)].map((m) => m[1]).filter((s) => !/^assets\/modules\//.test(s));
    // Where the line names a script, at or after `from` (the line may name one earlier too, in passing).
    const at = (src, from) => {
      const re = /supabase-js/.test(src) ? /supabase-js/g : new RegExp(`\`(?:assets/)?${path.basename(src).replace('.', '\\.')}\``, 'g');
      re.lastIndex = from;
      const m = re.exec(text);
      return m ? m.index : -1;
    };
    const missing = srcs.filter((s) => at(s, 0) < 0);
    let from = 0;
    const outOfOrder = srcs.filter((s) => { const p = at(s, from); if (p < 0) return true; from = p + 1; return false; });
    check(`CLAUDE.md "Client code" names the scripts ${page} loads, in its order (${srcs.map((s) => path.basename(s)).join(', ')})`,
      !!text && !missing.length && !outOfOrder.length, missing.length ? `missing ${missing.join(', ')}` : `out of order from ${outOfOrder.join(', ')}: ${text.slice(0, 300)}`);
    if (page !== 'day.html') continue;
    const css = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"?]+)/g)].map((m) => path.basename(m[1]));
    const missingCss = css.filter((c) => !text.includes(`${c}\``));
    check(`CLAUDE.md "Client code" names the stylesheets day.html loads (${css.join(', ')})`, css.length > 0 && !missingCss.length, `missing ${missingCss.join(', ')}`);
  }
}
// Each way into day.html (the ?x= its script reads: t, the My day link; c, the confirmation email; from v1.3 h,
// the tutor link) is described in CLAUDE.md "Client code" and in docs/v2-design.md §4 "Client".
{
  const dayJs = read('assets/day.js');
  const params = [...new Set([...dayJs.matchAll(/\bquery\.(?:get|has)\('([a-z]+)'\)/g)].map((m) => m[1]))].sort();
  const client = section(read('docs/v2-design.md'), /^## 4\. Client/);
  const undescribed = params.filter((k) => !clientSec.includes(`day.html?${k}=`) || !client.includes(`day.html?${k}=`));
  check(`CLAUDE.md "Client code" and docs/v2-design.md §4 describe every way into day.html (${params.map((k) => `?${k}=`).join(', ')})`,
    params.length >= 2 && !undescribed.length, `missing ${undescribed.map((k) => `day.html?${k}=`).join(', ')}`);
}

// ---------------------------------------------------------------------
// Share (Web Share) shows wherever the browser has navigator.share, not only on phones
// ---------------------------------------------------------------------
// hub.js canShare() asks the browser only. Safari on a Mac and Chrome and Edge on Windows have Web Share
// too, so the README's line on Share mustn't promise phones only.
const canShareSrc = (/const canShare = \(\) => ([^;\n]+);/.exec(read('assets/hub.js')) || [])[1];
const shareLine = (/^- \*\*Share\*\*.*$/m.exec(read('README.md')) || [''])[0];
check('README: Share shows wherever the browser has a share menu (hub.js canShare), some desktops too, not phones only',
  canShareSrc === 'typeof navigator.share === \'function\'' && !!shareLine && !/phones? only|only on (a |your )?phones?/i.test(shareLine) && /desktop/i.test(shareLine),
  [canShareSrc, shareLine]);

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
// From migration 0004 (v1.2) on, the design writes the database out in full (§9): the tables as
// the migration creates them, every function. 0002 and 0003 are summarised (§3, §8).
const FULL_FROM = '0004';
const migLater = sqlNoComments(migrationFiles.filter((f) => f >= FULL_FROM).map((f) => read(`supabase/migrations/${f}`)).join('\n'));
// The design's ```sql blocks, without their comments.
const designSql = sqlNoComments([...design.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n'));

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

// From 0004 on, the private ones too (§9 lists every helper, with who may call it).
const laterFns = functions(migLater);
const laterPrivate = [...new Set(laterFns.filter((f) => f.schema === 'private').map((f) => f.name))].sort();
const missingPrivate = laterPrivate.filter((n) => !designWords.has(n));
check(`docs/v2-design.md names every private function migration ${FULL_FROM} and later add (${laterPrivate.length})`,
  laterPrivate.length > 0 && !missingPrivate.length, `missing ${missingPrivate.join(', ')}`);

// A function a migration renames (a wrapped function's old body, "digest_for_v3") is named in the design
// under both names, and so is the rule for changing a wrapped function later.
const renamed = [...mig.matchAll(/alter\s+function\s+(?:public|private)\.(\w+)\s*\([^)]*\)\s+rename\s+to\s+(\w+)/gi)].map((m) => [m[1], m[2]]);
const missingRenamed = renamed.flat().filter((n) => !designWords.has(n));
check(`docs/v2-design.md names every function a migration renames, old and new name (${renamed.map((r) => r.join(' → ')).join(', ')})`,
  renamed.length > 0 && !missingRenamed.length, `missing ${missingRenamed.join(', ')}`);
check('docs/v2-design.md says a later change to a wrapped function replaces the wrapper and its _v3 body together',
  !renamed.some(([, to]) => /_v\d+$/.test(to)) || /replaces the wrapper and its `?_v3`? body together/.test(design));

// Every signature written out in the design (and in the v1.1, v1.2 and v1.3 designs,
// docs/v1.1-google-calendar.md, docs/v1.2-kitchen.md and docs/v1.3-homework.md) has the real parameter names,
// in order. A signature is
// "f()" or arguments that are parameters: "p" or "p_…" (the migrations' naming), or a name and a type
// ("p_from date", "t public.tasks"), or any plain names after a schema ("private.series_after(t, p_after)").
// A call ("monday(start)", "series_after(greatest(due_date,
// done_on))") isn't one. "f()" for a function whose parameters all have defaults is a call too.
const PARAM = /^(?:out\s+)?(?:p(?:_[a-z0-9_]*)?|[a-z_][a-z0-9_]*\s+[a-z_][a-z0-9_.]*(?:\[\])?)(?:\s+[a-z_][a-z0-9_.]*(?:\[\])?|\s+default\s+\S+)*$/i;
const designSignatures = new Set();   // the functions whose signature docs/v2-design.md writes out
for (const [file, text] of [['docs/v2-design.md', design], ['docs/v1.1-google-calendar.md', read('docs/v1.1-google-calendar.md')],
  ['docs/v1.2-kitchen.md', read('docs/v1.2-kitchen.md')], ['docs/v1.3-homework.md', read('docs/v1.3-homework.md')]]) {
  const wrong = [];
  let signatures = 0;
  for (const m of text.matchAll(/(?<![\w.])(?:(public|private)\.)?([a-z_][a-z0-9_]*)\(([^()]*)\)/g)) {
    const cands = (byName.get(m[2]) || []).filter((f) => !m[1] || f.schema === m[1]);
    if (!cands.length) continue;
    const args = splitArgs(m[3]);
    // Written with its schema ("private.has_secrets(id)"), plain names count as parameters too.
    if (!args.every((a) => PARAM.test(a) || (m[1] && /^[a-z_][a-z0-9_]*(?:\s+[a-z_][a-z0-9_.]*(?:\[\])?)*$/i.test(a)))) continue;
    const names = args.filter((a) => !/^out\s/i.test(a)).map((a) => a.split(/\s+/)[0].toLowerCase());
    signatures++;
    const right = cands.filter((f) => f.params.join() === names.join() || (!names.length && f.optional));
    if (!right.length) wrong.push(`${m[0]} → ${cands.map((f) => `${f.schema}.${f.name}(${f.params.join(', ')})`).join(' or ')}`);
    else if (file === 'docs/v2-design.md') for (const f of right) designSignatures.add(`${f.schema}.${f.name}`);
  }
  check(`${file}: every function signature it writes out has the migration's parameter names (${signatures} checked)`, signatures > 0 && !wrong.length, wrong.join(' | '));
}
// From 0004 on, the design writes out every public function's signature, parameters and all.
const laterPublic = [...new Set(laterFns.filter((f) => f.schema === 'public').map((f) => f.name))].sort();
const unwritten = laterPublic.filter((n) => !designSignatures.has(`public.${n}`));
check(`docs/v2-design.md writes out the signature of every public function migration ${FULL_FROM} and later add or replace (${laterPublic.length})`,
  laterPublic.length > 0 && !unwritten.length, `missing ${unwritten.join(', ')}`);

// The functions anon can call (the My day page and the share page) are the ones the design lists.
const anon = new Set();
for (const m of mig.matchAll(/grant\s+execute\s+on\s+function\s+public\.(\w+)\([^)]*\)\s+to\s+([^;]+);/gi)) if (/\banon\b/.test(m[2])) anon.add(m[1].toLowerCase());
const tokenSec = design.slice(design.indexOf('### Anonymous token functions'), design.indexOf('### ', design.indexOf('### Anonymous token functions') + 5));
const missingAnon = [...anon].filter((n) => !words(tokenSec).has(n)).sort();
check(`docs/v2-design.md "Anonymous token functions" lists every function anon can call (${[...anon].sort().join(', ')})`, anon.size > 0 && !missingAnon.length, `missing ${missingAnon.join(', ')}`);
// Each function anon can call is a decision (a secret is its only key): adding one means adding it here,
// to the design and to tests/db/access.test.sql. 0002: My day and the confirmation email; 0004 (v1.2):
// the helper's shopping list; 0005 (v1.3): a kid's homework on My day (seven) and the tutor link (four);
// 0006 (v1.3's school feed): his New from school (one).
const ANON = ['add_to_list_by_token', 'assignment_by_token', 'buy_item_by_token', 'complete_by_token', 'confirm_digest', 'focus_by_token',
  'get_list_by_token', 'get_person_day', 'homework_by_token', 'homework_prefs_by_token', 'plan_by_token', 'reward_by_token',
  'school_item_by_token', 'step_by_token', 'stop_digest', 'tutor_assignment_by_token', 'tutor_plan_by_token', 'tutor_step_by_token',
  'tutor_view_by_token', 'undo_by_token'];
check(`the migrations let anon call exactly the ${ANON.length} token functions this check knows`, [...anon].sort().join() === ANON.join(), [...anon].sort());
// They are all day.html's (My day, and from v1.3 the tutor link's mode), and CLAUDE.md says day.html calls only them.
const missingClaude = ANON.filter((n) => !clientSec.includes(`\`${n}\``));
check(`CLAUDE.md "Client code" names every token function day.html may call (${ANON.length})`, !missingClaude.length, `missing ${missingClaude.join(', ')}`);
const NUMBER = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const counted = (/These (\w+) are the only new functions anon can call/.exec(tokenSec) || [])[1];
check(`docs/v2-design.md "Anonymous token functions" counts them right ("These ${counted} are the only new functions anon can call": ${anon.size})`,
  NUMBER[String(counted).toLowerCase()] === anon.size, tokenSec.slice(0, 300));

// docs/v1.2-kitchen.md §2 counts the functions 0004 adds ("six new public and … new private functions"):
// those under a name no earlier file has (a wrapper, made again under its old name once the old body is
// renamed, isn't new).
{
  const earlier = sqlNoComments([read('supabase/schema.sql'), ...migrationFiles.filter((f) => f < '0004').map((f) => read(`supabase/migrations/${f}`))].join('\n'));
  const old = new Set(functions(earlier).map((f) => `${f.schema}.${f.name}`));
  const m0004 = migrationFiles.find((f) => f.startsWith('0004'));
  const added = functions(sqlNoComments(read(`supabase/migrations/${m0004}`))).filter((f) => !old.has(`${f.schema}.${f.name}`));
  const count = (schema) => new Set(added.filter((f) => f.schema === schema).map((f) => f.name)).size;
  const N = NUMBER;
  const said = /(\w+) new public and (\w+) new private functions/.exec(section(read('docs/v1.2-kitchen.md'), /^## 2\. What ships/)) || [];
  check(`docs/v1.2-kitchen.md §2 counts the functions 0004 adds ("${said[1]} new public and ${said[2]} new private": ${count('public')} and ${count('private')})`,
    N[String(said[1]).toLowerCase()] === count('public') && N[String(said[2]).toLowerCase()] === count('private'), said[0]);
}

// docs/v1.3-homework.md §2.1 counts what 0005 adds ("Eleven tables (`homework_kids`, …); three `household`
// columns; twenty-five new public functions (…) and twenty-six new private ones"), and names its tables.
{
  const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
  const num = (w) => {   // "eleven" → 11, "twenty-five" → 25
    const s = String(w).toLowerCase();
    if (ONES[s] || NUMBER[s]) return ONES[s] || NUMBER[s];
    const [t, o] = s.split('-');
    return TENS[t] && (o === undefined || ONES[o]) ? TENS[t] + (o ? ONES[o] : 0) : NaN;
  };
  const earlier = sqlNoComments([read('supabase/schema.sql'), ...migrationFiles.filter((f) => f < '0005').map((f) => read(`supabase/migrations/${f}`))].join('\n'));
  const old = new Set(functions(earlier).map((f) => `${f.schema}.${f.name}`));
  const m0005 = sqlNoComments(read(`supabase/migrations/${migrationFiles.find((f) => f.startsWith('0005'))}`));
  const added = functions(m0005).filter((f) => !old.has(`${f.schema}.${f.name}`));
  const count = (schema) => new Set(added.filter((f) => f.schema === schema).map((f) => f.name)).size;
  const made = [...m0005.matchAll(/create\s+table\s+public\.(\w+)\s*\(/gi)].map((m) => m[1]).sort();
  const householdCols = [...((/alter\s+table\s+public\.household\s+((?:\s*add\s+column\s+[^,;]+[,;])+)/i.exec(m0005) || [])[1] || '').matchAll(/add\s+column\s+(\w+)/gi)].length;
  const row = section(read('docs/v1.3-homework.md'), /^## 2\. What ships/).split('\n').find((l) => l.includes('`supabase/migrations/0005_homework.sql`')) || '';
  const said = /(\w+) tables \(([^)]*)\); (\w+) `household` columns; ([\w-]+) new public functions \([^)]*\) and ([\w-]+) new private ones/.exec(row) || [];
  const named = [...String(said[2]).matchAll(/`(\w+)`/g)].map((m) => m[1]).sort();
  check(`docs/v1.3-homework.md §2.1 counts what 0005 adds ("${said[1]} tables; ${said[3]} household columns; ${said[4]} new public and ${said[5]} new private functions": `
    + `${made.length}; ${householdCols}; ${count('public')} and ${count('private')})`,
  num(said[1]) === made.length && num(said[3]) === householdCols && num(said[4]) === count('public') && num(said[5]) === count('private'), row.slice(0, 300));
  check('docs/v1.3-homework.md §2.1 names the tables 0005 makes', made.length > 0 && named.join() === made.join(), `says ${named.join(', ')}; makes ${made.join(', ')}`);
  // §3.6: "anon can call **nineteen** token functions".
  const anonSaid = (/anon can call \*\*(\w+)\*\* token functions/.exec(read('docs/v1.3-homework.md')) || [])[1];
  check(`docs/v1.3-homework.md §3.6 counts the token functions anon can call ("${anonSaid}": ${anon.size})`, num(anonSaid) === anon.size, anonSaid);
}

// Every table, column and agenda_item field the migrations add is in the design (tables in private too).
const tables = [];
const columns = [];
for (const m of mig.matchAll(/create\s+(table|type)\s+(?:public|private)\.(\w+)\s*(?:as\s*)?\(([\s\S]*?)\n\);/gi)) {
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

// From 0004 on, the design writes out each new table (create table, in public or private), added column
// (alter table … add column) and added or dropped constraint exactly as the migration has it, comments and
// spacing aside, in its ```sql blocks: so a column, a default or a check that changes in one changes in the other.
const flat = (s) => s.replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').trim().toLowerCase();
const statements = [...migLater.matchAll(/create\s+table\s+(?:public|private)\.\w+\s*\([\s\S]*?\n\);|alter\s+table\s+public\.\w+\s+(?:add|drop)\s+(?:column|constraint)\b[^;]*;/gi)].map((m) => m[0]);
const designFlat = flat(designSql);
// A create table's body as {column or table constraint: its definition}, for saying what differs.
function definitions(body) {
  const out = {};
  let cur = null;
  let n = 0;
  for (const l of sqlNoComments(body).split('\n')) {
    const c = /^\s{1,3}([a-z_][a-z0-9_]*)\s+\S/i.exec(l);
    if (c) cur = /^(check|primary|unique|foreign|constraint)$/i.test(c[1]) ? `table constraint ${++n} (${c[1].toLowerCase()})` : c[1];
    if (cur) out[cur] = flat(`${out[cur] || ''} ${l}`).replace(/,$/, '');
  }
  return out;
}
const notWritten = statements.filter((st) => !designFlat.includes(flat(st))).map((st) => {
  const t = /^create\s+table\s+(public|private)\.(\w+)/i.exec(st);
  if (!t) return flat(st).slice(0, 80);
  // Which columns differ, when the design has a block for the table.
  const block = new RegExp(`create\\s+table\\s+${t[1]}\\.${t[2]}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i').exec(designSql);
  if (!block) return `create table ${t[1]}.${t[2]} (no block in the design)`;
  const want = definitions(/\(([\s\S]*)\n\);$/.exec(st)[1]);
  const have = definitions(block[1]);
  const diff = [...Object.keys(want).filter((c) => !(c in have)).map((c) => `missing ${c}`),
    ...Object.keys(have).filter((c) => !(c in want)).map((c) => `not in the migration: ${c}`),
    ...Object.keys(want).filter((c) => c in have && want[c] !== have[c]).map((c) => `${c} differs: "${want[c]}"`)];
  return `create table ${t[1]}.${t[2]}: ${diff.join('; ') || 'the order differs'}`;
});
check(`docs/v2-design.md writes out every table, added column and constraint of migration ${FULL_FROM} and later as the migration has it (${statements.length})`,
  statements.length > 0 && !notWritten.length, notWritten.join(' | '));

// ---------------------------------------------------------------------
// Example data in the docs is fictional (CLAUDE.md "Test data"): phone numbers in 555-0100 to 555-0199
// ---------------------------------------------------------------------
for (const f of ['CLAUDE.md', 'README.md', 'docs/v2-design.md', 'docs/v1.1-google-calendar.md', 'docs/v1.2-kitchen.md',
  'docs/v1.3-homework.md', 'tests/README.md']) {
  const bad = [...read(f).matchAll(/\b555-(\d{4})\b/g)].map((m) => m[0]).filter((n) => !/^555-01\d\d$/.test(n));
  check(`${f}: example phone numbers are fictional (555-0100 to 555-0199)`, !bad.length, bad);
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`== docs: ${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
