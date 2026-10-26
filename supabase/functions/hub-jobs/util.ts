// Small pieces shared by handler.ts, render.ts and calendar.ts, kept here so handler.ts and
// calendar.ts don't import each other. No imports from outside, so it runs in the Node tests.

export const DETAIL_MAX = 300;        // one line of detail or error, as stored for Settings

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// The parts of supabase-js used here. Queries are chained and awaited, like supabase-js.
export type Result<T = any> = { data: T | null; error: { message?: string; code?: string } | null };
export interface Db {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<Result>;
  from(table: string): any;
}
export interface Deps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  service: () => Db;                     // the service-role key: the job functions and people_confirm
  user: (authorization: string) => Db;   // the caller's sign-in and the publishable key: whoami, status
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// One line of text: no line breaks or control characters (titles, names, subjects).
// \s also matches the Unicode line and paragraph separators (U+2028, U+2029). Don't write those two
// as escapes here: deployed through the Supabase MCP, they reached the bundler as real line breaks,
// which end a regular expression, and the deploy failed ("Unterminated regexp literal").
export const oneLine = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

// An error's message on one line, at most DETAIL_MAX characters. Only for errors from the database
// or from code: never for anything read from a secret or a token exchange (those quote their input).
export const message = (err: unknown) => oneLine((err as { message?: string })?.message ?? err).slice(0, DETAIL_MAX) || 'unknown error';

// Compares secrets without stopping at the first difference, so timing doesn't reveal how much matched.
export function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// PostgREST's answer when a function or table isn't in the schema (migration 0003 not applied yet).
export const noSchema = (error: { message?: string; code?: string } | null | undefined) =>
  !!error && (['PGRST202', 'PGRST205', '42883', '42P01'].includes(String(error.code ?? ''))
    || /could not find the (function|table)|does not exist/i.test(String(error.message ?? '')));
