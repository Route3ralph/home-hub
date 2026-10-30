// No labels (docs/v1.3-homework.md §13.1 item 8). Homework is executive-function support that suits any kid:
// starting, timing and planning. Nothing in this repository gives anyone a medical or learning label, and nothing
// asks for or stores one: no column, word list, prompt, fixture or doc. This checks every text file under
// supabase/ (the migrations, and from PR B the AI planner's prompt in hub-jobs), assets/, tests/ (the fixtures and
// every test) and the pages and docs, for a word from the list below, which lives only here: this folder is the one
// place left out.
// Reads files only. Run alone with: node tests/docs/labels.test.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const results = [];
const check = (name, ok, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  (${String(detail).slice(0, 400)})` : ''}`;
  results.push(line);
  console.log(line);
};

// Each entry: a pattern (case-insensitive, matched as a whole word), and a spelling it must find (the self-check below).
const LABELS = [
  ['a\\.?d\\.?h\\.?d', 'ADHD'],
  ['autis(?:m|tic)', 'autistic'],
  ["asperger(?:'?s)?", "Asperger's"],
  ['dys(?:lexi|calculi|graphi|praxi)(?:a|c)', 'dyslexic'],
  ['neurodiver(?:gent|gence|se|sity)', 'neurodivergent'],
  ['neurotypical', 'neurotypical'],
  ['disabilit(?:y|ies)', 'disability'],
  ['learning (?:differences?|difficult(?:y|ies))', 'learning difference'],
  ['disorders?', 'disorder'],
  ['diagnos(?:is|es|ed)', 'diagnosed'],
  ['iep', 'IEP'],
  ['504 plan', '504 plan'],
  ['ocd', 'OCD'],
  ['special (?:needs|education)', 'special needs'],
  ['medicat(?:ion|ions|ed)', 'medication'],
  ['ritalin|adderall|concerta|vyvanse|strattera', 'Ritalin'],
  ['executive dysfunction', 'executive dysfunction'],
  ['anxiety', 'anxiety'],
  ['depression', 'depression'],
  ["tourette(?:'?s)?", 'Tourette'],
  ['on the spectrum', 'on the spectrum'],
  ['twice[- ]exceptional', 'twice-exceptional'],
];
const matcher = new RegExp(`(?<![A-Za-z0-9_])(?:${LABELS.map(([p]) => p).join('|')})(?![A-Za-z0-9_])`, 'gi');

// The matcher finds every listed word in a line, and nothing in ordinary homework words.
const missed = LABELS.filter(([, word]) => !new RegExp(matcher.source, 'i').test(`Jordan's plan, ${word}, by Fri.`)).map(([, w]) => w);
check(`the list's matcher finds each of its ${LABELS.length} words`, !missed.length, `misses ${missed.join(', ')}`);
const ordinary = 'Executive-function support: starting, timing and planning. Add a step; disabled button; a diagnostic line; Sped up; recipe; pieces.';
check('the matcher passes ordinary words (executive-function support, add, disabled, diagnostic)', !new RegExp(matcher.source, 'i').test(ordinary),
  ordinary.match(matcher));

// The files: text files under these folders and at the top, never this folder, third-party code or test output.
const TEXT = /\.(?:sql|ts|js|css|html|json|toml|md|sh|txt|webmanifest)$/i;
const SKIP = new Set(['.git', 'node_modules', 'vendor', 'shots', '.tmp']);
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name) && p !== __dirname) walk(p, out); } else if (TEXT.test(e.name)) out.push(p);
  }
  return out;
}
const AREAS = {
  'supabase/ (migrations, functions, the AI prompt)': walk(path.join(ROOT, 'supabase'), []),
  'assets/': walk(path.join(ROOT, 'assets'), []),
  'tests/ (fixtures and tests, but tests/docs/)': walk(path.join(ROOT, 'tests'), []),
  'the pages and docs (*.html, *.md, docs/)': [...fs.readdirSync(ROOT).filter((f) => TEXT.test(f)).map((f) => path.join(ROOT, f)), ...walk(path.join(ROOT, 'docs'), [])],
};
const rel = (p) => path.relative(ROOT, p);
const all = Object.values(AREAS).flat().map(rel);
check(`the scan reads the files that matter (${all.length} files)`, all.length > 100
  && ['supabase/migrations/0005_homework.sql', 'assets/plan.js', 'assets/day.js', 'tests/db/fixtures.sql', 'tests/e2e/mock.js', 'tests/realdb/seed_v2.sql',
    'docs/v1.3-homework.md', 'README.md', 'day.html'].every((f) => all.includes(f)) && !all.some((f) => f.startsWith('tests/docs/')));

for (const [area, files] of Object.entries(AREAS)) {
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      for (const m of l.matchAll(matcher)) hits.push(`${rel(f)}:${i + 1} "${m[0]}"`);
    });
  }
  check(`${area}: no word of a medical or learning label (${files.length} files)`, files.length > 0 && !hits.length, hits.join('; '));
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`== labels: ${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
