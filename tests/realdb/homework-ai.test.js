// The AI planner (v1.3 PR B, docs/v1.3-homework.md §6) against the REAL database (tests/realdb/run.sh): the pages in
// Chromium, the real hub-jobs handler (homework.ts, through supabase/functions/hub-jobs/handler.ts) as service_role on
// this database (homework_ai_start, homework_ai_finish), and a fake Anthropic (lib.js: every request kept; a valid plan
// built from the user message's own fields, or a reply queued). Its own copy of the database. Mon Nov 2 at 9:00am in
// New York; homework on for Jordan (20 minutes, Mon–Thu 4:30–5:15), Pat's link, and the science project, whose
// teacher's text names the made-up school, a teacher, her address, a phone number and a link.
//   switch   Alex's Homework page: "AI planner: off", no switch; Test the AI planner (hub-jobs, kind test): the request
//            to Anthropic exactly (URL, headers, model, the test message as homework_ai_preview gives it); its ai_runs
//            row (tokens, cents); "Working · claude-opus-5-5 …"; on with no word never to send is refused by the
//            database; two words added; on.
//   parents  The assignment: What Claude will see is homework_ai_preview's text, and exactly what Anthropic gets
//            (nothing of the school, the teacher, the address, the phone, the link, a name, an id or a token); Send to
//            Claude; the draft placed by the database (ai_draft, ai_runs); Use this plan, a step changed, Save: the
//            steps ai and typed in homework_steps, the stretch question copied, not given yet.
//   pat      Pat's link (signed out): Ask again with "Smaller steps" (a revise with his token): what Anthropic gets is
//            what his preview showed, with the typed step locked; the fake changes it and leaves the rest out, and the
//            database's draft has the people's version back with its step's id; Use this plan, Give: still typed.
//            Only the tutor functions and hub-jobs are called. Jordan's My day: "Plan by Pat, with AI help".
//   locked   A revision whose run is open while Jordan ticks his first step (the database numbers the steps again when
//            the answer comes, so the draft's ids point one step on), and whose locked step names Pat, a link and '<'
//            (the draft holds the scrubbed copy the AI was sent): Use this plan, Save keeps each person's step as they
//            left it, with its own id, and writes no step over another.
//   stops    Through the API: a malformed token, Jordan's day token and a link that may not ask (not_found, nothing
//            sent); the switch off; a refusal (refusal_cyber, the draft kept, the editor's words, the starter plans
//            still there); a 401 (auth); a resent key (its run, no second request); no key (not_set_up, no run).
// Screenshots: tests/e2e/shots/realdb-homework-ai-*.png.
const { setup } = require('./lib');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MON = '2026-11-02';
const at = (day, hm) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`;   // New York, standard time
const TEXT = 'Make a poster about one river for North Field School.\nAsk Ms. Rivera if you are stuck: rivera@school.example, (201) 555-0100,'
  + ' https://example.com/rubric.\nJordan: two sources at least.';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// The seal hub-jobs checks (plan.js's previewSeal): FNV-1a over the code points of the message without its request and
// answers, 8 hex characters.
const fnv = (t) => { let h = 0x811c9dc5; for (const ch of String(t)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const seal = (t) => fnv(String(t).split('\n<request from="')[0].split('\n<answers>\n')[0]);
const TUTOR_OR_JOBS = /^\/(rest\/v1\/rpc\/(tutor_view_by_token|tutor_assignment_by_token|tutor_plan_by_token|tutor_step_by_token)|functions\/v1\/hub-jobs)$/;

(async () => {
  const h = await setup('homework_ai');
  const { check, flow, sql, open, go, tc, texts, lastToast, until, shot } = h;
  const one = async (q) => (await sql(q))[0] || null;
  const P = {};
  for (const r of await sql('select id, name, email, day_token from people')) P[r.name.split(' ')[0].toLowerCase()] = r;
  const people = await sql('select id, name, email from people');
  const failures = async () => (await h.failed()).map((r) => `${r.method} ${r.path}${r.query} → ${r.status} ${r.error ? `${r.error.code || ''} ${r.error.message || r.error.msg || r.error.error || ''}` : ''}`);
  const rpcAs = async (email, name, args) => {
    const token = (await h.sessionFor(email)).access_token;
    return h.api(`/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  };
  const jobs = (body) => h.api('/functions/v1/hub-jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ action: 'homework_ai' }, body)) });
  const runs = () => sql('select id, kind, asked_by, link_id, status, stop, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cents from ai_runs order by started_at, id');
  const sent = () => h.anthropic.requests;
  const userOf = (r) => r && r.body && r.body.messages && r.body.messages[0] && r.body.messages[0].content;
  // What the AI must never see: the never-send words, the teacher's address, phone and link, any family name or email,
  // any id, Jordan's day token or a tutor link's token.
  const leaks = (text, tokens) => {
    const found = [];
    for (const w of ['North Field', 'Rivera', 'rivera@', '555-0100', 'example.com/rubric', '@']) if (text.includes(w)) found.push(w);
    for (const p of people) {
      for (const part of p.name.split(' ')) if (new RegExp(`\\b${part}\\b`).test(text)) found.push(part);
    }
    if (UUID.test(text)) found.push('an id');
    for (const t of tokens) if (t && text.includes(t)) found.push('a token');
    return [...new Set(found)];
  };

  // Homework on for Jordan, his homework time, Pat's link (and one that may not ask), and the science project.
  await h.setClock(at(MON, '09:00'));
  let link = null;
  let noAi = null;
  let sci = null;
  await flow('setup', async () => {
    const on = await rpcAs('alex@example.com', 'save_homework_kid', { p_kid: P.jordan.id, p_active: true });
    const time = await rpcAs('alex@example.com', 'add_homework_time', { p_kid: P.jordan.id, p_weekdays: [1, 2, 3, 4], p_start: '16:30', p_end: '17:15' });
    await sql(`update homework_kids set focus_minutes = 20 where kid_id = '${P.jordan.id}'`);
    const l1 = await rpcAs('alex@example.com', 'save_tutor_link', { p_link: null, p_kid: P.jordan.id, p_label: 'Pat Lee, tutor', p_language: 'en', p_expires_on: null, p_can_ai: true, p_active: true });
    const l2 = await rpcAs('alex@example.com', 'save_tutor_link', { p_link: null, p_kid: P.jordan.id, p_label: 'Taylor', p_language: 'es', p_expires_on: null, p_can_ai: false, p_active: true });
    link = await one(`select id, token from tutor_links where id = '${l1.body}'`);
    noAi = await one(`select id, token from tutor_links where id = '${l2.body}'`);
    const a = await one(`insert into assignments (kid_id, title, subject, due_date, details, created_by)
      values ('${P.jordan.id}', 'Science project: river poster', 'Science', '2026-11-13', '${TEXT.replace(/'/g, "''")}', 'alex@example.com') returning id`);
    sci = a.id;
    check('setup: homework on for Jordan, his homework time, two tutor links (one that may not ask the AI) and the science project',
      [200, 204].includes(on.status) && time.status === 200 && !!link && !!noAi && !!sci, [on.status, time.status, l1.body, l2.body]);
    const hh = await one('select homework_ai, homework_never_send, homework_ai_month from household');
    check('setup: the AI planner starts off, with no word never to send and 150 runs a month', same([hh.homework_ai, hh.homework_never_send, hh.homework_ai_month], ['f', '{}', '150']), hh);
  });

  // ===================================================================
  // The switches card: Test, Words never to send, on
  // ===================================================================
  await flow('switch', async () => {
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: '/#/homework', label: 'ai-alex-switch' });
    const row = '[data-row="ai"]';
    await page.waitForSelector(row, { timeout: 8000 });
    check('switch: "AI planner: off", Test the AI planner, Words never to send; no switch before a Working test',
      /AI planner: off/.test(await tc(page, row)) && !!(await page.$(`${row} [data-act="ai-test"]`)) && !(await page.$(`${row} input[data-act="ai-on"]`)), await tc(page, row));
    await page.click(`${row} [data-act="ai-test"]`);
    await until(async () => (await sql("select 1 from ai_runs where kind = 'test'")).length === 1, 5000);
    await h.aiDone();
    const r = sent()[0];
    check('Test: one request to https://api.anthropic.com/v1/messages, POST', sent().length === 1 && r.url === 'https://api.anthropic.com/v1/messages' && r.method === 'POST',
      sent().map((x) => x.url));
    check('... its four headers: the key (the function\'s secret), anthropic-version 2026-10-21, the fallback beta, JSON',
      !!r && same(r.headers, { 'x-api-key': h.AI_KEY, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01', 'content-type': 'application/json' }), r && r.headers);
    check('... the model claude-opus-5-5, 12000 max_tokens, effort medium, the plan schema, fallbacks default, one user message, the system prompt cached',
      !!r && r.body.model === 'claude-opus-5-5' && r.body.max_tokens === 12000 && r.body.output_config.effort === 'medium' && r.body.output_config.format.type === 'json_schema'
      && r.body.fallbacks === 'default' && r.body.messages.length === 1 && r.body.messages[0].role === 'user' && r.body.system[0].cache_control.type === 'ephemeral'
      && !['thinking', 'temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'stream'].some((k) => k in r.body), r && Object.keys(r.body));
    const testMsg = (await rpcAs('alex@example.com', 'homework_ai_preview', { p_assignment: null, p_kind: 'test' })).body;
    check('... the user message is the database\'s made-up test assignment (homework_ai_preview p_kind test), nothing of the family',
      userOf(r) === testMsg && /Book report on a novel you choose/.test(testMsg) && !leaks(testMsg, [P.jordan.day_token, link.token]).length, leaks(String(userOf(r)), []));
    const run = (await runs())[0];
    check('... its ai_runs row: test, by Alex, ready, the model that answered, the tokens and the estimate (5.60 cents at claude-opus-5-5\'s prices)',
      !!run && same([run.kind, run.asked_by, run.link_id, run.status, run.stop, run.model, run.input_tokens, run.cache_read_tokens, run.cache_write_tokens, run.output_tokens, run.cents],
        ['test', 'alex@example.com', null, 'ready', null, 'claude-opus-5-5', '1000', '0', '1600', '2200', '5.60']), run);
    await page.clock.runFor(2500);
    await until(async () => /Working ·/.test(await tc(page, row)), 5000);
    check('... the card: "Working · claude-opus-5-5 · 1 s · about 6 cents", and now the switch (off)', /Working · claude-opus-5-5 · \d+ s · about 6 cents/.test(await tc(page, `${row} .hw-ai-test`))
      && (await page.$eval(`${row} input[data-act="ai-on"]`, (i) => i.checked).catch(() => null)) === false, await tc(page, row));
    await page.click(`${row} input[data-act="ai-on"]`);
    await until(async () => /Words never to send first/.test(await lastToast(page)), 5000);
    check('switch on with no word never to send: refused by the database ("Add the school\'s name to Words never to send first."), still off',
      /Add the school's name to Words never to send first\./.test(await lastToast(page)) && (await one('select homework_ai from household')).homework_ai === 'f', await lastToast(page));
    for (const word of ['North Field School', 'Rivera']) {
      await page.fill(`${row} form[data-form="never"] input[name="word"]`, word);
      await page.click(`${row} form[data-form="never"] button[type="submit"]`);
      await until(async () => (await one('select homework_never_send from household')).homework_never_send.includes(word.split(' ')[0]), 5000);
      await h.settle(page);
    }
    check('Words never to send: both saved (household.homework_never_send)', (await one('select homework_never_send from household')).homework_never_send === '{"North Field School",Rivera}',
      await one('select homework_never_send from household'));
    await page.click(`${row} input[data-act="ai-on"]`);
    await until(async () => (await one('select homework_ai from household')).homework_ai === 't', 5000);
    await h.settle(page);
    check('... then on: household.homework_ai true, "AI planner: on"', (await one('select homework_ai from household')).homework_ai === 't' && /AI planner: on/.test(await tc(page, row)), await tc(page, row));
    await shot(page, 'homework-ai-switch');
    const f = (await failures()).filter((x) => !/PATCH \/rest\/v1\/household.*→ 400/.test(x));
    check('switch: no API request failed but the refused switch', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // A parent's Send to Claude: the preview is what is sent; the draft; Use this plan; Save
  // ===================================================================
  await flow('parents', async () => {
    if (!sci) throw new Error('no assignment');
    await h.setClock(at(MON, '09:10'));
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/homework/${sci}`, label: 'ai-alex-plan' });
    await page.waitForSelector('.plan-ai-preview .plan-ai-text', { timeout: 8000 });
    const preview = await page.$eval('.plan-ai-preview .plan-ai-text', (e) => e.textContent);
    const db = (await rpcAs('alex@example.com', 'homework_ai_preview', { p_assignment: sci, p_kind: 'plan' })).body;
    check('parents: What Claude will see (open the first time) is homework_ai_preview\'s text, as it is', preview === db && (await page.$eval('.plan-ai-preview', (d) => d.open)) === true,
      [preview.slice(0, 200), String(db).slice(0, 200)]);
    check('... scrubbed: the school and the teacher (words never to send), her address, the phone, the link and his name taken out',
      !leaks(preview, [P.jordan.day_token, link.token]).length && /\[email\]/.test(preview) && /\[phone\]/.test(preview) && /\[link\]/.test(preview) && /\[name\]/.test(preview),
      leaks(preview, []).concat(preview.split('\n').filter((l) => /assignment_text|poster|stuck|sources/.test(l))));
    await page.click('[data-act="ai-send"]');
    await until(async () => /Thinking about a plan/.test(await tc(page, '.plan-editor')), 5000);
    await h.aiDone();
    const r = sent()[1];
    check('Send to Claude: Anthropic gets exactly that text as the user message', !!r && userOf(r) === preview, r && String(userOf(r)).slice(0, 300));
    check('... and nothing in the whole request names the family, an id or a token', !!r && !leaks(JSON.stringify(r.body), [P.jordan.day_token, link.token, noAi.token]).length,
      r && leaks(JSON.stringify(r.body), [P.jordan.day_token, link.token, noAi.token]));
    const run = (await runs())[1];
    check('... its ai_runs row: plan, by Alex, ready', !!run && same([run.kind, run.asked_by, run.link_id, run.status, run.stop], ['plan', 'alex@example.com', null, 'ready', null]), run);
    const a = await one(`select ai_state, ai_stop, ai_draft, ai_prev, ai_at from assignments where id = '${sci}'`);
    const d = a && JSON.parse(a.ai_draft || 'null');
    check('... the draft in the database: ready, five steps placed in his homework time (from today to Wed Nov 11) and the turn-in on the due date, each source ai',
      !!d && a.ai_state === 'ready' && !a.ai_prev && !!a.ai_at && d.steps.length === 5 && d.steps.every((s) => s.source === 'ai' && !s.id)
      && d.steps.slice(0, 4).every((s) => s.day >= MON && s.day <= '2026-11-11') && d.steps[4].kind === 'turn_in' && d.steps[4].day === '2026-11-13' && d.model === 'claude-opus-5-5',
      d && d.steps.map((s) => [s.kind, s.day, s.minutes]));
    await page.clock.runFor(5000);
    await until(async () => !!(await page.$('.plan-ai-draft')), 6000);
    check('the page reads it again after 5 seconds: "Draft · Suggested by AI (Claude). Check it with Jordan."',
      /Draft · Suggested by AI \(Claude\)\. Check it with Jordan\./.test(await tc(page, '.plan-ai-label')), await tc(page, '.plan-ai-label'));
    await shot(page, 'homework-ai-draft');
    await page.click('[data-act="ai-use"]');
    await h.settle(page, 200);
    await page.click('.plan-steps .plan-step[data-i="1"] [data-act="more"]');
    await page.fill('.plan-step-edit input[name="title"]', 'Find 3 sources and save their titles');
    await page.click('.plan-step-edit [data-act="close"]');
    await page.click('[data-act="save"]');
    await until(async () => (await sql(`select 1 from homework_steps where assignment_id = '${sci}'`)).length === 5, 6000);
    await until(async () => !!(await one(`select stretch from assignments where id = '${sci}'`)).stretch, 4000);
    const S = await sql(`select kind, title, source from homework_steps where assignment_id = '${sci}' order by pos`);
    check('Use this plan, one step changed, Save: homework_steps has the draft\'s steps, ai, the changed one typed', same(S.map((s) => s.source), ['ai', 'typed', 'ai', 'ai', 'ai'])
      && S[1].title === 'Find 3 sources and save their titles' && S[4].kind === 'turn_in', S);
    const g = await one(`select given_at, stretch from assignments where id = '${sci}'`);
    check('... not given yet, and the draft\'s stretch question copied to the assignment', !g.given_at && g.stretch === 'Which part of the river would you most like to show in detail?', g);
    const f = await failures();
    check('parents: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Pat's link asks again: his preview is what is sent; his typed step comes back as he left it
  // ===================================================================
  await flow('pat', async () => {
    if (!link || !sci) throw new Error('no link');
    await h.setClock(at(MON, '09:20'));
    await h.mark();
    const { page, context } = await open({ path: `/day.html?h=${link.token}#a/${sci}`, label: 'ai-pat' });
    await page.waitForSelector('.plan-ai-ask', { timeout: 8000 });
    check('pat: the parents\' draft is there, "Draft · Suggested by AI (Claude)…", with Ask again',
      /Draft · Suggested by AI \(Claude\)\. Check it with Jordan\./.test(await tc(page, '.plan-ai-label')), await tc(page, '.plan-ai-label'));
    await page.click('.plan-ai-ask [data-ai-chip="smaller"]');
    await page.clock.runFor(800);
    await until(async () => /Smaller steps/.test(await tc(page, '.plan-ai-preview .plan-ai-text')), 4000);
    const preview = await page.$eval('.plan-ai-preview .plan-ai-text', (e) => e.textContent);
    await page.click('[data-act="ai-again"]');
    await until(async () => /Thinking about a plan/.test(await tc(page, '.plan-editor')), 5000);
    await h.aiDone();
    const r = sent()[2];
    check('pat: Ask again sends exactly what his preview showed (the view\'s message and his request)', !!r && userOf(r) === preview
      && preview.includes('<request from="tutor">Smaller steps</request>'), r && [String(userOf(r)).slice(-400), preview.slice(-400)]);
    let plan = [];
    try { plan = JSON.parse((/<current_plan>([^]*?)<\/current_plan>/.exec(userOf(r) || '') || [])[1] || '[]'); } catch (e) { plan = []; }
    check('... a revise: current_plan is the saved steps with refs, never ids, and the one a person changed locked',
      plan.length === 5 && same(plan.map((x) => x.locked), [false, true, false, false, false]) && same(plan.map((x) => x.ref), ['s1', 's2', 's3', 's4', 's5'])
      && plan[1].title === 'Find 3 sources and save their titles', plan);
    check('... and nothing in it names the family, an id, his link\'s token or Jordan\'s', !leaks(JSON.stringify(r.body), [P.jordan.day_token, link.token, noAi.token]).length,
      leaks(JSON.stringify(r.body), [P.jordan.day_token, link.token, noAi.token]));
    const run = (await runs())[2];
    check('... its ai_runs row: revise, asked by "Pat Lee, tutor (tutor link)", his link, ready',
      !!run && same([run.kind, run.asked_by, run.link_id, run.status], ['revise', 'Pat Lee, tutor (tutor link)', link.id, 'ready']), run);
    const typed = await one(`select id, title, done_looks_like, minutes from homework_steps where assignment_id = '${sci}' and source = 'typed'`);
    const a = await one(`select ai_draft, ai_prev from assignments where id = '${sci}'`);
    const d = JSON.parse(a.ai_draft);
    const back = d.steps.filter((s) => s.id === typed.id);
    check('... the fake changed his locked step: the draft has the people\'s version back (title, "done looks like", minutes) with its step\'s id, after the new start',
      back.length === 1 && back[0].title === typed.title && back[0].done_looks_like === typed.done_looks_like && back[0].minutes === Number(typed.minutes)
      && !d.steps.some((s) => /\(changed\)/.test(s.title)) && d.steps[0].kind === 'start' && d.steps.indexOf(back[0]) >= 1, d.steps.map((s) => [s.kind, s.title, s.id]));
    check('... the first draft is ai_prev now (one Undo)', !!a.ai_prev && JSON.parse(a.ai_prev).steps.length === 5);
    await page.clock.runFor(5000);
    await until(async () => !!(await page.$('[data-act="ai-undo"]')), 6000);
    check('pat: the page reads it again (p_part ai) and shows the new draft with Undo', !!(await page.$('[data-act="ai-undo"]')));
    await page.click('[data-act="ai-use"]');
    await h.settle(page, 200);
    await page.click('[data-act="give"]');
    await until(async () => !!(await one(`select given_at from assignments where id = '${sci}'`)).given_at, 6000);
    await h.settle(page);
    const S = await sql(`select id, title, source from homework_steps where assignment_id = '${sci}' and done_at is null order by pos`);
    check('pat: Use this plan, Give: his typed step is still typed (with its id), the others the AI\'s', S.filter((s) => s.source === 'typed').length === 1
      && S.find((s) => s.source === 'typed').id === typed.id && S.filter((s) => s.source === 'ai').length === S.length - 1, S.map((s) => [s.source, s.title]));
    const given = await one(`select given_by from assignments where id = '${sci}'`);
    check('... given by "Pat Lee, tutor (tutor link)"', given.given_by === 'Pat Lee, tutor (tutor link)', given);
    await shot(page, 'homework-ai-pat');
    const reqs = (await h.requests()).filter((x) => x.role !== 'service_role');
    check('pat: the page called only the tutor functions and hub-jobs, signed out', reqs.length > 0 && reqs.every((x) => x.role === 'anon' && TUTOR_OR_JOBS.test(x.path))
      && reqs.some((x) => x.path === '/functions/v1/hub-jobs'), [...new Set(reqs.map((x) => `${x.role} ${x.path}`))]);
    const f = await failures();
    check('pat: no API request failed', !f.length, f);
    await context.close();

    // Jordan's My day.
    await h.mark();
    const j = await open({ path: `/day.html?t=${P.jordan.day_token}#homework`, label: 'ai-jordan', phone: true });
    await j.page.waitForSelector(`.hw-asg[data-asg="${sci}"]`, { timeout: 8000 });
    check('jordan: Due soon says "Plan by Pat, with AI help"', /Plan by Pat, with AI help/.test(await tc(j.page, `.hw-asg[data-asg="${sci}"]`)), await tc(j.page, `.hw-asg[data-asg="${sci}"]`));
    const jr = await h.requests();
    check('jordan: his page never calls hub-jobs', !jr.some((x) => x.path.startsWith('/functions/v1/')), [...new Set(jr.map((x) => x.path))]);
    await j.context.close();
  });

  // ===================================================================
  // A person's locked step, and a tick while the run is open: Use this plan keeps each person's step as they left it
  // ===================================================================
  await flow('locked', async () => {
    await h.setClock(at(MON, '09:25'));
    const own = 'Ask Pat for the sheet <2 pages> at example.com/volcano';
    const b = await one(`insert into assignments (kid_id, title, subject, due_date, details, created_by)
      values ('${P.jordan.id}', 'Volcano model', 'Science', '2026-11-13', 'Build a model volcano.', 'alex@example.com') returning id`);
    const saved = await rpcAs('alex@example.com', 'save_homework_plan', { p_assignment: b.id, p_rev: 0, p_give: false, p_steps: [
      { kind: 'start', title: 'Copy the requirements', done_looks_like: 'the list in your notes', minutes: 10, day: null, source: 'typed' },
      { kind: 'step', title: own, done_looks_like: 'the sheet in your folder', minutes: 15, day: null, source: 'typed' },
      { kind: 'step', title: 'Paint the cone', done_looks_like: 'the cone painted', minutes: 20, day: null, source: 'template' },
      { kind: 'turn_in', title: 'Turn it in', done_looks_like: 'handed in', minutes: 5, day: null, source: 'typed' }] });
    const before = await sql(`select id, kind, title, source from homework_steps where assignment_id = '${b.id}' order by pos`);
    check('locked: the plan saved (four steps, three typed, one with Pat, a link and \'<\' in it)', saved.status === 200 && before.length === 4 && before[1].title === own, [saved.status, saved.body, before]);
    const preview = (await rpcAs('alex@example.com', 'homework_ai_preview', { p_assignment: b.id, p_kind: 'revise' })).body;
    // While "Claude is thinking", Jordan ticks his first step; the answer returns the locked steps as they were sent.
    h.anthropic.next(async (req) => {
      await sql(`update homework_steps set done_at = now(), done_by = 'Jordan Example (My day)' where id = '${before[0].id}'`);
      let cur = [];
      try { cur = JSON.parse((/<current_plan>([^]*?)<\/current_plan>/.exec(userOf(req)) || [])[1] || '[]'); } catch (e) { cur = []; }
      const back = (i) => ({ ref: cur[i].ref, kind: cur[i].kind, title: cur[i].title, done_looks_like: cur[i].done_looks_like, minutes: cur[i].minutes, day: cur[i].day });
      const answer = { summary: 'Build a model volcano.', questions: [], stretch: '', fits: true, note_for_adult: '',
        steps: [back(0), back(1), { ref: 'new', kind: 'step', title: 'Paint the cone in two colors', done_looks_like: 'the cone painted', minutes: 20, day: null }, back(3)] };
      return { status: 200, body: { id: 'msg_realdb_locked', type: 'message', role: 'assistant', model: req.body.model, content: [{ type: 'text', text: JSON.stringify(answer) }],
        stop_reason: 'end_turn', usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1600, output_tokens: 900 } } };
    });
    const go1 = await h.hubJobsAs('alex@example.com', { action: 'homework_ai', kind: 'revise', assignment_id: b.id, request: null, answers: null,
      key: require('crypto').randomUUID(), shown: seal(preview) });
    await h.aiDone();
    const r = sent().slice(-1)[0];
    check('locked: the run went with the preview\'s seal, and the AI got the scrubbed copy of the locked step', go1.status === 202 && userOf(r) === preview
      && /Ask \[name\] for the sheet ‹2 pages› at \[link\]/.test(preview) && !/Pat|example\.com|</.test(JSON.parse((/<current_plan>([^]*?)<\/current_plan>/.exec(preview) || [])[1] || '[]').map((x) => x.title).join(' ')),
      [go1.status, go1.body, String(preview).slice(-500)]);
    const d = JSON.parse((await one(`select ai_draft from assignments where id = '${b.id}'`)).ai_draft || 'null');
    check('locked: the database\'s draft has the ids one step on (numbered again after the tick) and the copy with [name] and [link]',
      !!d && d.steps.length === 4 && d.steps[0].id === before[1].id && d.steps[1].id === before[2].id && /\[name\]/.test(d.steps[1].title),
      d && d.steps.map((x) => [x.title, x.id && before.findIndex((y) => y.id === x.id)]));
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/homework/${b.id}`, label: 'ai-alex-locked' });
    await page.waitForSelector('[data-act="ai-use"]', { timeout: 8000 });
    await page.click('[data-act="ai-use"]');
    await h.settle(page, 200);
    const shown = await texts(page, '.plan-steps .plan-step-title');
    check('locked: Use this plan shows the person\'s step in their own words (no [name], [link] or ‹›)', shown.some((x) => x.includes(own)) && !shown.some((x) => /\[name\]|\[link\]|‹/.test(x)), shown);
    await page.click('[data-act="save"]');
    await until(async () => (await sql(`select 1 from homework_steps where assignment_id = '${b.id}' and title = 'Paint the cone in two colors'`)).length === 1, 6000);
    await h.settle(page);
    const after = await sql(`select id, kind, title, source, done_at is not null as done from homework_steps where assignment_id = '${b.id}' order by pos`);
    check('locked: Save: the ticked step still done, each person\'s step with its own id, words and source typed, the AI\'s new step; nothing written over another',
      same(after.map((x) => [before.findIndex((y) => y.id === x.id), x.kind, x.title, x.source, x.done]), [
        [0, 'start', 'Copy the requirements', 'typed', 't'], [1, 'step', own, 'typed', 'f'], [-1, 'step', 'Paint the cone in two colors', 'ai', 'f'], [3, 'turn_in', 'Turn it in', 'typed', 'f']]),
      after.map((x) => [before.findIndex((y) => y.id === x.id), x.title, x.source, x.done]));
    const f = await failures();
    check('locked: no API request failed', !f.length, f);
    await context.close();
  });

  // ===================================================================
  // Through the API: who may not ask, the stops, a resent key, no key
  // ===================================================================
  await flow('stops', async () => {
    if (!sci) throw new Error('no assignment');
    await h.setClock(at(MON, '09:30'));
    const key = () => require('crypto').randomUUID();
    const n0 = sent().length;
    const r0 = (await runs()).length;
    // What Pat's link or a parent sees for a revision now (no request): the seal every send below carries.
    const shown = seal((await rpcAs('alex@example.com', 'homework_ai_preview', { p_assignment: sci, p_kind: 'revise' })).body);
    const bad = await jobs({ token: 'not-a-token', kind: 'plan', assignment_id: sci, key: key(), shown });
    const day = await jobs({ token: P.jordan.day_token, kind: 'plan', assignment_id: sci, key: key(), shown });
    const cant = await jobs({ token: noAi.token, kind: 'plan', assignment_id: sci, key: key(), shown });
    await h.aiDone();
    check('a malformed token, Jordan\'s day token and a link that may not ask: 200 not_found, nothing sent to Anthropic, no run',
      [bad, day, cant].every((x) => x.status === 200 && same(x.body, { stop: 'not_found' })) && sent().length === n0 && (await runs()).length === r0, [bad, day, cant].map((x) => x.body));
    await sql('update household set homework_ai = false');
    const off = await h.hubJobsAs('alex@example.com', { action: 'homework_ai', kind: 'plan', assignment_id: sci, key: key(), shown });
    await sql('update household set homework_ai = true');
    check('the switch off: 200 off, nothing sent', off.status === 200 && same(off.body, { stop: 'off' }) && sent().length === n0, off.body);

    // A refusal: the run and the assignment say so; the draft and the plan stay.
    const draftBefore = (await one(`select ai_draft from assignments where id = '${sci}'`)).ai_draft;
    h.anthropic.next({ status: 200, body: { id: 'msg_realdb_refusal', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null }, usage: { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 1600, output_tokens: 3 } } });
    const ref = await h.hubJobsAs('alex@example.com', { action: 'homework_ai', kind: 'revise', assignment_id: sci, request: null, answers: null, key: key(), shown });
    await h.aiDone();
    const rr = (await runs()).slice(-1)[0];
    const ra = await one(`select ai_state, ai_stop, ai_draft from assignments where id = '${sci}'`);
    check('a refusal (category cyber): 202, then the run failed with refusal_cyber and its usage; the assignment failed, refusal_cyber, its draft kept',
      ref.status === 202 && UUID.test(ref.body.run_id) && rr.id === ref.body.run_id && same([rr.status, rr.stop, rr.input_tokens, rr.output_tokens], ['failed', 'refusal_cyber', '900', '3'])
      && same([ra.ai_state, ra.ai_stop], ['failed', 'refusal_cyber']) && ra.ai_draft === draftBefore, [ref.body, rr, ra.ai_state, ra.ai_stop]);
    await h.mark();
    const { page, context } = await open({ email: 'alex@example.com', path: `/#/homework/${sci}`, label: 'ai-alex-refused' });
    await page.waitForSelector('.plan-editor', { timeout: 8000 });
    await until(async () => /couldn't help/.test(await tc(page, '.plan-editor')), 4000);
    check('... the editor says "The AI couldn\'t help with this one." and the starter plans are still there', /The AI couldn't help with this one\./.test(await tc(page, '.plan-editor'))
      && !!(await page.$('.plan-editor [data-act="starter"]')), await tc(page, '.plan-ai-status'));
    await context.close();

    // A 401: auth.
    h.anthropic.next({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const auth = await jobs({ token: link.token, kind: 'revise', assignment_id: sci, key: key(), shown });
    await h.aiDone();
    const ar = (await runs()).slice(-1)[0];
    check('a 401 from Anthropic: the run failed with auth (nothing else of the answer kept)', auth.status === 202 && ar.id === auth.body.run_id && same([ar.status, ar.stop, ar.model, ar.cents], ['failed', 'auth', null, null]), ar);

    // A resent key: its run, and no second request.
    const k = key();
    const n1 = sent().length;
    const first = await jobs({ token: link.token, kind: 'revise', assignment_id: sci, key: k, shown });
    await h.aiDone();
    const again = await jobs({ token: link.token, kind: 'revise', assignment_id: sci, key: k, shown });
    await h.aiDone();
    check('the same key sent twice: the same run both times, one request to Anthropic', first.status === 202 && again.status === 202 && first.body.run_id === again.body.run_id
      && sent().length === n1 + 1 && (await sql(`select 1 from ai_runs where key = '${k}'`)).length === 1, [first.body, again.body, sent().length - n1]);

    // No key: not_set_up, and no run.
    const saved = h.fnEnv.ANTHROPIC_API_KEY;
    delete h.fnEnv.ANTHROPIC_API_KEY;
    const r2 = (await runs()).length;
    const none = await h.hubJobsAs('alex@example.com', { action: 'homework_ai', kind: 'test', key: key() });
    h.fnEnv.ANTHROPIC_API_KEY = saved;
    check('no ANTHROPIC_API_KEY: 200 not_set_up, no run, nothing sent', none.status === 200 && same(none.body, { stop: 'not_set_up' }) && (await runs()).length === r2 && sent().length === n1 + 1, none.body);
    check('every request to Anthropic carried the function\'s key and the model, and no token or id', sent().every((x) => x.headers['x-api-key'] === h.AI_KEY && x.body.model === 'claude-opus-5-5'
      && !leaks(JSON.stringify(x.body), [P.jordan.day_token, link.token, noAi.token]).length));
  });

  await h.finish();
})();
