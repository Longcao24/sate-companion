// HTTP Basic Auth gate for the private internal docs (Cloudflare Pages Function).
// Runs on every request before the static site is served. Credentials come from
// Pages environment secrets — SITE_USER (default "sate") and SITE_PASSWORD — so the
// password is never committed to git. Fails CLOSED if no password is configured.
export const onRequest = async (context) => {
  const { request, env, next } = context;
  const expectedUser = env.SITE_USER || 'sate';
  const expectedPass = env.SITE_PASSWORD;

  if (!expectedPass) {
    return new Response('Site not configured (missing SITE_PASSWORD).', { status: 503 });
  }

  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6));
      const i = decoded.indexOf(':');
      const user = decoded.slice(0, i);
      const pass = decoded.slice(i + 1);
      // Constant-ish comparison; credentials are short and this is not a high-value target.
      if (user === expectedUser && pass === expectedPass) {
        return next();
      }
    } catch (_e) {
      // fall through to 401
    }
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="SATE internal docs", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
};
