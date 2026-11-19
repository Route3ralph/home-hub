// The Sunday summary (docs/v1.3-homework.md §35): one email to a tutor, with this week's and last week's numbers for
// the kid his link is for, in the link's language. The database works the numbers out (public.tutor_summary, from
// private.task_week); this file only lays them out.
// Rules, as due.ts: every dynamic string is escaped; there are no links at all (above all not the tutor link: a
// mistyped address must not open his page). Inline styles only (most mail apps drop <style>).

import { esc } from './render.ts';
import type { Email } from './render.ts';
import { oneLine } from './util.ts';

export type Week = {
  from?: string; to?: string; assigned?: number; done?: number; on_time?: number; reminders?: number; started?: number;
  started_unprompted?: number; avg_minutes_to_start?: number | null; avg_minutes_to_finish?: number | null; points?: number;
};
export type Summary = { to: string; language: string; label: string; kid: string; week: { this: Week; last: Week } };

// Fixed words, in English and Spanish, as the tutor link's own table says them (assets/day.js, cw_*).
const WORDS = {
  en: {
    subject: '{kid}\'s week: {done} of {assigned} tasks done, {unprompted} started with no reminder',
    hello: 'Hi {tutor},', intro: 'Here is how {kid} started and finished his tasks this week (Monday to Sunday), next to last week.',
    this: 'This week', last: 'Last week', min: '{n} min', none: '—',
    assigned: 'Tasks due', done: 'Done', on_time: 'Done on time', reminders: 'Reminders', started: 'Started',
    unprompted: 'Started with no reminder', to_start: 'From the task\'s time to Start', to_finish: 'From Start to done', points: 'Points earned',
    more: 'Your tutor link has the same numbers, and his homework.',
    footer: 'From Home Hub, every Sunday. {kid}\'s family can stop it on their Homework page.',
  },
  es: {
    subject: 'La semana de {kid}: {done} de {assigned} tareas hechas, {unprompted} empezadas sin recordatorio',
    hello: 'Hola, {tutor}:', intro: 'Así empezó y terminó {kid} sus tareas esta semana (de lunes a domingo), junto a la semana pasada.',
    this: 'Esta semana', last: 'La semana pasada', min: '{n} min', none: '—',
    assigned: 'Tareas para hacer', done: 'Hechas', on_time: 'Hechas a tiempo', reminders: 'Recordatorios', started: 'Empezadas',
    unprompted: 'Empezadas sin recordatorio', to_start: 'De la hora de la tarea a Empezar', to_finish: 'De Empezar a hecha', points: 'Puntos ganados',
    more: 'Tu enlace de tutor tiene los mismos números, y su tarea.',
    footer: 'Desde Home Hub, cada domingo. La familia de {kid} puede detenerlo en su página de Tareas.',
  },
} as const;
type Lang = keyof typeof WORDS;
const lang = (l: unknown): Lang => (l === 'es' ? 'es' : 'en');
const w = (l: Lang, key: keyof typeof WORDS['en'], vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), WORDS[l][key] as string);

const INK = '#1f1b16', MUTED = '#5f574c', RULE = '#cfc8bd';
const FONT = 'Helvetica,Arial,sans-serif';

const count = (x: unknown) => (Number.isFinite(Number(x)) ? Math.max(0, Math.round(Number(x))) : 0);
const ROWS: [keyof typeof WORDS['en'], keyof Week, boolean][] = [
  ['assigned', 'assigned', false], ['done', 'done', false], ['on_time', 'on_time', false], ['reminders', 'reminders', false],
  ['started', 'started', false], ['unprompted', 'started_unprompted', false], ['to_start', 'avg_minutes_to_start', true],
  ['to_finish', 'avg_minutes_to_finish', true], ['points', 'points', false],
];
function cell(l: Lang, wk: Week, key: keyof Week, minutes: boolean): string {
  const v = wk ? wk[key] : undefined;
  if (minutes) return v == null || !Number.isFinite(Number(v)) ? w(l, 'none') : w(l, 'min', { n: count(v) });
  return String(count(v));
}

// The tutor's first name, as the Homework page's link message greets him ("Pat Lee, tutor" -> "Pat").
const firstName = (label: string) => oneLine(label).split(/[\s,]+/)[0] || oneLine(label);

export function renderSummary(s: Summary): Email {
  const l = lang(s && s.language);
  const kid = oneLine(s && s.kid);
  const tutor = firstName(String((s && s.label) || ''));
  const wk = (s && s.week) || { this: {}, last: {} };
  const now: Week = wk.this || {}, before: Week = wk.last || {};
  const subject = oneLine(w(l, 'subject', { kid, done: count(now.done), assigned: count(now.assigned), unprompted: count(now.started_unprompted) }));
  const th = `padding:4px 8px;border-bottom:1px solid ${RULE};text-align:right;`;
  const rows = ROWS.map(([word, key, minutes]) => `<tr><th scope="row" style="padding:4px 8px;border-bottom:1px solid ${RULE};text-align:left;font-weight:normal;">${esc(w(l, word))}</th>`
    + `<td style="${th}font-weight:bold;">${esc(cell(l, now, key, minutes))}</td><td style="${th}color:${MUTED};">${esc(cell(l, before, key, minutes))}</td></tr>`).join('');
  const html = `<!doctype html>
<html lang="${l}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:16px;background:#ffffff;color:${INK};font-family:${FONT};">
<div style="max-width:560px;margin:0 auto;font-size:14px;line-height:1.4;">
<p style="margin:0 0 8px;">${esc(w(l, 'hello', { tutor }))}</p>
<p style="margin:0 0 12px;">${esc(w(l, 'intro', { kid }))}</p>
<table style="border-collapse:collapse;width:100%;max-width:480px;font-size:14px;">
<thead><tr><th scope="col"></th><th scope="col" style="${th}">${esc(w(l, 'this'))}</th><th scope="col" style="${th}color:${MUTED};">${esc(w(l, 'last'))}</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p style="margin:12px 0 0;">${esc(w(l, 'more'))}</p>
<p style="margin:18px 0 0;font-size:11px;color:${MUTED};">${esc(w(l, 'footer', { kid }))}</p>
</div>
</body>
</html>`;
  const pad = Math.max(...ROWS.map(([word]) => w(l, word).length));
  const text = [
    w(l, 'hello', { tutor }), '', w(l, 'intro', { kid }), '',
    `${''.padEnd(pad)}  ${w(l, 'this')} | ${w(l, 'last')}`,
    ...ROWS.map(([word, key, minutes]) => `${w(l, word).padEnd(pad)}  ${cell(l, now, key, minutes)} | ${cell(l, before, key, minutes)}`),
    '', w(l, 'more'), '', w(l, 'footer', { kid }),
  ].join('\n');
  return { subject, html, text };
}
