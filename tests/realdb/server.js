// The real-database harness's server: the site's static files, plus the part of Supabase the site
// uses (PostgREST and Auth), answered by a real Postgres with the real schema, migrations, row-level
// security and functions. Nothing is faked except who you are: the access token is an unsigned JWT
// for whichever email typed the code 123456.
//
//   /rest/v1/<table>      GET (select=*|cols, eq/neq/gt/gte/lt/lte/like/ilike/is/in/cs/cd/ov and not.*,
//                         order, limit, offset; Accept: application/vnd.pgrst.object+json), POST (insert,
//                         Prefer: return=representation|minimal, resolution=merge-duplicates|ignore-duplicates
//                         with on_conflict, the columns parameter), PATCH, DELETE
//   /rest/v1/rpc/<fn>     POST (or GET) with named arguments, shaped as PostgREST shapes them: a scalar, an
//                         object for a single composite, an array for setof, 204 for void
//   errors                PostgREST's JSON ({ code, details, hint, message }) and HTTP statuses (42501 → 401
//                         signed out / 403 signed in, P0001 → 400, PGRST116 → 406, PGRST202 → 404, …)
//   /auth/v1/otp          sends "the code" (always 123456); new emails go through hook_family_only_signup,
//                         as Supabase's Before User Created hook would
//   /auth/v1/verify       type email, token 123456 → a session; /auth/v1/user; /auth/v1/logout; /auth/v1/token
//   /functions/v1/<name>  the handler a test plugs in (opts.functions; lib.js runs the real hub-jobs handler
//                         against this database, with Resend faked), else 404 as when it isn't deployed
//   /config.js            (and <prefix>/config.js) points the site here
//
// Each request runs in its own transaction as role anon or authenticated, with request.jwt.claims set
// from the token, exactly as PostgREST does on Supabase. hub.now pins the household clock: it starts at
// --now (default Tue 2026-10-27 09:00 New York) and runs forward in real time.
//
// Test-only endpoints (the server listens on 127.0.0.1 only):
//   POST /__test/sql    { sql }           run SQL as the database owner; → { rows: [{col: text}], error }
//   POST /__test/migrate { sql }          run a migration file in its own session, as the owner does in
//                                         the SQL editor, then read the schema again (Supabase's PostgREST
//                                         reloads its schema cache after DDL); → { error, notices }
//   GET  /__test/clock                    → { now }          POST /__test/clock { now }: move the clock
//   GET  /__test/requests?after=N         → every API request after the Nth: method, path, status, error
//   GET  /__test/mail                     → the sign-in codes "sent"
//
// Run: node tests/realdb/server.js --socket DIR --port PGPORT --db NAME [--listen 0] [--now ISO]
//      (tests/realdb/run.sh does this). Prints "listening http://127.0.0.1:N" when ready.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect, lit, ident } = require('./pg');

const REPO = path.resolve(__dirname, '../..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
const CORS = {
  'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-expose-headers': '*',
};
const OTP = '123456';

class ApiError extends Error {
  constructor(status, body) { super(body.message); this.status = status; this.body = body; }
}
const pgrst = (status, code, message, details = null, hint = null) => new ApiError(status, { code, details, hint, message });

// PostgREST's SQLSTATE → HTTP status (src/PostgREST/Error.hs, pgErrorStatus).
function pgStatus(code, authed) {
  const c = String(code || '');
  if (!c) return 500;
  if (/^08/.test(c)) return 503;
  if (/^09/.test(c)) return 500;
  if (/^0L|^0P/.test(c)) return 403;
  if (c === '23503' || c === '23505') return 409;
  if (c === '25006') return 405;
  if (/^25|^2D|^38|^39|^3B|^40|^55|^57|^58|^F0|^HV|^XX/.test(c)) return 500;
  if (/^28/.test(c)) return 403;
  if (/^53/.test(c)) return 503;
  if (/^54/.test(c)) return 413;
  if (c === 'P0001') return 400;
  if (/^P0/.test(c)) return 500;
  if (c === '42883' || c === '42P01') return 404;
  if (c === '42P17') return 500;
  if (c === '42501') return authed ? 403 : 401;
  if (/^PT\d{3}$/.test(c)) return Number(c.slice(2));
  return 400;
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch (e) { return null; }
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1], i++;
  return o;
}

// ---------------------------------------------------------------------
// Schema cache (what PostgREST reads at startup)
// ---------------------------------------------------------------------
async function loadCache(db) {
  const tables = await db.query(`
    select c.relname, json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
             'identity', a.attidentity, 'generated', a.attgenerated) order by a.attnum)::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'p')
    group by c.relname`);
  const pks = await db.query(`
    select c.relname, json_agg(a.attname order by k.ord)::text
    from pg_constraint x join pg_class c on c.oid = x.conrelid join pg_namespace n on n.oid = c.relnamespace
    cross join lateral unnest(x.conkey) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
    where n.nspname = 'public' and x.contype = 'p'
    group by c.relname`);
  const fns = await db.query(`
    select p.proname, json_build_object(
      'args', coalesce((select json_agg(json_build_object('name', coalesce(p.proargnames[k], ''), 'type', format_type(u.t, null),
                                    'mode', coalesce(p.proargmodes[k]::text, 'i')) order by k)
                        from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality u (t, k)), '[]'),
      'ndefaults', p.pronargdefaults, 'setof', p.proretset, 'rettype', format_type(p.prorettype, null),
      'typtype', t.typtype, 'volatile', p.provolatile)::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
    where n.nspname = 'public' and p.prokind = 'f'`);
  for (const r of [tables, pks, fns]) if (r.error) throw new Error(`schema cache: ${r.error.message}`);
  const cache = { tables: new Map(), pks: new Map(), fns: new Map() };
  tables.rows.forEach(([name, cols]) => cache.tables.set(name, JSON.parse(cols)));
  pks.rows.forEach(([name, cols]) => cache.pks.set(name, JSON.parse(cols)));
  fns.rows.forEach(([name, def]) => {
    const d = JSON.parse(def);
    if (!cache.fns.has(name)) cache.fns.set(name, []);
    cache.fns.get(name).push(d);
  });
  return cache;
}

// ---------------------------------------------------------------------
// PostgREST request parsing
// ---------------------------------------------------------------------
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict', 'and', 'or']);

function splitTopLevel(s, sep = ',') {
  const out = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === '(' || ch === '{')) depth++;
    if (!quoted && (ch === ')' || ch === '}')) depth--;
    if (ch === sep && !depth && !quoted) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function columnsOf(cache, table) {
  const cols = cache.tables.get(table);
  if (!cols) throw pgrst(404, 'PGRST205', `Could not find the table 'public.${table}' in the schema cache`);
  return cols;
}

// qualifier: the table's qualified name, for a mutation's RETURNING (an UPDATE … FROM has the
// payload's columns in scope too, so PostgREST qualifies every column).
function selectSql(cache, table, select, qualifier) {
  const cols = columnsOf(cache, table);
  const s = (select == null || select === '') ? '*' : select;
  if (s === '*') return '*';
  return splitTopLevel(s).map((item) => {
    if (/[()!]/.test(item)) throw new Error(`realdb server: embedded resources aren't supported (select=${s})`);
    let alias = null;
    let col = item;
    const colon = item.indexOf(':');
    if (colon > 0 && item[colon + 1] !== ':') { alias = item.slice(0, colon); col = item.slice(colon + 1); }
    let cast = null;
    const dc = col.indexOf('::');
    if (dc > 0) { cast = col.slice(dc + 2); col = col.slice(0, dc); }
    col = col.replace(/^"|"$/g, '');
    if (col !== '*' && !cols.some((c) => c.name === col)) {
      throw pgrst(400, '42703', `column ${table}.${col} does not exist`);
    }
    let expr = col === '*' ? (qualifier ? `${qualifier}.*` : '*') : `${qualifier ? `${qualifier}.` : ''}${ident(col)}`;
    if (cast) expr = `${expr}::${cast}`;
    return alias ? `${expr} as ${ident(alias)}` : expr;
  }).join(', ');
}

function arrayLiteral(items) {
  return `{${items.map((x) => (x === 'null' ? 'NULL' : `"${String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')}}`;
}

function parseList(val) {
  // (a,b,"c,d") → ['a','b','c,d']
  const inner = val.replace(/^\(/, '').replace(/\)$/, '');
  if (inner === '') return [];
  return splitTopLevel(inner).map((x) => x.trim().replace(/^"(.*)"$/s, '$1'));
}

function filterSql(cache, table, qualifier, col, spec) {
  const cols = columnsOf(cache, table);
  if (!cols.some((c) => c.name === col)) throw pgrst(400, '42703', `column ${table}.${col} does not exist`);
  const c = `${qualifier}.${ident(col)}`;
  let neg = false;
  let s = spec;
  if (s.startsWith('not.')) { neg = true; s = s.slice(4); }
  const dot = s.indexOf('.');
  if (dot < 0) throw pgrst(400, 'PGRST100', `"failed to parse filter (${spec})" (line 1, column 1)`, `unexpected end of input expecting operator`);
  const op = s.slice(0, dot);
  const val = s.slice(dot + 1);
  let expr;
  switch (op) {
    case 'eq': expr = `${c} = ${lit(val)}`; break;
    case 'neq': expr = `${c} <> ${lit(val)}`; break;
    case 'gt': expr = `${c} > ${lit(val)}`; break;
    case 'gte': expr = `${c} >= ${lit(val)}`; break;
    case 'lt': expr = `${c} < ${lit(val)}`; break;
    case 'lte': expr = `${c} <= ${lit(val)}`; break;
    case 'like': expr = `${c} like ${lit(val.replace(/\*/g, '%'))}`; break;
    case 'ilike': expr = `${c} ilike ${lit(val.replace(/\*/g, '%'))}`; break;
    case 'is': {
      const v = val.toLowerCase();
      if (!['null', 'true', 'false', 'unknown'].includes(v)) throw pgrst(400, 'PGRST100', `"failed to parse filter (${spec})" (line 1, column 4)`);
      expr = `${c} is ${v}`;
      break;
    }
    case 'in': expr = `${c} = any (${lit(arrayLiteral(parseList(val)))})`; break;
    case 'cs': expr = `${c} @> ${lit(val.startsWith('(') ? arrayLiteral(parseList(val)) : val)}`; break;
    case 'cd': expr = `${c} <@ ${lit(val.startsWith('(') ? arrayLiteral(parseList(val)) : val)}`; break;
    case 'ov': expr = `${c} && ${lit(val.startsWith('(') ? arrayLiteral(parseList(val)) : val)}`; break;
    default: throw new Error(`realdb server: unsupported filter operator ${op} (${col}=${spec})`);
  }
  return neg ? `not (${expr})` : expr;
}

function whereSql(cache, table, qualifier, params) {
  const conds = [];
  for (const [k, v] of params) {
    if (RESERVED.has(k)) {
      if (k === 'and' || k === 'or') throw new Error(`realdb server: logical filters (${k}) aren't supported`);
      continue;
    }
    conds.push(filterSql(cache, table, qualifier, k, v));
  }
  return conds.length ? `where ${conds.join(' and ')}` : '';
}

function orderSql(cache, table, order) {
  if (!order) return '';
  const cols = columnsOf(cache, table);
  return `order by ${order.split(',').map((o) => {
    const [col, ...mods] = o.split('.');
    if (!cols.some((c) => c.name === col)) throw pgrst(400, '42703', `column ${table}.${col} does not exist`);
    let sql = ident(col);
    for (const m of mods) {
      if (m === 'asc') sql += ' asc';
      else if (m === 'desc') sql += ' desc';
      else if (m === 'nullsfirst') sql += ' nulls first';
      else if (m === 'nullslast') sql += ' nulls last';
      else throw pgrst(400, 'PGRST100', `"failed to parse order (${o})"`);
    }
    return sql;
  }).join(', ')}`;
}

function parsePrefer(h) {
  const out = {};
  String(h || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((p) => {
    const [k, v] = p.split('=');
    out[k.trim()] = (v || '').trim();
  });
  return out;
}

// ---------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------
async function start(opts = {}) {
  const db = await connect({ socketDir: opts.socket, port: opts.port, database: opts.db });
  let cache = await loadCache(db);
  const roots = Object.assign({ '/': REPO }, opts.roots || {});
  let clockBase = Date.parse(opts.now || '2026-10-27T13:00:00Z');
  let clockStart = Date.now();
  const hubNow = () => new Date(clockBase + (Date.now() - clockStart)).toISOString();
  const requests = [];
  const mail = [];
  const users = new Map();   // email → { id, created_at }
  const otps = new Map();    // email → code
  let base = '';

  // One transaction at a time on the one connection, like a pool of one.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function tx({ role, claims, readOnly, method, reqPath }, body) {
    return serial(async () => {
      const run = async (sql) => {
        const r = await db.query(sql);
        if (r.error) throw r.error;
        return r;
      };
      await run(readOnly ? 'begin isolation level read committed read only' : 'begin isolation level read committed');
      try {
        await run(`select set_config('role', ${lit(role)}, true), set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true),
                          set_config('request.method', ${lit(method)}, true), set_config('request.path', ${lit(reqPath)}, true),
                          set_config('hub.now', ${lit(hubNow())}, true)`);
        const out = await body(run);
        if (out && out.rollback) await run('rollback');
        else await run('commit');
        return out;
      } catch (e) {
        await db.query('rollback');
        throw e;
      }
    });
  }

  function who(req) {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const claims = decodeJwt(auth);
    if (claims && claims.role === 'authenticated') return { role: 'authenticated', claims, email: claims.email || null };
    if (claims && claims.role === 'service_role') return { role: 'service_role', claims, email: null };
    return { role: 'anon', claims: { role: 'anon', iss: 'supabase' }, email: null };
  }

  const send = (res, status, payload, headers = {}) => {
    const h = Object.assign({}, CORS, headers);
    if (payload === undefined || status === 204) { res.writeHead(status, h); res.end(); return; }
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!h['content-type']) h['content-type'] = 'application/json; charset=utf-8';
    res.writeHead(status, h);
    res.end(text);
  };

  // ---- PostgREST: tables
  async function table(req, url, name, bodyText, ident0) {
    const method = req.method;
    const params = [...url.searchParams];
    const sp = url.searchParams;
    const prefer = parsePrefer(req.headers.prefer);
    const singular = String(req.headers.accept || '').includes('application/vnd.pgrst.object+json');
    const cols = columnsOf(cache, name);
    const T = `${ident('public')}.${ident(name)}`;
    const shape = (rowsJson, n, status) => {
      if (singular) {
        if (n !== 1) return { error: pgrst(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${n} rows`) };
        return { status, body: JSON.stringify(JSON.parse(rowsJson)[0]), headers: { 'content-type': 'application/vnd.pgrst.object+json; charset=utf-8' } };
      }
      return { status, body: rowsJson, headers: { 'content-range': n ? `0-${n - 1}/*` : '*/*' } };
    };

    if (method === 'GET' || method === 'HEAD') {
      const sel = selectSql(cache, name, sp.get('select'));
      const limit = sp.get('limit') != null ? `limit ${Number(sp.get('limit'))}` : '';
      const offset = sp.get('offset') != null ? `offset ${Number(sp.get('offset'))}` : '';
      const sql = `select coalesce(json_agg(_t), '[]')::text, count(_t) from (select ${sel} from ${T} ${whereSql(cache, name, T, params)} ${orderSql(cache, name, sp.get('order'))} ${limit} ${offset}) _t`;
      const out = await tx({ ...ident0, readOnly: true, method, reqPath: url.pathname }, async (run) => {
        const r = await run(sql);
        return shape(r.rows[0][0], Number(r.rows[0][1]), 200);
      });
      return out;
    }

    const wantsBody = prefer.return === 'representation';
    const sel = wantsBody ? selectSql(cache, name, sp.get('select'), T) : null;
    const returning = wantsBody ? (sel === '*' ? `${T}.*` : sel) : '1';
    const finish = (r, status) => {
      const n = Number(r.rows[0][1]);
      if (singular && n !== 1) return { rollback: true, error: pgrst(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${n} rows`) };
      if (!wantsBody) return { status: status === 201 ? 201 : 204, body: undefined, headers: { 'content-range': n ? `0-${n - 1}/*` : '*/*' } };
      return shape(r.rows[0][0], n, status);
    };
    const outer = wantsBody
      ? `select coalesce(json_agg(_t), '[]')::text, count(_t) from (select * from pgrst_source) _t`
      : `select '[]', count(*) from pgrst_source`;
    let body = null;
    if (bodyText) {
      try { body = JSON.parse(bodyText); } catch (e) { throw pgrst(400, 'PGRST102', 'Empty or invalid json'); }
    }
    const checkCol = (c) => {
      if (!cols.some((x) => x.name === c)) throw pgrst(400, 'PGRST204', `Could not find the '${c}' column of '${name}' in the schema cache`);
    };

    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body || {}];
      let insertCols;
      if (sp.get('columns')) insertCols = splitTopLevel(sp.get('columns')).map((c) => c.trim().replace(/^"|"$/g, ''));
      else {
        insertCols = Object.keys(rows[0] || {});
        const key = JSON.stringify(insertCols.slice().sort());
        if (rows.some((r) => JSON.stringify(Object.keys(r || {}).sort()) !== key)) throw pgrst(400, 'PGRST102', 'All object keys must match');
      }
      insertCols.forEach(checkCol);
      const conflictCols = sp.get('on_conflict') ? sp.get('on_conflict').split(',').map((c) => c.trim()) : (cache.pks.get(name) || []);
      let onConflict = '';
      if (prefer.resolution === 'merge-duplicates') {
        conflictCols.forEach(checkCol);
        onConflict = insertCols.length
          ? `on conflict (${conflictCols.map(ident).join(', ')}) do update set ${insertCols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`
          : `on conflict (${conflictCols.map(ident).join(', ')}) do nothing`;
      } else if (prefer.resolution === 'ignore-duplicates') {
        onConflict = `on conflict (${conflictCols.map(ident).join(', ')}) do nothing`;
      }
      const source = insertCols.length
        ? `insert into ${T} (${insertCols.map(ident).join(', ')}) select ${insertCols.map(ident).join(', ')} from json_populate_recordset(null::${T}, ${lit(JSON.stringify(rows))}::json) _ ${onConflict} returning ${returning}`
        : `insert into ${T} default values ${onConflict} returning ${returning}`;
      return tx({ ...ident0, readOnly: false, method, reqPath: url.pathname }, async (run) => {
        const r = await run(`with pgrst_source as (${source}) ${outer}`);
        return finish(r, 201);
      });
    }

    if (method === 'PATCH') {
      const patch = body && !Array.isArray(body) ? body : {};
      const setCols = Object.keys(patch);
      setCols.forEach(checkCol);
      if (!setCols.length) return { status: wantsBody ? 200 : 204, body: wantsBody ? '[]' : undefined };
      const source = `update ${T} set ${setCols.map((c) => `${ident(c)} = _.${ident(c)}`).join(', ')}
        from (select * from json_populate_record(null::${T}, ${lit(JSON.stringify(patch))}::json)) _
        ${whereSql(cache, name, T, params)} returning ${returning}`;
      return tx({ ...ident0, readOnly: false, method, reqPath: url.pathname }, async (run) => {
        const r = await run(`with pgrst_source as (${source}) ${outer}`);
        return finish(r, 200);
      });
    }

    if (method === 'DELETE') {
      const source = `delete from ${T} ${whereSql(cache, name, T, params)} returning ${returning}`;
      return tx({ ...ident0, readOnly: false, method, reqPath: url.pathname }, async (run) => {
        const r = await run(`with pgrst_source as (${source}) ${outer}`);
        return finish(r, 200);
      });
    }
    throw pgrst(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
  }

  // ---- PostgREST: functions
  async function rpc(req, url, name, bodyText, ident0) {
    let args = {};
    if (req.method === 'GET') {
      for (const [k, v] of url.searchParams) args[k] = v;
    } else if (bodyText) {
      try { args = JSON.parse(bodyText); } catch (e) { throw pgrst(400, 'PGRST102', 'Empty or invalid json'); }
    }
    if (args == null || typeof args !== 'object' || Array.isArray(args)) throw new Error('realdb server: rpc bodies must be objects');
    const keys = Object.keys(args).sort();
    const overloads = cache.fns.get(name) || [];
    const ins = (f) => f.args.filter((a) => ['i', 'b', 'v'].includes(a.mode));
    const candidates = overloads.filter((f) => {
      const inArgs = ins(f);
      const names = inArgs.map((a) => a.name);
      const required = inArgs.slice(0, inArgs.length - f.ndefaults).map((a) => a.name);
      return keys.every((k) => names.includes(k)) && required.every((r) => keys.includes(r));
    });
    if (!candidates.length) {
      const hint = overloads.length ? `Perhaps you meant to call the function public.${name}(${ins(overloads[0]).map((a) => a.name).sort().join(', ')})` : null;
      throw pgrst(404, 'PGRST202', `Could not find the function public.${name}${keys.length ? `(${keys.join(', ')})` : ' without parameters'} in the schema cache`,
        `Searched for the function public.${name} with parameter${keys.length === 1 ? '' : 's'} ${keys.join(', ') || '(none)'} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`, hint);
    }
    if (candidates.length > 1) throw pgrst(300, 'PGRST203', `Could not choose the best candidate function between: ${candidates.map(() => `public.${name}`).join(', ')}`);
    const f = candidates[0];
    const used = ins(f).filter((a) => keys.includes(a.name));
    const argList = used.map((a) => `${ident(a.name)} := _a.${ident(a.name)}`).join(', ');
    const from = used.length ? `from json_to_record(${lit(JSON.stringify(args))}::json) as _a(${used.map((a) => `${ident(a.name)} ${a.type}`).join(', ')})` : '';
    const call = `${ident('public')}.${ident(name)}(${argList})`;
    const composite = f.typtype === 'c' || f.rettype === 'record';
    let sql;
    let kind;
    if (f.rettype === 'void') { sql = `select ${call} ${from}`; kind = 'void'; }
    else if (f.setof) { sql = `select coalesce(json_agg(_r), '[]')::text ${from ? `${from} cross join lateral` : 'from'} ${call} _r`; kind = 'set'; }
    else if (composite) { sql = `select coalesce(json_agg(_r)->0, 'null')::text ${from ? `${from} cross join lateral` : 'from'} ${call} _r`; kind = 'single'; }
    else { sql = `select coalesce(to_json(${call})::text, 'null') ${from}`; kind = 'scalar'; }
    // GET, and functions marked STABLE or IMMUTABLE, run read only (as PostgREST does).
    const readOnly = req.method === 'GET' || f.volatile !== 'v';
    return tx({ ...ident0, readOnly, method: req.method, reqPath: url.pathname }, async (run) => {
      const r = await run(sql);
      if (kind === 'void') return { status: 204, body: undefined };
      return { status: 200, body: r.rows[0][0] };
    });
  }

  // ---- Auth (GoTrue)
  function sessionFor(email) {
    const u = users.get(email);
    // The browsers' clocks run on the household's pinned clock, so tokens are dated by it too.
    const now = Math.floor(Date.parse(hubNow()) / 1000);
    const claims = { aud: 'authenticated', exp: now + 3600, iat: now, iss: `${base}/auth/v1`, sub: u.id, email, phone: '',
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, role: 'authenticated', aal: 'aal1',
      amr: [{ method: 'otp', timestamp: now }], session_id: crypto.randomUUID(), is_anonymous: false };
    return {
      access_token: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.realdb`, token_type: 'bearer', expires_in: 3600,
      expires_at: now + 3600, refresh_token: Buffer.from(email).toString('base64url'), user: userJson(email),
    };
  }
  function userJson(email) {
    const u = users.get(email);
    return { id: u.id, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: u.created_at, phone: '', confirmed_at: u.created_at,
      last_sign_in_at: new Date().toISOString(), app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {},
      identities: [], created_at: u.created_at, updated_at: new Date().toISOString(), is_anonymous: false };
  }
  const authError = (status, error_code, msg) => new ApiError(status, { code: status, error_code, msg });

  async function auth(req, url, bodyText) {
    const p = url.pathname.slice('/auth/v1'.length);
    const body = bodyText ? JSON.parse(bodyText) : {};
    if (p === '/otp' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw authError(400, 'validation_failed', 'Unable to validate email address: invalid format');
      if (!users.has(email)) {
        if (body.create_user === false) throw authError(422, 'otp_disabled', 'Signups not allowed for otp');
        // Supabase's Before User Created hook (README step 5): only emails on the family list.
        const r = await serial(async () => {
          await db.query('begin');
          await db.query("set local role supabase_auth_admin");
          const out = await db.query(`select public.hook_family_only_signup(${lit(JSON.stringify({ user: { email } }))}::jsonb)::text`);
          await db.query('rollback');
          return out;
        });
        if (r.error) throw authError(500, 'unexpected_failure', `Error running hook URI: ${r.error.message}`);
        const verdict = JSON.parse(r.rows[0][0]);
        if (verdict && verdict.error) throw authError(verdict.error.http_code || 403, 'hook_error', verdict.error.message);
        users.set(email, { id: crypto.randomUUID(), created_at: new Date().toISOString() });
      }
      otps.set(email, OTP);
      mail.push({ to: email, code: OTP, at: hubNow() });
      return { status: 200, body: '{}' };
    }
    if (p === '/verify' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!['email', 'magiclink', 'signup'].includes(body.type) || otps.get(email) !== String(body.token || '') || !users.has(email)) {
        throw authError(403, 'otp_expired', 'Token has expired or is invalid');
      }
      otps.delete(email);
      return { status: 200, body: JSON.stringify(sessionFor(email)) };
    }
    if (p === '/token' && req.method === 'POST') {
      const email = Buffer.from(String(body.refresh_token || ''), 'base64url').toString();
      if (!users.has(email)) throw authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      return { status: 200, body: JSON.stringify(sessionFor(email)) };
    }
    if (p === '/user' && req.method === 'GET') {
      const w = who(req);
      if (!w.email || !users.has(w.email)) throw authError(403, 'bad_jwt', 'invalid claim: missing sub claim');
      return { status: 200, body: JSON.stringify(userJson(w.email)) };
    }
    if (p === '/logout' && req.method === 'POST') return { status: 204, body: undefined };
    throw authError(404, 'not_found', `realdb server: ${req.method} /auth/v1${p} isn't supported`);
  }

  // ---- static files
  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    if (/(^|\/)config\.js$/.test(rel)) {
      send(res, 200, `window.HOME_HUB_CONFIG = { supabaseUrl: ${JSON.stringify(base)}, supabaseKey: 'sb_publishable_realdb', emailSending: ${opts.emailSending ? 'true' : 'false'} };\n`,
        { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
      return;
    }
    const prefix = Object.keys(roots).filter((k) => rel.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const root = roots[prefix];
    const file = path.join(root, rel.slice(prefix.length));
    if (!file.startsWith(root + path.sep) && file !== root) { send(res, 403, 'forbidden', { 'content-type': 'text/plain' }); return; }
    fs.readFile(file, (err, data) => {
      if (err) { send(res, 404, 'not found', { 'content-type': 'text/plain' }); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  }

  // ---- test endpoints
  async function testApi(req, url, bodyText) {
    const p = url.pathname.slice('/__test'.length);
    if (p === '/sql' && req.method === 'POST') {
      const { sql } = JSON.parse(bodyText || '{}');
      const r = await serial(async () => {
        await db.query('begin');
        await db.query(`select set_config('hub.now', ${lit(hubNow())}, true)`);
        const out = await db.query(sql);
        await db.query(out.error ? 'rollback' : 'commit');
        return out;
      });
      const rows = (r.rows || []).map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name, row[i]])));
      return { status: 200, body: JSON.stringify({ rows, error: r.error || null }) };
    }
    if (p === '/migrate' && req.method === 'POST') {
      // Between two API transactions, so the migration waits for nothing; the API's own session sees
      // the change at its next transaction, as PostgREST's pooled sessions do.
      const { sql } = JSON.parse(bodyText || '{}');
      const r = await serial(async () => {
        const own = await connect({ socketDir: opts.socket, port: opts.port, database: opts.db });
        try {
          return await own.query(sql);
        } finally {
          await own.close();
        }
      });
      if (!r.error) cache = await serial(() => loadCache(db));
      return { status: 200, body: JSON.stringify({ error: r.error || null, notices: (r.notices || []).map((n) => n.message) }) };
    }
    if (p === '/clock' && req.method === 'GET') return { status: 200, body: JSON.stringify({ now: hubNow() }) };
    if (p === '/clock' && req.method === 'POST') {
      const { now } = JSON.parse(bodyText || '{}');
      clockBase = Date.parse(now);
      clockStart = Date.now();
      return { status: 200, body: JSON.stringify({ now: hubNow() }) };
    }
    if (p === '/requests') {
      const after = Number(url.searchParams.get('after') || 0);
      return { status: 200, body: JSON.stringify({ count: requests.length, requests: requests.slice(after) }) };
    }
    if (p === '/mail') return { status: 200, body: JSON.stringify(mail) };
    return { status: 404, body: '{}' };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let url;
      try { url = new URL(req.url, base || 'http://127.0.0.1'); } catch (e) { send(res, 400, { message: 'bad url' }); return; }
      if (req.method === 'OPTIONS') { send(res, 204); return; }
      const p = url.pathname;
      const api = p.startsWith('/rest/v1/') || p.startsWith('/auth/v1/') || p.startsWith('/functions/v1/');
      if (!api && !p.startsWith('/__test/')) { serveStatic(req, res, url); return; }
      const started = Date.now();
      const w = who(req);
      const entry = { n: requests.length + 1, method: req.method, path: p, query: decodeURIComponent(url.search), role: w.role, email: w.email,
        body: bodyText ? bodyText.slice(0, 2000) : null, prefer: req.headers.prefer || null, accept: req.headers.accept || null };
      if (api) requests.push(entry);
      let out;
      try {
        if (p.startsWith('/__test/')) out = await testApi(req, url, bodyText);
        else if (p.startsWith('/auth/v1/')) out = await auth(req, url, bodyText);
        else if (p.startsWith('/functions/v1/')) {
          // An Edge Function the test plugged in (opts.functions[name](Request) → Response), else 404
          // as for a function that isn't deployed.
          const fn = (opts.functions || {})[p.slice('/functions/v1/'.length)];
          if (!fn) out = { status: 404, body: JSON.stringify({ code: 'NOT_FOUND', message: 'Requested function was not found' }) };
          else {
            const r = await fn(new Request(base + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyText }));
            out = { status: r.status, body: await r.text(), headers: { 'content-type': r.headers.get('content-type') || 'application/json' } };
            if (out.status >= 400) entry.error = (() => { try { return JSON.parse(out.body); } catch (e) { return { message: out.body }; } })();
          }
        }
        else {
          const rest = p.slice('/rest/v1/'.length);
          const ident0 = { role: w.role, claims: w.claims };
          if (rest.startsWith('rpc/')) out = await rpc(req, url, rest.slice(4), bodyText, ident0);
          else out = await table(req, url, rest, bodyText, ident0);
        }
        if (out && out.error) throw out.error;
      } catch (e) {
        let status;
        let body;
        if (e instanceof ApiError) { status = e.status; body = e.body; }
        else if (e && e.code && e.message && e.severity) {
          // A Postgres error, as PostgREST reports it.
          status = pgStatus(e.code, w.role !== 'anon');
          body = { code: e.code, details: e.detail || null, hint: e.hint || null, message: e.message };
        } else {
          status = 500;
          body = { code: 'REALDB', details: String((e && e.stack) || e), hint: null, message: `realdb server: ${(e && e.message) || e}` };
          console.error(e);
        }
        out = { status, body: JSON.stringify(body) };
        entry.error = body;
      }
      entry.status = out.status;
      entry.ms = Date.now() - started;
      if (out.status >= 200 && out.status < 300 && typeof out.body === 'string' && api) entry.response = out.body.slice(0, 4000);
      send(res, out.status, out.body, out.headers || {});
    });
  });

  await new Promise((resolve) => server.listen(Number(opts.listen || 0), '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    hubNow,
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await db.close(); },
  };
}

module.exports = { start, pgStatus };

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  const roots = {};
  if (a.v1root) roots['/v1/'] = path.resolve(a.v1root);
  if (a.v1aroot) roots['/v1a/'] = path.resolve(a.v1aroot);
  start({ socket: a.socket, port: a.port, db: a.db, listen: a.listen, now: a.now, roots, emailSending: a.email === 'on' })
    .then((s) => console.log(`listening ${s.base}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
