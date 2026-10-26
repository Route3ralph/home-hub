// A minimal PostgreSQL client for the real-database harness: no npm dependencies.
// Speaks the v3 wire protocol over the throwaway cluster's Unix socket (trust auth, simple query
// protocol only), returns every value as text (or null), and reports errors with all their fields
// (code, message, detail, hint, …), which is what the PostgREST stand-in in server.js needs.
//   const db = await connect({ socketDir, port, database: 'realdb' });
//   const r = await db.query("select 1 as one");   // { fields: [{ name, type }], rows: [['1']], command: 'SELECT 1' }
//   r.error                                        // set instead when the server answered with an error
//   await db.close();
// Queries on one connection run one at a time, in the order they were sent.
const net = require('net');
const path = require('path');

const ERROR_FIELDS = { S: 'severity', V: 'severityNonLocalized', C: 'code', M: 'message', D: 'detail', H: 'hint', P: 'position',
  p: 'internalPosition', q: 'internalQuery', W: 'where', s: 'schema', t: 'table', c: 'column', d: 'dataType', n: 'constraint',
  F: 'file', L: 'line', R: 'routine' };

function connect({ socketDir, port, database, user = 'postgres', params = {} }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: path.join(socketDir, `.s.PGSQL.${port}`) });
    let buf = Buffer.alloc(0);
    let ready = false;
    const queue = [];        // { sql, resolve }
    let current = null;      // the query being answered: { resolve, result }

    const startup = () => {
      const kv = Object.assign({ user, database, client_encoding: 'UTF8', TimeZone: 'UTC', DateStyle: 'ISO, MDY' }, params);
      const body = Buffer.concat([...Object.entries(kv).map(([k, v]) => Buffer.from(`${k}\0${v}\0`)), Buffer.from('\0')]);
      const head = Buffer.alloc(8);
      head.writeInt32BE(8 + body.length, 0);
      head.writeInt32BE(196608, 4);   // protocol 3.0
      sock.write(Buffer.concat([head, body]));
    };

    const next = () => {
      if (!ready || current || !queue.length) return;
      const q = queue.shift();
      current = { resolve: q.resolve, result: { fields: [], rows: [], command: null, error: null, notices: [] } };
      const text = Buffer.from(q.sql + '\0');
      const head = Buffer.alloc(5);
      head.write('Q', 0);
      head.writeInt32BE(4 + text.length, 1);
      sock.write(Buffer.concat([head, text]));
    };

    const parseFields = (b) => {
      const out = {};
      let i = 0;
      while (i < b.length && b[i] !== 0) {
        const type = String.fromCharCode(b[i]);
        const end = b.indexOf(0, i + 1);
        out[ERROR_FIELDS[type] || type] = b.toString('utf8', i + 1, end);
        i = end + 1;
      }
      return out;
    };

    const onMessage = (type, b) => {
      switch (type) {
        case 'R': {
          const code = b.readInt32BE(0);
          if (code !== 0) { sock.destroy(); reject(new Error(`pg: unsupported auth method ${code} (the harness expects trust auth)`)); }
          break;
        }
        case 'Z':
          if (!ready) { ready = true; resolve(api); }
          if (current) { const c = current; current = null; c.resolve(c.result); }
          next();
          break;
        case 'T': {
          const n = b.readInt16BE(0);
          let i = 2;
          const fields = [];
          for (let k = 0; k < n; k++) {
            const end = b.indexOf(0, i);
            const name = b.toString('utf8', i, end);
            i = end + 1;
            const type = b.readInt32BE(i + 6);
            i += 18;
            fields.push({ name, type });
          }
          if (current) { current.result.fields = fields; current.result.rows = []; }
          break;
        }
        case 'D': {
          const n = b.readInt16BE(0);
          let i = 2;
          const row = [];
          for (let k = 0; k < n; k++) {
            const len = b.readInt32BE(i);
            i += 4;
            if (len < 0) row.push(null);
            else { row.push(b.toString('utf8', i, i + len)); i += len; }
          }
          if (current) current.result.rows.push(row);
          break;
        }
        case 'C':
          if (current) current.result.command = b.toString('utf8', 0, b.length - 1);
          break;
        case 'E': {
          const err = parseFields(b);
          if (current) current.result.error = err;
          else if (!ready) { sock.destroy(); reject(Object.assign(new Error(err.message), err)); }
          break;
        }
        case 'N':
          if (current) current.result.notices.push(parseFields(b));
          break;
        default: // S (parameter status), K (backend key), I (empty query): nothing to do
      }
    };

    sock.on('connect', startup);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 5) {
        const len = buf.readInt32BE(1);
        if (buf.length < 1 + len) break;
        const type = String.fromCharCode(buf[0]);
        const body = buf.subarray(5, 1 + len);
        buf = buf.subarray(1 + len);
        onMessage(type, body);
      }
    });
    sock.on('error', (e) => { if (!ready) reject(e); else if (current) { const c = current; current = null; c.resolve({ fields: [], rows: [], error: { code: '08006', message: e.message } }); } });

    const api = {
      query: (sql) => new Promise((res) => { queue.push({ sql, resolve: res }); next(); }),
      close: () => new Promise((res) => {
        const t = Buffer.alloc(5);
        t.write('X', 0);
        t.writeInt32BE(4, 1);
        sock.end(t, () => res());
      }),
    };
  });
}

// A SQL string literal (standard_conforming_strings is on).
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
// A quoted identifier.
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

module.exports = { connect, lit, ident };
