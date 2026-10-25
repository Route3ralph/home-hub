// Playwright tests for the message composer (text / WhatsApp / email / send via hub).
// Run alone with: node tests/e2e/messages.test.js
const { chromium } = require('playwright');
const { makeDb, install, signIn } = require('./mock');
const { serve } = require('./server');

let BASE = '';
const SHOTS = __dirname + '/shots/';
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 160)})` : ''}`);

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  BASE = server.base;
  const browser = await chromium.launch();
  const errors = [];
  async function open(opts = {}) {
    const db = opts.db || makeDb();
    const context = await browser.newContext(Object.assign({ viewport: { width: 1366, height: 900 } }, opts.ctx));
    await signIn(context, 'alex@example.com');
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${opts.label}: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    await install(page, db, [], opts);
    await page.goto(BASE + (opts.path || '/'));
    await page.waitForTimeout(500);
    return { page, db };
  }
  const href = (page, which) => page.$eval(`#formDialog [data-link="${which}"]`, (a) => a.getAttribute('href')).catch(() => null);
  const dec = (s) => decodeURIComponent(s || '');

  // 1. Team card → Message (sharing off, email via hub off)
  let { page, db } = await open({ label: 'team', path: '/#/projects/p-kitchen' });
  const msgButtons = await page.$$eval('.member [data-msg]', (b) => b.map((x) => x.dataset.msg));
  check('only trades with a reachable contractor get a Message button', msgButtons.length === 1 && msgButtons[0] === 'electrician', msgButtons.join(','));
  await page.click('.member [data-msg="electrician"]');
  await page.waitForTimeout(200);
  const body = await page.$eval('#formDialog [name=body]', (t) => t.value);
  check('draft greets contractor and lists their remaining dates', body.startsWith('Hi Pat,') && body.includes('• Electrical rough-in') && body.includes('• Electrical finish') && body.trim().endsWith('Alex'), body.split('\n').slice(0, 4).join(' | '));
  check('no share link while sharing is off, with a tip', !body.includes('share.html') && (await page.$eval('#formDialog', (d) => d.innerText)).includes('turn on sharing'));
  const sms = await href(page, 'sms');
  check('Text opens Messages with US number + body', sms.startsWith('sms:+12015550100?&body=') && dec(sms.split('body=')[1]) === body, sms.slice(0, 60));
  const wa = await href(page, 'whatsapp');
  check('WhatsApp opens wa.me with number + text', wa.startsWith('https://wa.me/12015550100?text=') && dec(wa.split('text=')[1]) === body, wa.slice(0, 60));
  const mail = await href(page, 'mail');
  check('Email opens mail app with subject + body', mail.startsWith('mailto:pat@leeelectric.example?subject=') && dec(mail).includes('Kitchen Renovation: your schedule'), mail.slice(0, 70));
  check('no "Send email now" until hub email is set up', !(await page.$('#formDialog [data-send]')));
  await page.fill('#formDialog [name=body]', 'Hi Pat, can you come Tuesday instead?');
  check('editing the message updates the links', dec((await href(page, 'sms')).split('body=')[1]) === 'Hi Pat, can you come Tuesday instead?');
  await page.screenshot({ path: SHOTS + 'message.png' });
  await page.keyboard.press('Escape');

  // 2. With sharing on, the draft includes the trade-filtered live link
  db.projects.find((p) => p.id === 'p-kitchen').sharing_enabled = true;
  await page.reload();
  await page.waitForTimeout(500);
  await page.click('.member [data-msg="electrician"]');
  const body2 = await page.$eval('#formDialog [name=body]', (t) => t.value);
  check('draft includes trade-filtered share link when sharing is on', body2.includes('/share.html?p=kitchentoken0123456789ab&trade=electrician'), body2.match(/https?:\S+/) && body2.match(/https?:\S+/)[0]);
  await page.keyboard.press('Escape');

  // 3. Task detail → Message Pat
  await page.click('.g-label[data-id="elec-rough"]');
  await page.waitForTimeout(200);
  const btn = await page.$('#detail [data-task-act="message"]');
  check('task detail offers "Message Pat"', !!btn && (await btn.innerText()) === 'Message Pat');
  await btn.click();
  await page.waitForTimeout(200);
  const body3 = await page.$eval('#formDialog [name=body]', (t) => t.value);
  check('task message names the task and its dates', body3.includes('"Electrical rough-in: circuits, boxes, lighting"') && body3.includes('scheduled for'), body3.split('\n')[2]);
  await page.keyboard.press('Escape');
  await page.click('.g-label[data-id="paint-1"]');
  check('no Message button when the trade has no contractor', !(await page.$('#detail [data-task-act="message"]')));
  await page.keyboard.press('Escape');

  // 4. Contractors page → Message
  await page.goto(BASE + '/#/contractors');
  await page.waitForTimeout(500);
  const cardMsgs = await page.$$('.ccard [data-message]');
  check('every contractor with phone/email has Message', cardMsgs.length === 2);
  await page.click('.ccard:has-text("Maria Gomez") [data-message]');
  await page.waitForTimeout(200);
  check('phone-only contractor: Text + WhatsApp, no email', !!(await href(page, 'sms')) && !(await page.$('#formDialog [data-link="mail"]')) && !(await page.$('#formDialog [name=subject]')));
  await page.keyboard.press('Escape');

  // 5. Send email now (Resend configured)
  ({ page, db } = await open({ label: 'send', path: '/#/projects/p-kitchen', emailSending: true }));
  await page.click('.member [data-msg="electrician"]');
  await page.waitForTimeout(200);
  check('"Send email now" shown when configured', !!(await page.$('#formDialog [data-send]')));
  await page.fill('#formDialog [name=subject]', 'Kitchen: rough-in dates');
  await page.click('#formDialog [data-send]');
  await page.waitForTimeout(500);
  const call = (db.functionCalls || [])[0];
  check('calls send-email with recipient, subject, text and user token', call && call.path === '/functions/v1/send-email' && call.body.to === 'pat@leeelectric.example' && call.body.subject === 'Kitchen: rough-in dates' && call.body.text.startsWith('Hi Pat,') && call.email === 'alex@example.com', JSON.stringify(call && call.body).slice(0, 120));
  check('dialog closes and confirms', !(await page.$eval('#formDialog', (d) => d.open)) && (await page.innerText('body')).includes('Email sent to Pat'));

  // 6. Send failure shows the function's explanation
  ({ page, db } = await open({ label: 'sendfail', path: '/#/projects/p-kitchen', emailSending: true, fnStatus: 429, fnBody: { error: 'The hub has sent 50 emails in the last 24 hours. Try again tomorrow.' } }));
  await page.click('.member [data-msg="electrician"]');
  await page.click('#formDialog [data-send]');
  await page.waitForTimeout(500);
  const err = await page.$eval('#formDialog .form-error', (e) => (e.hidden ? '' : e.innerText));
  check('send failure explained, dialog stays open', err.includes('50 emails') && (await page.$eval('#formDialog', (d) => d.open)), err);
  await page.screenshot({ path: SHOTS + 'message-send.png' });

  // 7. Phone layout
  const m = await open({ label: 'phone', path: '/#/projects/p-kitchen', ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  await m.page.evaluate(() => document.querySelector('.member [data-msg]').scrollIntoView());
  await m.page.click('.member [data-msg="electrician"]');
  await m.page.waitForTimeout(200);
  check('phone: composer fits without sideways scroll', !(await m.page.evaluate(() => document.documentElement.scrollWidth > 390)));
  await m.page.screenshot({ path: SHOTS + 'm-message.png' });

  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
  await server.close();
  if (results.some((r) => r.startsWith('FAIL')) || errors.length) process.exitCode = 1;
})().catch((err) => {
  // A step that throws (e.g. a selector that never appears) stops the run: report what ran, then fail.
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.message) || err).split('\n')[0]}`);
  console.error(err);
  process.exit(1);
});
