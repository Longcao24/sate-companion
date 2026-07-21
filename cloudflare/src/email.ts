// SATE — transactional email via Cloudflare Email Service.
//
// Closes the one gap Supabase gave away for free: GoTrue mailed password-reset links, and
// nothing on Cloudflare did until Email Sending shipped. Without this, `/auth/v1/recover`
// could only log the link to the console — i.e. password reset did not work for a real user.
//
// Uses the `send_email` Worker binding rather than the REST API: no API token to store, no
// token to leak. The binding's field names differ from the REST API's (`from.email` here vs
// `from.address` there, `replyTo` vs `reply_to`) — this is the Workers shape.
//
// ⚠️ The `from` domain MUST be onboarded to Email Service first (Dashboard → Compute →
// Email Service → Email Sending → Onboard Domain). There is no wrangler command for it. An
// un-onboarded sender fails at send() time, not at deploy time, so a green deploy proves
// nothing about whether mail actually leaves.
//
// Email Sending is in public beta (Apr 2026).

export interface EmailEnv {
  /** Optional: absent when the binding is not configured, so callers must degrade, not crash. */
  EMAIL?: { send(msg: EmailMessage): Promise<{ messageId: string }> };
  EMAIL_FROM: string;
  EMAIL_FROM_NAME: string;
  SITE_URL: string;
}

interface EmailMessage {
  to: string;
  from: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
}

/**
 * Send the password-reset link.
 *
 * Returns whether the mail was handed off. The caller MUST NOT surface that to the client:
 * `/auth/v1/recover` always answers 200 regardless, or it becomes an oracle for which email
 * addresses have accounts.
 */
export async function sendPasswordReset(env: EmailEnv, to: string, token: string): Promise<boolean> {
  const link = `${env.SITE_URL}/reset-password?token=${encodeURIComponent(token)}`;

  if (!env.EMAIL) {
    // No binding configured (e.g. the domain was never onboarded). Fall back to the old
    // behaviour rather than throwing — but say plainly that no mail was sent, because a
    // silent no-op here looks identical to a delivered email.
    console.warn(`[email] EMAIL binding not configured; no mail sent. Reset link for ${to}: ${link}`);
    return false;
  }

  try {
    await env.EMAIL.send({
      to,
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME },
      subject: 'Reset your SATE password',
      // Both html AND text: some clients only render text, and an HTML-only message scores
      // worse with spam filters.
      html: resetHtml(link),
      text: resetText(link),
    });
    return true;
  } catch (e) {
    // Never let a mail failure change what the caller returns — see the doc comment.
    console.error(`[email] password reset send failed for ${to}: ${(e as Error).message}`);
    return false;
  }
}

const RESET_TTL_TEXT = '1 hour';

function resetText(link: string): string {
  return [
    'Reset your SATE password',
    '',
    'Open this link to choose a new password:',
    link,
    '',
    `The link expires in ${RESET_TTL_TEXT} and can only be used once.`,
    '',
    "If you didn't ask to reset your password, you can ignore this email — nothing has changed.",
  ].join('\n');
}

function resetHtml(link: string): string {
  // Inline styles and a table-free layout: email clients strip <style> blocks and support
  // for modern CSS is not something to rely on here.
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;color:#111;">Reset your SATE password</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#444;">
        Open the link below to choose a new password.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:15px;">
          Choose a new password
        </a>
      </p>
      <p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:#666;">
        The link expires in ${RESET_TTL_TEXT} and can only be used once. If the button does not work,
        copy this into your browser:<br>
        <span style="word-break:break-all;color:#444;">${link}</span>
      </p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#666;">
        If you didn't ask to reset your password, you can ignore this email — nothing has changed.
      </p>
    </div>
  </body>
</html>`;
}
