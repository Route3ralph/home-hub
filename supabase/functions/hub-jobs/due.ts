// Due tomorrow (docs/v1.3-homework.md §29): the evening email of each homework kid's lists. The database works out the
// lists, in the recipient's language (public.due_list); this file only lays them out, in that language.
// Rules, as render.ts and weekly.ts: every dynamic string is escaped; text is never turned into links; there are no
// links at all. Inline styles only (most mail apps drop <style>).

import { esc } from './render.ts';
import type { Email } from './render.ts';
import { oneLine } from './util.ts';

export type DueItem = {
  title: string; subject?: string | null; due?: string; due_label?: string;
  done?: boolean; missing?: boolean; count?: { goal: number; done: number } | null;
};
export type DueKid = { id: string; name: string; tomorrow: DueItem[]; late: DueItem[]; coming: DueItem[] };
export type DueList = {
  day: string; tomorrow: string; tomorrow_label: string; coming_to: string; coming_to_label: string; kids: DueKid[];
};

// Fixed words, in English and Spanish. Titles, classes and names stay as written.
const WORDS = {
  en: {
    subject: 'Due tomorrow ({day}): {what}', subject_none: 'Nothing due tomorrow ({day})',
    what_one: '{n} for {name}', what_many: '{parts}',
    tomorrow: 'Due tomorrow, {day}', late: 'Not marked done yet', coming: 'Coming up, to {day}',
    nothing: 'Nothing due tomorrow.', done: 'done', missing: 'Missing', due: 'due {d}', count: '{done} of {goal}',
    no_kids: 'Nobody has homework turned on.',
    footer: 'From Home Hub, every evening. Change the time or who gets it on Settings, Due tomorrow.',
  },
  es: {
    subject: 'Para mañana ({day}): {what}', subject_none: 'Nada para mañana ({day})',
    what_one: '{n} de {name}', what_many: '{parts}',
    tomorrow: 'Para mañana, {day}', late: 'Sin marcar como hecho', coming: 'Próximamente, hasta el {day}',
    nothing: 'Nada para mañana.', done: 'hecho', missing: 'Falta', due: 'entrega {d}', count: '{done} de {goal}',
    no_kids: 'Nadie tiene las tareas activadas.',
    footer: 'Desde Home Hub, cada tarde. La hora y quién lo recibe se cambian en Ajustes, Para mañana.',
  },
} as const;
type Lang = keyof typeof WORDS;
const lang = (l: unknown): Lang => (l === 'es' ? 'es' : 'en');
const w = (l: Lang, key: keyof typeof WORDS['en'], vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), WORDS[l][key] as string);

const INK = '#1f1b16', MUTED = '#5f574c', RULE = '#cfc8bd', LATE = '#9a3412', OK = '#2f5d50';
const FONT = 'Helvetica,Arial,sans-serif';

const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

// "Volcano poster · Science · 5 of 7 · Missing · due Thu Nov 5" (the date only where the heading doesn't say it).
function line(it: DueItem, l: Lang, withDate: boolean): string {
  const bits = [oneLine(it.subject)];
  if (it.count && Number.isFinite(Number(it.count.goal))) bits.push(w(l, 'count', { done: Number(it.count.done) || 0, goal: Number(it.count.goal) }));
  if (it.missing) bits.push(w(l, 'missing'));
  if (withDate && it.due_label) bits.push(w(l, 'due', { d: oneLine(it.due_label) }));
  if (it.done) bits.push(w(l, 'done'));
  return bits.filter(Boolean).join(' · ');
}

function itemHtml(it: DueItem, l: Lang, withDate: boolean): string {
  const sub = line(it, l, withDate);
  const mark = it.done ? '✓' : '☐';
  return `<li style="margin:0 0 6px;list-style:none;${it.done ? 'color:#8a8277;' : ''}">`
    + `<span style="display:inline-block;width:18px;">${mark}</span>`
    + `<span style="${it.done ? 'text-decoration:line-through;' : 'font-weight:bold;'}">${esc(oneLine(it.title))}</span>`
    + (sub ? `<span style="color:${it.missing ? LATE : MUTED};"> · ${esc(sub)}</span>` : '')
    + '</li>';
}

function sectionHtml(title: string, items: DueItem[], l: Lang, withDate: boolean, colour: string): string {
  if (!items.length) return '';
  return `<h3 style="margin:12px 0 6px;font-size:14px;color:${colour};">${esc(title)}</h3>`
    + `<ul style="margin:0;padding:0;font-size:14px;line-height:1.4;">${items.map((it) => itemHtml(it, l, withDate)).join('')}</ul>`;
}

function sectionText(title: string, items: DueItem[], l: Lang, withDate: boolean): string[] {
  if (!items.length) return [];
  return ['', title, ...items.map((it) => {
    const sub = line(it, l, withDate);
    return `${it.done ? '[x]' : '[ ]'} ${oneLine(it.title)}${sub ? ` · ${sub}` : ''}`;
  })];
}

const open = (k: DueKid) => arr<DueItem>(k.tomorrow).filter((it) => !it.done).length;

export function renderDue(list: DueList, recipient: { language?: string | null }): Email {
  const l = lang(recipient.language);
  const kids = arr<DueKid>(list && list.kids);
  const day = oneLine(list && list.tomorrow_label);
  const counts = kids.map((k) => ({ name: oneLine(k.name), n: open(k) })).filter((x) => x.n > 0);
  const subject = oneLine(counts.length
    ? w(l, 'subject', { day, what: counts.map((x) => w(l, 'what_one', { n: x.n, name: x.name })).join(', ') })
    : w(l, 'subject_none', { day }));

  const many = kids.length > 1;
  const kidHtml = (k: DueKid) => {
    const tomorrow = arr<DueItem>(k.tomorrow), late = arr<DueItem>(k.late), coming = arr<DueItem>(k.coming);
    return (many ? `<h2 style="margin:16px 0 4px;font-size:17px;border-bottom:1px solid ${RULE};padding-bottom:3px;">${esc(oneLine(k.name))}</h2>` : '')
      + (tomorrow.length
        ? sectionHtml(w(l, 'tomorrow', { day }), tomorrow, l, false, INK)
        : `<p style="margin:10px 0 6px;font-size:14px;color:${OK};"><b>${esc(w(l, 'nothing'))}</b></p>`)
      + sectionHtml(w(l, 'late'), late, l, true, LATE)
      + sectionHtml(w(l, 'coming', { day: oneLine(list.coming_to_label) }), coming, l, true, MUTED);
  };
  const kidText = (k: DueKid) => [
    ...(many ? ['', oneLine(k.name).toUpperCase()] : []),
    ...(arr<DueItem>(k.tomorrow).length ? sectionText(w(l, 'tomorrow', { day }), arr<DueItem>(k.tomorrow), l, false) : ['', w(l, 'nothing')]),
    ...sectionText(w(l, 'late'), arr<DueItem>(k.late), l, true),
    ...sectionText(w(l, 'coming', { day: oneLine(list.coming_to_label) }), arr<DueItem>(k.coming), l, true),
  ];

  const body = kids.length ? kids.map(kidHtml).join('\n') : `<p style="font-size:14px;">${esc(w(l, 'no_kids'))}</p>`;
  const html = `<!doctype html>
<html lang="${l}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:16px;background:#ffffff;color:${INK};font-family:${FONT};">
<div style="max-width:560px;margin:0 auto;">
<h1 style="margin:0 0 4px;font-size:19px;">${esc(subject)}</h1>
${body}
<p style="margin:18px 0 0;font-size:11px;color:${MUTED};">${esc(w(l, 'footer'))}</p>
</div>
</body>
</html>`;
  const text = [subject, ...(kids.length ? kids.flatMap(kidText) : ['', w(l, 'no_kids')]), '', w(l, 'footer')].join('\n');
  return { subject, html, text };
}
