// Pluggable email sender for Luna (currently only used for password resets).
//
// Default implementation: Resend over HTTPS, no SDK dependency (Node's global
// fetch posts to api.resend.com). The API key comes only from the
// RESEND_API_KEY environment variable and is never logged, stored, or
// committed. The sender address comes from EMAIL_FROM; it must be a sender
// verified in Resend (for testing, Resend's onboarding@resend.dev only
// delivers to the Resend account owner's own address).
//
// If RESEND_API_KEY is missing, sendEmail() resolves { ok: false, error }
// instead of throwing, so callers can show a clear message while the rest of
// the app keeps working for cookie users and signed-in users.
//
// The fetch implementation is injectable (last argument) so tests can pass a
// fake without touching the network.
const RESEND_URL = 'https://api.resend.com/emails';

function isEmailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

async function sendEmail({ to, subject, text, html }, fetchImpl = globalThis.fetch) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return { ok: false, error: 'Email sending is not configured (RESEND_API_KEY is missing).' };
  }
  const from = process.env.EMAIL_FROM || 'Luna <onboarding@resend.dev>';
  let res;
  try {
    res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html: html || text }),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach the email service: ${err.message}` };
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || body.error || JSON.stringify(body);
    } catch (e) { /* non-JSON error body: keep the status only */ }
    return { ok: false, error: `Email service rejected the message${detail ? ': ' + detail : ''} (status ${res.status}).` };
  }
  return { ok: true };
}

module.exports = { isEmailConfigured, sendEmail };
