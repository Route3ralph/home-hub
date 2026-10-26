// The morning email and the confirmation email, as HTML and plain text.
// The digest is rendered from digest_for's JSON (the database works out what goes in it,
// in the person's language); this file only lays it out.
// Rules: every dynamic string is escaped; text is never turned into links; the only links
// are ones the hub builds itself (My day, the hub, and WhatsApp / Text for each kid or helper).
// A My day link is a bearer link (no sign-in), so it goes only to people who can't sign in:
// a forwarded email from a parent or adult who can sign in hands out nothing.

import { oneLine } from './util.ts';
export { oneLine };

export type Item = {
  kind: string;                 // 'event', 'task', 'project', 'contract' or 'google' (read from Google Calendar)
  item_id?: string;
  occurrence?: string;
  time: string | null;          // a label: "8:00am", "15:00", "All day", "Tomorrow 7:30am"
  title: string;
  detail: string | null;        // "due Nov 1", "with Taylor · Rivera Music"
  contractor_phone: string | null;
  status: string;               // 'open' or 'late'
};
export type PersonBlock = {
  person_id: string; name: string; role: string; phone: string | null; language: string; count: number;
  text: string;                 // day_text: the message to send them
};
export type ProjectLine = { project_id: string; name: string; text: string; items: unknown[] };
export type Labels = Record<string, string | null | undefined>;
export type Digest = {
  recipient: { id: string; name: string; email: string | null; language: string; role: string; day_token: string };
  local_date: string;
  date_label: string;
  subject: string;
  today: Item[];
  late: Item[];
  late_more: number;
  heads_up: Item[];
  people: PersonBlock[];
  nobody: Item[];
  nobody_more: number;
  projects: ProjectLine[];
  inbox_count: number | null;
  // Parents only, when a Google calendar is set up and there is something to say (§5.6 of
  // docs/v1.1-google-calendar.md): each a line in their language, from the database.
  calendar?: { warning: string | null; items_failed: string | null; put_back: string[] | null } | null;
  empty: boolean;
  labels: Labels;
};
export type Email = { subject: string; html: string; text: string };

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// oneLine (one line of text: titles, names, subjects) lives in util.ts, which says why the Unicode
// line and paragraph separators are never written out in this function's source.

// Several lines (day_text): keep the line breaks, drop other control characters.
const lines = (s: unknown) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();

// ---------------------------------------------------------------------
// Links. Only these ever appear in an email.
// ---------------------------------------------------------------------

// SITE_URL as a base for links: http(s) only, no query or fragment, ending in "/". Null if unusable.
export function siteBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    u.search = '';
    u.hash = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.href;
  } catch {
    return null;
  }
}

const HEX32 = /^[0-9a-f]{32}$/;
export const myDayUrl = (site: string, token: string) => (HEX32.test(token) ? `${site}day.html?t=${token}` : null);
// The confirmation link carries the confirmation secret only, never the My day token: an email that
// goes to a mistyped address gives away nothing but the chance to confirm that address.
export const confirmUrl = (site: string, confirm: string) => (HEX32.test(confirm) ? `${site}day.html?c=${confirm}#confirm` : null);
// The hub's pages (sign-in needed): Today; Family, where an admin sets anyone's morning email (their
// own too); Settings, whose Morning email card tells a member to ask an admin.
export const hubTodayUrl = (site: string) => `${site}#/today`;
export const hubFamilyUrl = (site: string) => `${site}#/family`;
export const hubSettingsUrl = (site: string) => `${site}#/settings`;

// The hub's phone rules (assets/hub.js): digits only; ten digits is a US number, so prefix 1.
export function phoneDigits(phone: unknown): string {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length === 10 ? `1${d}` : d;
}
export const smsHref = (phone: unknown, body: string) => `sms:+${phoneDigits(phone)}?&body=${encodeURIComponent(body)}`;
export const whatsappHref = (phone: unknown, body: string) => `https://wa.me/${phoneDigits(phone)}?text=${encodeURIComponent(body)}`;

// ---------------------------------------------------------------------
// Look. Inline styles (most mail apps drop <style>); a small dark-mode block for the apps that keep it.
// Colours are the site's tokens (assets/styles.css).
// ---------------------------------------------------------------------
const C = {
  bg: '#f6f4f0', surface: '#ffffff', surface2: '#f2efea', border: '#e4dfd7', line: '#efebe5',
  text: '#1f1b16', text2: '#4f483f', text3: '#6f675c', accent: '#2f5d50', danger: '#b42318', warn: '#8a5a00',
};
const FONT = 'ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
const SERIF = 'Iowan Old Style,Palatino Linotype,Palatino,Georgia,serif';
const DARK_CSS = `@media (prefers-color-scheme: dark) {
  .hh-bg { background: #121110 !important; }
  .hh-card { background: #1b1917 !important; border-color: #34302b !important; }
  .hh-box { background: #24211e !important; }
  .hh-text { color: #f3efe9 !important; }
  .hh-muted { color: #a59c90 !important; }
  .hh-row { border-color: #282521 !important; }
  .hh-late { color: #ff8b7b !important; }
  .hh-warn { color: #f2c14e !important; }
  .hh-link { color: #86c5ae !important; }
  .hh-btn { background: #86c5ae !important; color: #121110 !important; }
  .hh-btn2 { border-color: #86c5ae !important; color: #86c5ae !important; }
}`;

function page(lang: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="${lang === 'es' ? 'es' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<style>${DARK_CSS}</style>
</head>
<body class="hh-bg" style="margin:0;padding:0;background:${C.bg};">
<table role="presentation" class="hh-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};">
<tr><td align="center" style="padding:16px 8px;">
<table role="presentation" class="hh-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${C.surface};border:1px solid ${C.border};border-radius:14px;">
<tr><td class="hh-text" style="padding:20px 18px;font-family:${FONT};font-size:15px;line-height:1.45;color:${C.text};">
${body}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// A button that is at least 44px tall, so it's easy to tap.
const button = (href: string, label: string, primary = true) => primary
  ? `<a class="hh-btn" href="${esc(href)}" style="display:inline-block;background:${C.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;line-height:20px;padding:12px 18px;border-radius:10px;">${esc(label)}</a>`
  : `<a class="hh-btn2" href="${esc(href)}" style="display:inline-block;border:1px solid ${C.accent};color:${C.accent};text-decoration:none;font-weight:600;font-size:14px;line-height:20px;padding:11px 16px;border-radius:10px;margin:0 6px 0 0;">${esc(label)}</a>`;

const heading = (label: string, tone: 'plain' | 'late' | 'warn' = 'plain') => {
  const cls = tone === 'late' ? 'hh-late' : tone === 'warn' ? 'hh-warn' : 'hh-muted';
  const color = tone === 'late' ? C.danger : tone === 'warn' ? C.warn : C.text3;
  return `<div class="${cls}" style="margin:20px 0 6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${color};">${esc(label)}</div>`;
};

const muted = (html: string, extra = '') =>
  `<div class="hh-muted" style="color:${C.text3};font-size:13px;${extra}">${html}</div>`;

// The left column: the time, or a box for a task with no time. (A Google event is drawn like an
// event: digest_for gives it a time, or "All day".)
const lead = (it: Item) => oneLine(it.time) || (it.kind === 'task' ? '☐' : '');

// "with Taylor · Rivera Music · 555-0150"
const detailOf = (it: Item) => [oneLine(it.detail), oneLine(it.contractor_phone)].filter(Boolean).join(' · ');

// Keeps phone numbers on one line ("555-0150" shouldn't wrap at the hyphen). Runs on text
// that is already escaped and only adds a span around digits, so it can't open any markup.
const keepPhones = (escaped: string) =>
  escaped.replace(/(?:\+?1[ .-]?)?(?:\(\d{3}\) ?|\d{3}[ .-])?\d{3}-\d{4}/g, (m) => `<span style="white-space:nowrap;">${m}</span>`);

// Times sit in a fixed column, so titles line up from one section to the next.
function itemRows(items: Item[], late = false): string {
  const rows = items.map((it) => {
    const detail = detailOf(it);
    return `<tr>
<td class="${late ? 'hh-late' : 'hh-muted'} hh-row" valign="top" width="84" style="width:84px;padding:7px 10px 7px 0;border-top:1px solid ${C.line};color:${late ? C.danger : C.text3};font-size:14px;">${esc(lead(it))}</td>
<td class="hh-text hh-row" valign="top" style="padding:7px 0;border-top:1px solid ${C.line};color:${C.text};">${esc(oneLine(it.title))}${detail ? muted(keepPhones(esc(detail)), 'margin-top:1px;') : ''}</td>
</tr>`;
  });
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows.join('')}</table>`;
}

// "8:00am  Drop off dogs", "☐ Pay water bill · due Nov 1"
const itemText = (it: Item) => {
  const time = oneLine(it.time);
  const l = time ? `${time}  ` : it.kind === 'task' ? '☐ ' : '';
  const detail = detailOf(it);
  return `${l}${oneLine(it.title)}${detail ? ` · ${detail}` : ''}`;
};

// ---------------------------------------------------------------------
// The morning email
// canSignIn: the recipient has a sign-in (a members row; hub-jobs looks it up). Then the
// button opens the hub and "Stop these emails" opens the Family page (a parent who can sign
// in is an admin) or Settings (an adult member), all behind sign-in, and the email has no
// My day link at all. Without it, the button opens their My day page and the
// stop link is My day's #stop. Not given: parents and adults are taken to have a sign-in.
// ---------------------------------------------------------------------
const HUB_WORDS = { en: { open_hub: 'Open Home Hub' }, es: { open_hub: 'Abrir Home Hub' } };

export function renderDigest(d: Digest, site: string, opts: { canSignIn?: boolean } = {}): Email {
  const L = (k: string) => oneLine(d.labels?.[k] ?? '');
  const lang = d.recipient?.language === 'es' ? 'es' : 'en';
  const parent = d.recipient?.role === 'parent';
  const canSignIn = opts.canSignIn ?? (parent || d.recipient?.role === 'adult');
  const myDay = canSignIn ? null : myDayUrl(site, String(d.recipient?.day_token ?? ''));
  const title = `${L('today')} · ${oneLine(d.date_label)}`;
  const subject = (oneLine(d.subject) || title).slice(0, 200);
  const today = d.today || [];
  const late = d.late || [];
  const heads = d.heads_up || [];
  const people = parent ? d.people || [] : [];
  const nobody = parent ? d.nobody || [] : [];
  const projects = parent ? d.projects || [] : [];

  const h: string[] = [];
  const t: string[] = [];

  h.push(`<h1 class="hh-text" style="margin:0 0 6px;font-family:${SERIF};font-size:22px;line-height:1.25;font-weight:600;color:${C.text};">${esc(title)}</h1>`);
  t.push(title);
  // Google Calendar (parents only): short lines under the heading. Not up to date and items that
  // keep failing are warnings; events put back after a change in Google are notes. Each line comes
  // from the database already in their language; titles in it are the hub's or Google's, so escaped.
  const cal = parent && d.calendar ? d.calendar : null;
  const calLines = cal
    ? [
      ...[cal.warning, cal.items_failed].map(oneLine).filter(Boolean).map((line) => ({ line, warn: true })),
      ...(Array.isArray(cal.put_back) ? cal.put_back : []).map(oneLine).filter(Boolean).slice(0, 3).map((line) => ({ line, warn: false })),
    ]
    : [];
  for (const { line, warn } of calLines) {
    h.push(warn
      ? `<div class="hh-warn" style="color:${C.warn};font-size:13px;margin:2px 0;">${esc(line)}</div>`
      : muted(esc(line), 'margin:2px 0;'));
    t.push(line);
  }
  if (calLines.length) h.push('<div style="height:8px;line-height:8px;">&nbsp;</div>');
  t.push('');
  if (today.length) {
    h.push(itemRows(today));
    t.push(...today.map(itemText));
  } else {
    h.push(muted(esc(L('nothing_planned')), 'font-size:15px;padding:6px 0;'));
    t.push(L('nothing_planned'));
  }

  if (late.length) {
    h.push(heading(L('late'), 'late'), itemRows(late, true));
    t.push('', L('late'), ...late.map(itemText));
    if (d.late_more > 0 && L('late_more')) {
      h.push(muted(esc(L('late_more')), 'padding-top:4px;'));
      t.push(L('late_more'));
    }
  }

  if (heads.length) {
    h.push(heading(L('heads_up'), 'warn'), itemRows(heads));
    t.push('', L('heads_up'), ...heads.map(itemText));
  }

  if (people.length) {
    h.push(heading(L('their_day')));
    t.push('', L('their_day'));
    for (const p of people) {
      const msg = lines(p.text);
      const digits = phoneDigits(p.phone);
      const buttons = digits
        ? `<div style="margin-top:10px;">${button(whatsappHref(p.phone, msg), L('send_whatsapp') || 'WhatsApp', false)}${button(smsHref(p.phone, msg), L('send_text') || 'Text', false)}</div>`
        : '';
      h.push(`<div class="hh-box" style="background:${C.surface2};border-radius:10px;padding:12px 14px;margin:0 0 8px;">
<div class="hh-text" style="color:${C.text};font-size:14px;line-height:1.5;white-space:pre-line;">${keepPhones(esc(msg))}</div>${buttons}
</div>`);
      t.push(msg, '');
    }
    if (t[t.length - 1] === '') t.pop();
  }

  if (nobody.length) {
    h.push(heading(L('nobody')), itemRows(nobody));
    t.push('', L('nobody'), ...nobody.map(itemText));
    if (d.nobody_more > 0 && L('nobody_more')) {
      h.push(muted(esc(L('nobody_more')), 'padding-top:4px;'));
      t.push(L('nobody_more'));
    }
  }

  if (projects.length) {
    h.push(heading(L('projects')));
    t.push('', L('projects'));
    for (const p of projects) {
      h.push(`<div class="hh-text" style="color:${C.text};padding:3px 0;">${keepPhones(esc(oneLine(p.text)))}</div>`);
      t.push(oneLine(p.text));
    }
  }

  if (parent && d.inbox_count != null && L('inbox')) {
    h.push(muted(esc(L('inbox')), 'margin-top:18px;font-size:14px;'));
    t.push('', L('inbox'));
  }

  // Links: the hub (people who can sign in) or their My day page (no sign-in), and a way to stop:
  // Family or Settings in the hub, or My day's #stop. None changes anything by being opened.
  const foot: string[] = [];
  t.push('');
  const open = canSignIn ? { href: hubTodayUrl(site), label: HUB_WORDS[lang].open_hub }
    : myDay ? { href: myDay, label: L('open_my_day') || 'Open my day' } : null;
  if (open) {
    h.push(`<div style="margin:24px 0 4px;">${button(open.href, open.label)}</div>`);
    t.push(`${open.label}: ${open.href}`);
  }
  const stop = canSignIn ? (parent ? hubFamilyUrl(site) : hubSettingsUrl(site)) : myDay ? `${myDay}#stop` : null;
  if (stop && L('stop_emails')) {
    foot.push(`<a class="hh-link" href="${esc(stop)}" style="color:${C.accent};">${esc(L('stop_emails'))}</a>`);
    t.push(`${L('stop_emails')}: ${stop}`);
  }
  if (foot.length) h.push(muted(foot.join(' &nbsp;·&nbsp; '), 'margin-top:16px;'));

  return { subject, html: page(lang, subject, h.join('\n')), text: `${t.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n` };
}

// ---------------------------------------------------------------------
// The confirmation email: sent once an address is added with the morning email on, and
// at most once more as a reminder (hub-jobs sends no third). Its button opens day.html
// with the confirmation secret only; the page asks before confirming.
// ---------------------------------------------------------------------
const CONFIRM = {
  en: {
    subject: 'Confirm your morning email from Home Hub',
    reminder_subject: 'Reminder: confirm your morning email from Home Hub',
    heading: 'Confirm your morning email',
    hello: (name: string) => `Hi ${name},`,
    why: 'Someone in your household asked Home Hub to send a short email each morning with your plan for the day to this address.',
    button: 'Yes, send me the morning email',
    ignore: "If you weren't expecting this, you can ignore it: no morning emails are sent until the address is confirmed, and at most one reminder follows this email.",
    ignore_reminder: "This is the only reminder. If you weren't expecting it, ignore it: Home Hub won't email this address again unless someone in your household sets it up again.",
    link: 'Confirm',
  },
  es: {
    subject: 'Confirma tu correo de la mañana de Home Hub',
    reminder_subject: 'Recordatorio: confirma tu correo de la mañana de Home Hub',
    heading: 'Confirma tu correo de la mañana',
    hello: (name: string) => `Hola, ${name}:`,
    why: 'Alguien de tu casa pidió que Home Hub envíe a esta dirección un breve correo cada mañana con el plan de tu día.',
    button: 'Sí, enviarme el correo de la mañana',
    ignore: 'Si no lo esperabas, puedes ignorar este correo: no se envía ningún correo de la mañana hasta confirmar la dirección, y después de este llega como mucho un recordatorio.',
    ignore_reminder: 'Este es el único recordatorio. Si no lo esperabas, ignóralo: Home Hub no volverá a escribir a esta dirección salvo que alguien de tu casa la vuelva a configurar.',
    link: 'Confirmar',
  },
};

export function renderConfirm(person: { name: string; language: string }, link: string, opts: { reminder?: boolean } = {}): Email {
  const lang = person.language === 'es' ? 'es' : 'en';
  const w = CONFIRM[lang];
  const subject = opts.reminder ? w.reminder_subject : w.subject;
  const ignore = opts.reminder ? w.ignore_reminder : w.ignore;
  const name = oneLine(person.name);
  const p = (s: string, extra = '') => `<p class="hh-text" style="margin:0 0 12px;color:${C.text};${extra}">${esc(s)}</p>`;
  const html = page(lang, subject, [
    `<h1 class="hh-text" style="margin:0 0 12px;font-family:${SERIF};font-size:22px;line-height:1.25;font-weight:600;color:${C.text};">${esc(w.heading)}</h1>`,
    p(w.hello(name)),
    p(w.why),
    `<div style="margin:18px 0 18px;">${button(link, w.button)}</div>`,
    muted(esc(ignore)),
  ].join('\n'));
  const text = [w.heading, '', w.hello(name), '', w.why, '', `${w.link}: ${link}`, '', ignore, ''].join('\n');
  return { subject, html, text };
}
