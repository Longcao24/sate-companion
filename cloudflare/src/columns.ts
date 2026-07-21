// SATE — column type metadata.
//
// SQLite has no jsonb and no boolean, so schema.sql stores them as TEXT and INTEGER 0/1.
// PRAGMA table_info can tell us a column is TEXT but not that the TEXT is JSON, so the
// mapping has to be declared. Without it the client sees `"{\"a\":1}"` where Postgres gave
// it `{a:1}`, and `1` where it gave `true` — every `if (row.is_active)` still passes, but
// `row.is_active === true` silently stops matching, and JSON.parse creeps into call sites.
//
// Keep this in step with schema.sql. A column missing from JSON_COLUMNS round-trips as a
// string, which is a data-shape bug, not a crash — so it will not announce itself.

/** Columns stored as JSON text. Parsed on read, stringified on write. */
export const JSON_COLUMNS: Record<string, readonly string[]> = {
  users: ['user_metadata'],
  recordings: ['transcript', 'error_counts', 'analysis', 'flags', 'flag_notes'],
  invite_codes: ['metadata'],
  sate_device_commands: ['patient'],
  sate_device_sessions: ['flags'],
};

/** Columns stored as INTEGER 0/1. Converted to/from JS booleans at the boundary. */
export const BOOL_COLUMNS: Record<string, readonly string[]> = {
  users: [],
  refresh_tokens: ['revoked'],
  patients: ['is_active'],
  recordings: ['segments_edited', 'needs_review'],
  invite_codes: ['is_active'],
  sate_devices: ['online'],
  sate_device_commands: ['consumed'],
  sate_device_sessions: ['processed', 'no_text'],
  sate_claim_tokens: ['used'],
};

const isJson = (table: string, col: string) => JSON_COLUMNS[table]?.includes(col) ?? false;
const isBool = (table: string, col: string) => BOOL_COLUMNS[table]?.includes(col) ?? false;

/** DB row -> client row: parse JSON columns, turn 0/1 into booleans. */
export function decodeRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) {
      out[k] = null;
    } else if (isJson(table, k)) {
      // A malformed value here means something wrote non-JSON into a JSON column. Surface
      // the raw text rather than throwing: losing a whole recording row to one bad
      // analysis blob would be worse than handing back a string the caller can inspect.
      try {
        out[k] = JSON.parse(String(v));
      } catch {
        out[k] = v;
      }
    } else if (isBool(table, k)) {
      out[k] = v === 1 || v === '1' || v === true;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Client value -> DB value for one column. */
export function encodeValue(table: string, col: string, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (isJson(table, col)) return typeof v === 'string' ? v : JSON.stringify(v);
  if (isBool(table, col)) return v === true || v === 1 || v === '1' ? 1 : 0;
  // Dates arrive from the client as Date or ISO string; the schema stores ISO-8601 text.
  if (v instanceof Date) return v.toISOString();
  return v;
}

export function encodeRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = encodeValue(table, k, v);
  return out;
}
