// The school's missing-assignment notice (docs/v1.3-homework.md §37): Blackbaud's email "… has indicated a missing
// assignment", forwarded to the hub's inbox by a family member (inbox.ts). This file only reads it: no AI, no guessing.
//
// The notice, as Blackbaud writes it (a forward puts its own header lines and quote marks around it; both are fine):
//   Subject: <school> has indicated a missing assignment
//   As requested, this email is to notify you that you have a missing assignment:
//   <the assignment's title>
//   <the class, "Science 6 - A">
//   Assigned: 11/3/2026
//   Due: 11/3/2026
// Anything else is not a notice (null), and the inbox treats the email as before.

export type MissingNotice = { title: string; klass: string; assigned: string | null; due: string };

const PHRASE = /notify you that you have a missing assignment\s*:?\s*$/i;

// "11/3/2026" -> "2026-11-03"; null for anything that isn't a real date.
export function usDate(s: string): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(s || '');
  if (!m) return null;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// The class without its section: "Science 6 - A" -> "Science 6" (the school's calendar feed names it so).
export function classOf(s: string): string {
  return String(s || '').replace(/\s+-\s+[A-Za-z0-9]{1,3}$/, '').replace(/\s+/g, ' ').trim();
}

export function missingNotice(subject: string, text: string): MissingNotice | null {
  const all = `${subject || ''}\n${text || ''}`;
  if (!/has indicated a missing assignment/i.test(all) && !/you have a missing assignment/i.test(all)) return null;
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.replace(/^(\s*>)+\s?/, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim());
  const at = lines.findIndex((l) => PHRASE.test(l));
  if (at < 0) return null;
  const rest = lines.slice(at + 1);
  const assignedAt = rest.findIndex((l) => /^Assigned:/i.test(l));
  const dueAt = rest.findIndex((l) => /^Due:/i.test(l));
  if (dueAt < 0) return null;
  const head = rest.slice(0, assignedAt >= 0 ? Math.min(assignedAt, dueAt) : dueAt).filter(Boolean);
  if (head.length < 2) return null;
  const title = head[0];
  const klass = head[head.length - 1];
  const due = usDate(rest[dueAt].replace(/^Due:/i, ''));
  const assigned = assignedAt >= 0 ? usDate(rest[assignedAt].replace(/^Assigned:/i, '')) : null;
  if (!due || title.length > 120 || !klass || classOf(klass).length > 40 || /^(https?:|you may access)/i.test(title)) return null;
  return { title, klass, assigned, due };
}
