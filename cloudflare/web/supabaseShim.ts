// SATE — a supabase-js-shaped client backed by the Cloudflare Worker.
//
// WHY A SHIM AND NOT AN EDIT: the web app touches Supabase from 19 files and 77 call sites.
// Rewriting them would mean 19 diffs against working, in-production code — and the brief was
// to add the Cloudflare version without changing anything that exists. So this reimplements
// the slice of the supabase-js surface the app actually uses, and a Vite alias (see
// vite.config.cf.ts) points `@/lib/supabase` here for the Cloudflare build only. The app's
// own src/ is untouched and the Supabase build still resolves to the real client.
//
// The surface below is not a guess — it is every method the app calls, from a grep over
// react_app_sate-ui_update/src:
//
//   .from(t).select/insert/update/delete/eq/order/single/maybeSingle
//   .auth.signUp/signInWithPassword/getUser/getSession/signOut/onAuthStateChange/
//        updateUser/resetPasswordForEmail
//   .storage.from(b).createSignedUrl/remove
//   .rpc(name, args)
//   .functions.invoke(name, { body })
//
// Anything outside that throws rather than silently returning empty — a shim that quietly
// answers `{data: null}` to an unimplemented filter would look like "no results" and, on
// this schema, "no results" is indistinguishable from a working page with an empty list.

const BASE = (import.meta as any).env?.VITE_CF_URL ?? '';

// ---------------------------------------------------------------------------
// Session storage — mirrors supabase-js's localStorage behaviour so a refresh keeps you
// signed in and the app's existing auth flow works unchanged.
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'sate-cf-auth';

interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: any;
}

type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'USER_UPDATED';
type AuthListener = (event: AuthEvent, session: Session | null) => void;

const listeners = new Set<AuthListener>();

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null, event: AuthEvent) {
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode: keep going, just don't persist */
  }
  for (const l of listeners) l(event, s);
}

/**
 * Return a valid access token, refreshing it first if it is about to expire.
 *
 * supabase-js refreshes in the background; the app never thinks about it, so neither can
 * the call sites. The 60 s margin stops a token expiring mid-request.
 */
async function accessToken(): Promise<string | null> {
  const s = loadSession();
  if (!s) return null;
  if (s.expires_at * 1000 > Date.now() + 60_000) return s.access_token;

  const res = await fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  if (!res.ok) {
    // The refresh token is spent or revoked; the session is genuinely over.
    saveSession(null, 'SIGNED_OUT');
    return null;
  }
  const fresh = (await res.json()) as Session;
  saveSession(fresh, 'TOKEN_REFRESHED');
  return fresh.access_token;
}

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await accessToken();
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

/** supabase-js resolves rather than throws; every call site destructures { data, error }. */
interface Result<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

async function toResult<T>(res: Response): Promise<Result<T>> {
  if (res.status === 204) return { data: null, error: null };
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    return { data: null, error: { message: body?.message ?? body?.error ?? `HTTP ${res.status}`, code: body?.code } };
  }
  return { data: body as T, error: null };
}

// ---------------------------------------------------------------------------
// PostgREST query builder
//
// Thenable, like supabase-js: `await supabase.from('t').select()` fires the request, and so
// does `.select().eq(...)`, because the builder itself is awaited. That is why this
// implements then() rather than exposing an explicit .execute().
// ---------------------------------------------------------------------------
class QueryBuilder<T = any> implements PromiseLike<Result<T>> {
  private method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET';
  private params = new URLSearchParams();
  private body: unknown = undefined;
  private single = false;
  private wantReturn = false;

  constructor(private table: string) {}

  select(cols = '*') {
    if (this.method === 'GET') this.params.set('select', cols);
    // .insert(...).select() means "give me the rows back" — PostgREST's Prefer header.
    else this.wantReturn = true;
    return this;
  }

  insert(rows: unknown) {
    this.method = 'POST';
    this.body = rows;
    return this;
  }

  update(patch: unknown) {
    this.method = 'PATCH';
    this.body = patch;
    return this;
  }

  delete() {
    this.method = 'DELETE';
    return this;
  }

  eq(col: string, val: unknown) {
    this.params.append(col, `eq.${val}`);
    return this;
  }

  neq(col: string, val: unknown) {
    this.params.append(col, `neq.${val}`);
    return this;
  }

  is(col: string, val: null | boolean) {
    this.params.append(col, `is.${val === null ? 'null' : val}`);
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.params.append(col, `in.(${vals.join(',')})`);
    return this;
  }

  gt(col: string, val: unknown) {
    this.params.append(col, `gt.${val}`);
    return this;
  }

  gte(col: string, val: unknown) {
    this.params.append(col, `gte.${val}`);
    return this;
  }

  lt(col: string, val: unknown) {
    this.params.append(col, `lt.${val}`);
    return this;
  }

  lte(col: string, val: unknown) {
    this.params.append(col, `lte.${val}`);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.params.append('order', `${col}.${opts?.ascending === false ? 'desc' : 'asc'}`);
    return this;
  }

  limit(n: number) {
    this.params.set('limit', String(n));
    return this;
  }

  /** Exactly one row; zero or many is an error (PGRST116). */
  single() {
    this.single = true;
    return this;
  }

  /** At most one row; zero yields data:null, not an error. */
  maybeSingle() {
    this.single = true;
    (this as any).allowEmpty = true;
    return this;
  }

  async then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((v: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    try {
      const headers = await authHeaders();
      if (this.single) headers['Accept'] = 'application/vnd.pgrst.object+json';
      if (this.method !== 'GET' && this.wantReturn) headers['Prefer'] = 'return=representation';

      const qs = this.params.toString();
      const res = await fetch(`${BASE}/rest/v1/${this.table}${qs ? `?${qs}` : ''}`, {
        method: this.method,
        headers,
        body: this.body !== undefined ? JSON.stringify(this.body) : undefined,
      });

      let out = await toResult<T>(res);

      // maybeSingle(): the worker answers 406 for "not exactly one row", which supabase-js
      // reports as data:null / error:null when zero rows were acceptable.
      if ((this as any).allowEmpty && out.error?.code === 'PGRST116') out = { data: null, error: null };

      return onfulfilled ? onfulfilled(out) : (out as unknown as R1);
    } catch (e) {
      const out = { data: null, error: { message: (e as Error).message } } as Result<T>;
      if (onrejected) return onrejected(e);
      return onfulfilled ? onfulfilled(out) : (out as unknown as R1);
    }
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const auth = {
  async signUp({ email, password, options }: { email: string; password: string; options?: { data?: any } }) {
    const res = await fetch(`${BASE}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, data: options?.data }),
    });
    const out = await toResult<Session>(res);
    if (out.data) saveSession(out.data, 'SIGNED_IN');
    return { data: { user: out.data?.user ?? null, session: out.data ?? null }, error: out.error };
  },

  async signInWithPassword({ email, password }: { email: string; password: string }) {
    const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const out = await toResult<Session>(res);
    if (out.data) saveSession(out.data, 'SIGNED_IN');
    return { data: { user: out.data?.user ?? null, session: out.data ?? null }, error: out.error };
  },

  async getUser(token?: string) {
    const t = token ?? (await accessToken());
    if (!t) return { data: { user: null }, error: { message: 'not authenticated' } };
    const res = await fetch(`${BASE}/auth/v1/user`, { headers: { Authorization: `Bearer ${t}` } });
    const out = await toResult<any>(res);
    return { data: { user: out.data }, error: out.error };
  },

  async getSession() {
    // Refresh first so callers never see an expired token — supabase-js does the same.
    await accessToken();
    return { data: { session: loadSession() }, error: null };
  },

  async signOut() {
    const token = await accessToken();
    if (token) {
      await fetch(`${BASE}/auth/v1/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(
        () => {},
      );
    }
    saveSession(null, 'SIGNED_OUT');
    return { error: null };
  },

  async updateUser(attrs: { password?: string; email?: string; data?: any }) {
    const res = await fetch(`${BASE}/auth/v1/user`, {
      method: 'PUT',
      headers: await authHeaders(),
      body: JSON.stringify(attrs),
    });
    const out = await toResult<any>(res);
    if (out.data) {
      const s = loadSession();
      // A password change revokes every refresh token server-side, so the cached session is
      // already dead — forcing a fresh sign-in is the honest outcome, not a bug.
      if (s && !attrs.password) saveSession({ ...s, user: out.data }, 'USER_UPDATED');
    }
    return { data: { user: out.data }, error: out.error };
  },

  async resetPasswordForEmail(email: string, _opts?: { redirectTo?: string }) {
    const res = await fetch(`${BASE}/auth/v1/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return toResult<any>(res);
  },

  onAuthStateChange(cb: AuthListener) {
    listeners.add(cb);
    // supabase-js fires once on subscribe with the current state; AuthProvider relies on
    // that to decide between the login page and the app on first paint.
    const s = loadSession();
    queueMicrotask(() => cb(s ? 'SIGNED_IN' : 'SIGNED_OUT', s));
    return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
  },
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
function storageFrom(bucket: string) {
  return {
    async createSignedUrl(path: string, expiresIn: number) {
      const res = await fetch(`${BASE}/storage/v1/object/sign/${bucket}/${path}`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ expiresIn }),
      });
      const out = await toResult<{ signedURL: string }>(res);
      if (out.error) return { data: null, error: out.error };
      // supabase-js hands back an absolute URL; the worker returns a path.
      return { data: { signedUrl: `${BASE}${out.data!.signedURL}`, signedURL: out.data!.signedURL }, error: null };
    },

    async remove(paths: string[]) {
      for (const p of paths) {
        const res = await fetch(`${BASE}/storage/v1/object/${bucket}/${p}`, {
          method: 'DELETE',
          headers: await authHeaders(),
        });
        const out = await toResult<any>(res);
        // Stop at the first failure and report it, rather than pressing on and claiming
        // success for a file that is still there.
        if (out.error) return { data: null, error: out.error };
      }
      return { data: paths.map((p) => ({ name: p })), error: null };
    },

    getPublicUrl(path: string) {
      return { data: { publicUrl: `${BASE}/storage/v1/object/public/${bucket}/${path}` } };
    },
  };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------
export const supabase = {
  from: <T = any>(table: string) => new QueryBuilder<T>(table),

  auth,

  storage: { from: storageFrom },

  async rpc<T = any>(name: string, args?: Record<string, unknown>): Promise<Result<T>> {
    const res = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(args ?? {}),
    });
    return toResult<T>(res);
  },

  functions: {
    async invoke<T = any>(name: string, opts?: { body?: unknown }): Promise<Result<T>> {
      const res = await fetch(`${BASE}/functions/v1/${name}`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(opts?.body ?? {}),
      });
      return toResult<T>(res);
    },
  },
};

export default supabase;
