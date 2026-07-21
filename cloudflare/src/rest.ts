// SATE — PostgREST-compatible REST surface over D1.
//
// Speaks enough of PostgREST's protocol that the client shim stays thin and the existing
// call sites keep their supabase-js shape. Scope is deliberately the subset the app
// actually uses (verified by grep over react_app_sate-ui_update/src):
//
//   select, insert, update, delete, eq, order, single, maybeSingle, rpc
//
// Anything outside that is refused rather than half-implemented — a filter that silently
// does nothing would widen a result set, and on this schema a widened result set is
// somebody else's patients.
//
// ⚠️ INJECTION: identifiers (table, column) cannot be bound as parameters, so they are
// interpolated into SQL. Every one of them is therefore validated against the live schema
// via PRAGMA table_info before it reaches a query string. VALUES are always bound with ?.
// Never relax either rule.
//
// ⚠️ Every request passes through policy.check() and the returned filter is AND-ed into the
// WHERE clause. D1 has no RLS; skipping that step exposes the whole table.

import { check, checkRow, type Cmd, type Ctx, type Filter } from './policy';
import { decodeRow, encodeRow, encodeValue } from './columns';

export interface RestEnv {
  DB: D1Database;
}

// PostgREST filter operators. Each maps to a fixed SQL operator — the operator itself is
// never taken from user input, only selected from this table.
const OPERATORS: Record<string, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** Column names allowed by the live schema, cached per table for the isolate's lifetime. */
const columnCache = new Map<string, Set<string>>();

async function columnsOf(db: D1Database, table: string): Promise<Set<string>> {
  const cached = columnCache.get(table);
  if (cached) return cached;

  // The table name is interpolated here, so it must already be known-safe. It is: callers
  // only reach this after policy.check() matched the name against the POLICIES map, whose
  // keys are literals in our source. Belt and braces, reject anything unusual anyway.
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new HttpError(400, `bad table name`);

  const res = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const set = new Set((res.results ?? []).map((r) => r.name));
  if (set.size === 0) throw new HttpError(404, `unknown table "${table}"`);
  columnCache.set(table, set);
  return set;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function assertColumn(cols: Set<string>, table: string, col: string): void {
  if (!cols.has(col)) throw new HttpError(400, `unknown column "${col}" on "${table}"`);
}

interface ParsedQuery {
  select: string;
  wheres: Filter[];
  order: string;
  limit: string;
}

/**
 * Translate PostgREST query params into SQL fragments.
 * Reserved params (select/order/limit/offset) are handled by name; every other param is a
 * column filter of the form `col=op.value`.
 */
async function parseQuery(url: URL, db: D1Database, table: string): Promise<ParsedQuery> {
  const cols = await columnsOf(db, table);

  // ---- select ----
  const selectParam = url.searchParams.get('select');
  let select = '*';
  if (selectParam && selectParam !== '*') {
    const names = selectParam.split(',').map((s) => s.trim()).filter(Boolean);
    // PostgREST embeds related resources with `patients(*)`. Nothing in this app's call
    // sites needs it, and faking it with a join would quietly bypass the related table's
    // own policy — so refuse loudly instead.
    for (const n of names) {
      if (n.includes('(')) throw new HttpError(400, `embedded selects are not supported (got "${n}")`);
      assertColumn(cols, table, n);
    }
    select = names.join(', ');
  }

  // ---- filters ----
  const wheres: Filter[] = [];
  const reserved = new Set(['select', 'order', 'limit', 'offset']);
  for (const [key, raw] of url.searchParams.entries()) {
    if (reserved.has(key)) continue;
    assertColumn(cols, table, key);

    const dot = raw.indexOf('.');
    if (dot < 0) throw new HttpError(400, `filter on "${key}" must look like op.value`);
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);

    if (op === 'is') {
      // PostgREST only allows is.null / is.true / is.false.
      if (value === 'null') wheres.push({ sql: `${key} IS NULL`, params: [] });
      else if (value === 'true') wheres.push({ sql: `${key} = 1`, params: [] });
      else if (value === 'false') wheres.push({ sql: `${key} = 0`, params: [] });
      else throw new HttpError(400, `is.${value} is not supported`);
      continue;
    }

    if (op === 'in') {
      // Format: in.(a,b,c)
      const inner = value.replace(/^\(/, '').replace(/\)$/, '');
      const items = inner.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter((s) => s !== '');
      if (items.length === 0) {
        // `IN ()` is a syntax error in SQLite, and an empty set matches nothing.
        wheres.push({ sql: `0 = 1`, params: [] });
      } else {
        wheres.push({
          sql: `${key} IN (${items.map(() => '?').join(', ')})`,
          params: items.map((i) => encodeValue(table, key, i)),
        });
      }
      continue;
    }

    const sqlOp = OPERATORS[op];
    if (!sqlOp) throw new HttpError(400, `unsupported operator "${op}"`);
    wheres.push({ sql: `${key} ${sqlOp} ?`, params: [encodeValue(table, key, decodeScalar(value))] });
  }

  // ---- order ----
  let order = '';
  const orderParam = url.searchParams.get('order');
  if (orderParam) {
    const clauses: string[] = [];
    for (const part of orderParam.split(',')) {
      const [col, ...mods] = part.trim().split('.');
      assertColumn(cols, table, col);
      // Direction and null placement come from a fixed vocabulary, never from raw input.
      const desc = mods.includes('desc');
      const nulls = mods.includes('nullsfirst') ? ' NULLS FIRST' : mods.includes('nullslast') ? ' NULLS LAST' : '';
      clauses.push(`${col} ${desc ? 'DESC' : 'ASC'}${nulls}`);
    }
    order = ` ORDER BY ${clauses.join(', ')}`;
  }

  // ---- limit ----
  let limit = '';
  const limitParam = url.searchParams.get('limit');
  if (limitParam) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'limit must be a non-negative integer');
    limit = ` LIMIT ${n}`;
    const offsetParam = url.searchParams.get('offset');
    if (offsetParam) {
      const o = Number(offsetParam);
      if (!Number.isInteger(o) || o < 0) throw new HttpError(400, 'offset must be a non-negative integer');
      limit += ` OFFSET ${o}`;
    }
  }

  return { select, wheres, order, limit };
}

/** PostgREST sends everything as a string; recover the few literals that matter. */
function decodeScalar(v: string): unknown {
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function whereClause(filters: Filter[]): Filter {
  const live = filters.filter((f) => f.sql);
  if (live.length === 0) return { sql: '', params: [] };
  return {
    sql: ` WHERE ${live.map((f) => `(${f.sql})`).join(' AND ')}`,
    params: live.flatMap((f) => f.params),
  };
}

/** True when the caller asked for a single object (supabase-js .single()/.maybeSingle()). */
const wantsObject = (req: Request) => (req.headers.get('Accept') ?? '').includes('vnd.pgrst.object+json');

/** True when the caller wants the affected rows back (supabase-js .select() after a write). */
const wantsReturn = (req: Request) => (req.headers.get('Prefer') ?? '').includes('return=representation');

export async function handleRest(
  req: Request,
  url: URL,
  table: string,
  ctx: Ctx,
  env: RestEnv,
): Promise<Response> {
  const method = req.method.toUpperCase();
  const cmd: Cmd =
    method === 'GET' ? 'select' : method === 'POST' ? 'insert' : method === 'PATCH' ? 'update' : method === 'DELETE' ? 'delete' : ('' as Cmd);
  if (!cmd) throw new HttpError(405, `method ${method} not allowed`);

  // The gate. Everything below assumes this ran and that `decision.filter` is applied.
  const decision = check(table, cmd, ctx);
  if (!decision.allowed) {
    // The reason names internal structure; log it, don't ship it.
    console.warn(`[policy] denied ${cmd} on ${table} for uid=${ctx.uid ?? 'anon'}: ${decision.reason}`);
    throw new HttpError(ctx.uid ? 403 : 401, ctx.uid ? 'not permitted' : 'not authenticated');
  }

  switch (cmd) {
    case 'select':
      return selectRows(req, url, table, env, decision.filter);
    case 'insert':
      return insertRows(req, table, ctx, env);
    case 'update':
      return updateRows(req, url, table, ctx, env, decision.filter);
    case 'delete':
      return deleteRows(req, url, table, env, decision.filter);
  }
}

async function selectRows(req: Request, url: URL, table: string, env: RestEnv, policyFilter?: Filter): Promise<Response> {
  const q = await parseQuery(url, env.DB, table);
  const where = whereClause([...(policyFilter ? [policyFilter] : []), ...q.wheres]);
  const sql = `SELECT ${q.select} FROM ${table}${where.sql}${q.order}${q.limit}`;

  const res = await env.DB.prepare(sql).bind(...where.params).all<Record<string, unknown>>();
  const rows = (res.results ?? []).map((r) => decodeRow(table, r));
  return respond(req, rows);
}

async function insertRows(req: Request, table: string, ctx: Ctx, env: RestEnv): Promise<Response> {
  const body = await req.json<unknown>();
  const input = Array.isArray(body) ? body : [body];
  if (input.length === 0) return respond(req, []);

  const cols = await columnsOf(env.DB, table);
  const out: Record<string, unknown>[] = [];

  for (const raw of input) {
    const row = { ...(raw as Record<string, unknown>) };

    // Postgres filled these with uuid_generate_v4()/gen_random_uuid(); SQLite has no such
    // function, so the id is minted here when the caller did not supply one. Tables whose
    // id is a natural key (device serial, invite code, session id) always pass one in.
    if (cols.has('id') && (row.id === undefined || row.id === null)) row.id = crypto.randomUUID();

    const err = await checkRow(table, 'insert', ctx, row, env.DB);
    if (err) {
      console.warn(`[policy] insert refused on ${table} for uid=${ctx.uid ?? 'anon'}: ${err}`);
      throw new HttpError(403, 'not permitted');
    }

    for (const k of Object.keys(row)) assertColumn(cols, table, k);
    const encoded = encodeRow(table, row);
    const keys = Object.keys(encoded);
    if (keys.length === 0) throw new HttpError(400, 'insert requires at least one column');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`;
    const res = await env.DB.prepare(sql).bind(...keys.map((k) => encoded[k])).first<Record<string, unknown>>();
    if (res) out.push(decodeRow(table, res));
  }

  return respond(req, out, 201);
}

async function updateRows(req: Request, url: URL, table: string, ctx: Ctx, env: RestEnv, policyFilter?: Filter): Promise<Response> {
  const patch = (await req.json<Record<string, unknown>>()) ?? {};
  const cols = await columnsOf(env.DB, table);
  for (const k of Object.keys(patch)) assertColumn(cols, table, k);

  const err = await checkRow(table, 'update', ctx, patch, env.DB);
  if (err) {
    console.warn(`[policy] update refused on ${table} for uid=${ctx.uid ?? 'anon'}: ${err}`);
    throw new HttpError(403, 'not permitted');
  }

  const q = await parseQuery(url, env.DB, table);
  const encoded = encodeRow(table, patch);
  const setKeys = Object.keys(encoded);
  if (setKeys.length === 0) throw new HttpError(400, 'update requires at least one column');

  const where = whereClause([...(policyFilter ? [policyFilter] : []), ...q.wheres]);
  // An UPDATE with no WHERE rewrites the table. The policy filter normally prevents that,
  // but service-role callers have no filter — so require an explicit one from them too.
  if (!where.sql) throw new HttpError(400, 'update requires a filter');

  const sql = `UPDATE ${table} SET ${setKeys.map((k) => `${k} = ?`).join(', ')}${where.sql} RETURNING *`;
  const res = await env.DB.prepare(sql).bind(...setKeys.map((k) => encoded[k]), ...where.params).all<Record<string, unknown>>();
  return respond(req, (res.results ?? []).map((r) => decodeRow(table, r)));
}

async function deleteRows(req: Request, url: URL, table: string, env: RestEnv, policyFilter?: Filter): Promise<Response> {
  const q = await parseQuery(url, env.DB, table);
  const where = whereClause([...(policyFilter ? [policyFilter] : []), ...q.wheres]);
  // Same reasoning as UPDATE: never let an unfiltered DELETE through.
  if (!where.sql) throw new HttpError(400, 'delete requires a filter');

  const sql = `DELETE FROM ${table}${where.sql} RETURNING *`;
  const res = await env.DB.prepare(sql).bind(...where.params).all<Record<string, unknown>>();
  return respond(req, (res.results ?? []).map((r) => decodeRow(table, r)));
}

/** Shape the response the way supabase-js expects, honouring Accept/Prefer. */
function respond(req: Request, rows: Record<string, unknown>[], status = 200): Response {
  const headers = { 'Content-Type': 'application/json' };

  if (wantsObject(req)) {
    // supabase-js .single() demands exactly one row and treats anything else as an error;
    // .maybeSingle() tolerates zero. PostgREST signals both with 406, which the shim maps back.
    if (rows.length === 1) return new Response(JSON.stringify(rows[0]), { status, headers });
    return new Response(
      JSON.stringify({
        code: 'PGRST116',
        message: `JSON object requested, multiple (or no) rows returned`,
        details: `Results contain ${rows.length} rows`,
      }),
      { status: 406, headers },
    );
  }

  // A write without Prefer: return=representation gets 204, matching PostgREST.
  if (req.method !== 'GET' && !wantsReturn(req)) return new Response(null, { status: 204 });

  return new Response(JSON.stringify(rows), { status, headers });
}
