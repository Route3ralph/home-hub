// The Sunday sheets (docs/v2-design.md §31): the coming week, Monday to Sunday, laid out to print, one sheet to a
// page. The database works out what goes on each sheet, in the sheet's language (public.weekly_sheet); this file only
// lays it out, in that language, and writes the email around the sheets in the recipient's language.
// Rules, as render.ts: every dynamic string is escaped; text is never turned into links; there are no links at all.
// Inline styles (most mail apps drop <style>); the <style> block only adds page breaks and landscape for printing.
// Colours print without "background graphics": a person's colour is a left border, never a background.

import { esc } from './render.ts';
import type { Email } from './render.ts';
import { oneLine } from './util.ts';

export type SheetItem = {
  kind: string; time?: string; end?: string; all_day?: boolean; title: string; who?: string; color?: string;
  place?: string; contractor?: string; note?: string; bring?: string; task?: boolean; done?: boolean;
};
export type SheetDay = {
  day: string; label: string; day_off?: boolean; items: SheetItem[];
  meals?: { slot: string; title: string; who?: string }[];
};
export type SheetStep = { day: string; label: string; title: string; kind: string; minutes?: number | null; done?: boolean };
export type Sheet = {
  who: string;                          // 'family' or the person's id
  name?: string; role?: string; lang: string; monday: string; sunday: string; range: string;
  people?: { name: string; color?: string }[];
  days: SheetDay[];
  homework?: { title: string; subject?: string | null; kind: string; due?: string | null; due_label?: string | null; steps: SheetStep[] }[];
  routine?: { title: string; note?: string | null; items: { title: string; tag?: string; part?: string; days: boolean[] }[] }[];
  shopping?: { name: string; note?: string }[];
};
export type SheetChoice = { who: string; lang: 'en' | 'es' };

// Fixed words, in English and Spanish. Titles and names stay as typed.
const WORDS = {
  en: {
    family: 'Family week', person: "{name}'s week", week: 'Week of {range}', nothing: '—', bring: 'Bring', day_off: 'Day off',
    who: "Who's who", homework: 'Homework this week', due: 'due {d}', min: '{n} min', routine: 'Routine',
    routine_help: 'Tick each box when it is done.', shopping: 'Shopping list', meals: 'Meals', turn_in: 'Due',
    subject: 'Week of {range}: {names}', intro: 'The week of {range}, ready to print: {n} sheets, each on its own page.',
    intro_one: 'The week of {range}, ready to print.', tip: 'For the best fit, print it landscape.',
    footer: 'From Home Hub. Change what goes in it on Settings, Sunday sheets.', family_short: 'Family', none: 'No sheets to send.',
  },
  es: {
    family: 'Semana de la familia', person: 'Semana de {name}', week: 'Semana del {range}', nothing: '—', bring: 'Llevar', day_off: 'Día libre',
    who: 'Quién es quién', homework: 'Tareas de la semana', due: 'entrega {d}', min: '{n} min', routine: 'Rutina',
    routine_help: 'Marca cada casilla al terminar.', shopping: 'Lista de compras', meals: 'Comidas', turn_in: 'Entrega',
    subject: 'Semana del {range}: {names}', intro: 'La semana del {range}, lista para imprimir: {n} hojas, cada una en su página.',
    intro_one: 'La semana del {range}, lista para imprimir.', tip: 'Se ve mejor impresa en horizontal.',
    footer: 'Desde Home Hub. Lo que lleva se cambia en Ajustes, Hojas del domingo.', family_short: 'Familia', none: 'No hay hojas para enviar.',
  },
} as const;
type Lang = keyof typeof WORDS;
const lang = (l: unknown): Lang => (l === 'es' ? 'es' : 'en');
const w = (l: unknown, key: keyof typeof WORDS['en'], vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), WORDS[lang(l)][key] as string);

// The short weekday headings: "Mon 16" / "lun 16", from the day's own label ("Mon Nov 16", "lun 16 nov").
const dayHead = (d: SheetDay, l: Lang) => {
  const parts = oneLine(d.label).split(' ');
  return l === 'es' ? parts.slice(0, 2).join(' ') : [parts[0], parts[2]].filter(Boolean).join(' ');
};

// A colour from the database, only as #rgb or #rrggbb (anything else: none).
const colour = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c) ? c : null);

const INK = '#1f1b16', MUTED = '#5f574c', RULE = '#cfc8bd', SOFT = '#efebe5', STEP = '#2f5d50';
const FONT = 'Helvetica,Arial,sans-serif';
const BOX = `display:inline-block;width:11px;height:11px;border:1.5px solid ${INK};border-radius:2px;vertical-align:-1px;margin-right:4px;`;
const box = (done?: boolean) => (done ? `<span style="${BOX}text-align:center;font-size:10px;line-height:11px;">✓</span>` : `<span style="${BOX}"></span>`);

// One item in a day's column.
function itemHtml(it: SheetItem, l: Lang): string {
  const c = colour(it.color);
  const time = it.time ? `${it.time}${it.end ? `–${it.end}` : ''}` : '';
  const head = `${it.task ? box(it.done) : ''}${time ? `<b>${esc(time)}</b> ` : ''}${esc(oneLine(it.title))}`;
  const sub = [it.who, it.place, it.contractor, it.note].map((x) => oneLine(x)).filter(Boolean);
  const bring = oneLine(it.bring);
  return `<div style="margin:0 0 6px;padding:1px 0 1px 5px;border-left:3px solid ${c || RULE};${it.done ? 'color:#8a8277;' : ''}">`
    + `<div style="font-size:11px;line-height:1.3;${it.done ? 'text-decoration:line-through;' : ''}">${head}</div>`
    + (sub.length ? `<div style="font-size:9.5px;line-height:1.3;color:${MUTED};">${esc(sub.join(' · '))}</div>` : '')
    + (bring ? `<div style="font-size:9.5px;line-height:1.3;"><b>${esc(w(l, 'bring'))}:</b> ${esc(bring)}</div>` : '')
    + '</div>';
}

// A kid's homework step in a day's column.
function stepHtml(s: SheetStep, l: Lang): string {
  const mins = s.minutes ? ` (${w(l, 'min', { n: s.minutes })})` : '';
  const label = s.kind === 'turn_in' ? `<b>${esc(w(l, 'turn_in'))}:</b> ` : '';
  return `<div style="margin:0 0 6px;padding:1px 0 1px 5px;border-left:3px solid ${STEP};font-size:10.5px;line-height:1.3;${s.done ? 'color:#8a8277;text-decoration:line-through;' : ''}">`
    + `${box(s.done)}${label}${esc(oneLine(s.title))}${esc(mins)}</div>`;
}

function title(s: Sheet): string {
  const l = lang(s.lang);
  return s.who === 'family' ? w(l, 'family') : w(l, 'person', { name: oneLine(s.name) });
}

// The seven columns of a sheet: its items, a kid's homework steps on their days, and the meals.
function weekGrid(s: Sheet): string {
  const l = lang(s.lang);
  const tall = s.who === 'family' ? 400 : 300;
  const steps = new Map<string, SheetStep[]>();
  for (const h of s.homework || []) for (const st of h.steps || []) {
    if (!steps.has(st.day)) steps.set(st.day, []);
    steps.get(st.day)!.push({ ...st, title: st.kind === 'turn_in' || !h.title ? st.title : `${oneLine(h.title)}: ${oneLine(st.title)}` });
  }
  const heads = s.days.map((d) => `<th style="width:14.28%;padding:4px 5px;border:1px solid ${RULE};background:${SOFT};font-size:11px;text-align:left;">`
    + `${esc(dayHead(d, l))}${d.day_off ? `<div style="font-weight:normal;font-size:9.5px;color:${MUTED};">${esc(w(l, 'day_off'))}</div>` : ''}</th>`).join('');
  const cells = s.days.map((d) => {
    const parts = (d.items || []).map((it) => itemHtml(it, l));
    for (const st of steps.get(d.day) || []) parts.push(stepHtml(st, l));
    for (const m of d.meals || []) parts.push(`<div style="margin:0 0 6px;font-size:10px;line-height:1.3;color:${MUTED};"><b>${esc(oneLine(m.slot))}:</b> ${esc(oneLine(m.title))}${m.who ? ` · ${esc(oneLine(m.who))}` : ''}</div>`);
    return `<td style="vertical-align:top;padding:5px;border:1px solid ${RULE};height:${tall}px;">${parts.join('') || `<span style="color:${MUTED};">${esc(w(l, 'nothing'))}</span>`}</td>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;width:100%;font-family:${FONT};color:${INK};">`
    + `<tr>${heads}</tr><tr>${cells}</tr></table>`;
}

const h2 = (t: string) => `<h2 style="margin:14px 0 6px;font-family:${FONT};font-size:14px;color:${INK};">${esc(t)}</h2>`;

function legend(s: Sheet): string {
  const people = (s.people || []).filter((p) => p && p.name);
  if (!people.length) return '';
  const l = lang(s.lang);
  return `<p style="margin:8px 0 0;font-family:${FONT};font-size:10px;color:${MUTED};">${esc(w(l, 'who'))}: `
    + people.map((p) => `<span style="display:inline-block;margin-right:10px;padding-left:5px;border-left:3px solid ${colour(p.color) || RULE};color:${INK};">${esc(oneLine(p.name))}</span>`).join('')
    + '</p>';
}

function homeworkList(s: Sheet): string {
  const hw = (s.homework || []).filter((h) => h && h.title);
  if (!hw.length) return '';
  const l = lang(s.lang);
  return h2(w(l, 'homework')) + `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:${FONT};font-size:11px;color:${INK};">`
    + hw.map((h) => `<tr><td style="padding:2px 10px 2px 0;">${box()}${esc(oneLine(h.title))}${h.subject ? ` <span style="color:${MUTED};">· ${esc(oneLine(h.subject))}</span>` : ''}</td>`
      + `<td style="padding:2px 0;color:${MUTED};">${h.due_label ? esc(w(l, 'due', { d: oneLine(h.due_label) })) : ''}</td></tr>`).join('')
    + '</table>';
}

// A kid's routine: each item a row, a box for each day it applies (none on a day it doesn't: school days only).
function routineGrid(s: Sheet): string {
  const sections = (s.routine || []).filter((r) => r && (r.items || []).length);
  if (!sections.length) return '';
  const l = lang(s.lang);
  const heads = s.days.map((d) => `<th style="width:46px;padding:3px;border:1px solid ${RULE};background:${SOFT};font-size:10px;">${esc(dayHead(d, l))}</th>`).join('');
  const rows: string[] = [];
  for (const sec of sections) {
    rows.push(`<tr><td colspan="8" style="padding:5px 4px 2px;border:1px solid ${RULE};font-size:11px;"><b>${esc(oneLine(sec.title))}</b>${sec.note ? ` <span style="color:${MUTED};">· ${esc(oneLine(sec.note))}</span>` : ''}</td></tr>`);
    let part = '';
    for (const it of sec.items) {
      if (it.part && it.part !== part) {
        part = it.part;
        rows.push(`<tr><td colspan="8" style="padding:2px 4px 2px 10px;border:1px solid ${RULE};font-size:10px;color:${MUTED};">${esc(oneLine(it.part))}</td></tr>`);
      }
      const days = (it.days || []).slice(0, 7).map((on) => `<td style="text-align:center;padding:2px;border:1px solid ${RULE};">${on ? box() : ''}</td>`).join('');
      rows.push(`<tr><td style="padding:2px 4px 2px 14px;border:1px solid ${RULE};font-size:10.5px;">${esc(oneLine(it.title))}${it.tag ? ` <span style="color:${MUTED};">(${esc(oneLine(it.tag))})</span>` : ''}</td>${days}</tr>`);
    }
  }
  return `<div style="page-break-inside:avoid;break-inside:avoid;">${h2(w(l, 'routine'))}`
    + `<p style="margin:0 0 4px;font-family:${FONT};font-size:10px;color:${MUTED};">${esc(w(l, 'routine_help'))}</p>`
    + `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:${FONT};color:${INK};">`
    + `<tr><th style="border:1px solid ${RULE};background:${SOFT};"></th>${heads}</tr>${rows.join('')}</table></div>`;
}

function shoppingList(s: Sheet): string {
  const items = (s.shopping || []).filter((i) => i && i.name);
  if (!items.length) return '';
  const l = lang(s.lang);
  return h2(w(l, 'shopping')) + `<div style="font-family:${FONT};font-size:11px;color:${INK};column-count:3;column-gap:24px;">`
    + items.map((i) => `<div style="margin:0 0 3px;break-inside:avoid;">${box()}${esc(oneLine(i.name))}${i.note ? ` <span style="color:${MUTED};">· ${esc(oneLine(i.note))}</span>` : ''}</div>`).join('')
    + '</div>';
}

// One sheet: its heading, the week, then what goes under it.
export function sheetHtml(s: Sheet, last: boolean): string {
  const l = lang(s.lang);
  return `<div class="hh-sheet" lang="${l}" style="${last ? '' : 'page-break-after:always;break-after:page;'}padding:0 0 18px;">`
    + `<h1 style="margin:0 0 2px;font-family:${FONT};font-size:20px;color:${INK};">${esc(title(s))}</h1>`
    + `<p style="margin:0 0 8px;font-family:${FONT};font-size:11px;color:${MUTED};">${esc(w(l, 'week', { range: oneLine(s.range) }))}</p>`
    + weekGrid(s) + legend(s) + homeworkList(s) + routineGrid(s) + shoppingList(s)
    + '</div>';
}

// One sheet as plain text, for the text part of the email.
function sheetText(s: Sheet): string {
  const l = lang(s.lang);
  const out = [`${title(s)} · ${w(l, 'week', { range: oneLine(s.range) })}`];
  const steps = new Map<string, SheetStep[]>();
  for (const h of s.homework || []) for (const st of h.steps || []) {
    if (!steps.has(st.day)) steps.set(st.day, []);
    steps.get(st.day)!.push(st);
  }
  for (const d of s.days) {
    out.push('', `${oneLine(d.label)}${d.day_off ? ` (${w(l, 'day_off')})` : ''}`);
    const lines = (d.items || []).map((it) => {
      const time = it.time ? `${it.time}${it.end ? `–${it.end}` : ''} ` : '';
      const extra = [it.who, it.place, it.contractor, it.note].map((x) => oneLine(x)).filter(Boolean);
      return `${it.task ? '☐ ' : '- '}${time}${oneLine(it.title)}${extra.length ? ` · ${extra.join(' · ')}` : ''}${it.bring ? ` · ${w(l, 'bring')}: ${oneLine(it.bring)}` : ''}`;
    });
    for (const st of steps.get(d.day) || []) lines.push(`☐ ${st.kind === 'turn_in' ? `${w(l, 'turn_in')}: ` : ''}${oneLine(st.title)}${st.minutes ? ` (${w(l, 'min', { n: st.minutes })})` : ''}`);
    for (const m of d.meals || []) lines.push(`- ${oneLine(m.slot)}: ${oneLine(m.title)}${m.who ? ` · ${oneLine(m.who)}` : ''}`);
    out.push(...(lines.length ? lines : [w(l, 'nothing')]));
  }
  const hw = (s.homework || []).filter((h) => h && h.title);
  if (hw.length) {
    out.push('', w(l, 'homework'));
    for (const h of hw) out.push(`☐ ${oneLine(h.title)}${h.subject ? ` · ${oneLine(h.subject)}` : ''}${h.due_label ? ` · ${w(l, 'due', { d: oneLine(h.due_label) })}` : ''}`);
  }
  const routine = (s.routine || []).filter((r) => r && (r.items || []).length);
  if (routine.length) {
    out.push('', w(l, 'routine'));
    for (const r of routine) {
      out.push(`${oneLine(r.title)}${r.note ? ` · ${oneLine(r.note)}` : ''}`);
      for (const it of r.items) out.push(`  ☐ ${oneLine(it.title)}${it.tag ? ` (${oneLine(it.tag)})` : ''}`);
    }
  }
  const shop = (s.shopping || []).filter((i) => i && i.name);
  if (shop.length) {
    out.push('', w(l, 'shopping'));
    for (const i of shop) out.push(`☐ ${oneLine(i.name)}${i.note ? ` · ${oneLine(i.note)}` : ''}`);
  }
  return out.join('\n');
}

// The Sunday email: a line on top in the recipient's language, then each sheet (in its own language) on its own page.
// The subject names the sheets: "Week of Nov 16 – Nov 22: Family, Morgan, Taylor".
// "Nov 16 – Nov 22" / "16 nov – 22 nov" (as the database's short_date), from the week's Monday and Sunday.
const MONTHS = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
                 es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] };
function shortDate(d: string, l: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
  if (!m) return '';
  const mon = MONTHS[l][Number(m[2]) - 1], day = String(Number(m[3]));
  return l === 'es' ? `${day} ${mon}` : `${mon} ${day}`;
}

export function renderWeekly(sheets: Sheet[], recipient: { language?: string | null }): Email {
  const rl = lang(recipient.language);
  const list = sheets.filter(Boolean);
  const range = list.length ? (`${shortDate(list[0].monday, rl)} – ${shortDate(list[0].sunday, rl)}`) : '';
  const names = list.map((s) => (s.who === 'family' ? w(rl, 'family_short') : oneLine(s.name))).join(', ');
  const subject = oneLine(w(rl, 'subject', { range, names }));
  const intro = list.length === 1 ? w(rl, 'intro_one', { range }) : w(rl, 'intro', { range, n: list.length });
  const html = `<!doctype html>
<html lang="${rl}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
<style>@page { size: letter landscape; margin: 0.4in; } @media print { .hh-note { display: none !important; } .hh-sheet { padding: 0 !important; } }</style>
</head>
<body style="margin:0;padding:12px;background:#ffffff;color:${INK};font-family:${FONT};">
<div class="hh-note" style="margin:0 0 14px;padding:8px 10px;border:1px solid ${RULE};border-radius:8px;font-size:13px;line-height:1.4;">${esc(intro)} ${esc(w(rl, 'tip'))}</div>
${list.map((s, i) => sheetHtml(s, i === list.length - 1)).join('\n')}
<p class="hh-note" style="margin:12px 0 0;font-size:11px;color:${MUTED};">${esc(w(rl, 'footer'))}</p>
</body>
</html>`;
  const text = [intro, '', ...list.map((s) => sheetText(s)).join('\n\n----------\n\n').split('\n'), '', w(rl, 'footer')].join('\n');
  return { subject, html, text };
}

// The sheets to make, from household.weekly_sheets (or a preview's own list): at most 8, nobody twice, 'family' or a
// person's id, 'en' or 'es'. Anything else is left out.
export function sheetChoices(raw: unknown): SheetChoice[] {
  const out: SheetChoice[] = [];
  if (!Array.isArray(raw)) return out;
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const who = (x as { who?: unknown }).who;
    const l = (x as { lang?: unknown }).lang;
    if (typeof who !== 'string' || (who !== 'family' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(who))) continue;
    if (l !== 'en' && l !== 'es') continue;
    if (out.some((c) => c.who === who)) continue;
    out.push({ who, lang: l });
    if (out.length === 8) break;
  }
  return out;
}

export const noSheets = (l: unknown) => w(l, 'none');
