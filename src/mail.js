'use strict';
// Outgoing email: verification codes and links, passcode resets. One transport, chosen by MAIL_TRANSPORT:
//   smtp      any provider over SMTP (nodemailer): SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for 465), SMTP_USER, SMTP_PASS
//   resend    Resend's HTTP API: RESEND_API_KEY
//   postmark  Postmark's HTTP API: POSTMARK_TOKEN (and POSTMARK_STREAM, default "outbound")
//   log       nothing is sent: the message is written to the server's console (development and tests)
// Unset, the first that is configured is used (SMTP_HOST, then RESEND_API_KEY, then POSTMARK_TOKEN), else `log`.
// MAIL_FROM is the sender ("FAILTECH <noreply@example.com>"). Sending is awaited, with a timeout, so a sign-up learns
// whether its email went out.
const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const TIMEOUT_MS = 15000;

function transportName() {
  const t = env('MAIL_TRANSPORT').toLowerCase();
  if (t) return t;
  if (env('SMTP_HOST')) return 'smtp';
  if (env('RESEND_API_KEY')) return 'resend';
  if (env('POSTMARK_TOKEN')) return 'postmark';
  return 'log';
}
const from = () => env('MAIL_FROM', 'FAILTECH <noreply@localhost>');

let smtp = null;
function smtpTransport() {
  if (smtp) return smtp;
  const nodemailer = require('nodemailer');
  const port = Number(env('SMTP_PORT', '587'));
  smtp = nodemailer.createTransport({
    host: env('SMTP_HOST'), port, secure: env('SMTP_SECURE', port === 465 ? 'true' : 'false') === 'true',
    auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined,
    connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return smtp;
}

async function post(url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  } finally { clearTimeout(timer); }
}

// The last few messages the `log` transport "sent", for tests and for reading a code during development.
const outbox = [];

// msg: { to, subject, text, html }
async function send(msg) {
  const t = transportName();
  if (t === 'smtp') { await smtpTransport().sendMail({ from: from(), to: msg.to, subject: msg.subject, text: msg.text, html: msg.html }); return t; }
  if (t === 'resend') { await post('https://api.resend.com/emails', { authorization: `Bearer ${env('RESEND_API_KEY')}` }, { from: from(), to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }); return t; }
  if (t === 'postmark') {
    await post('https://api.postmarkapp.com/email', { 'X-Postmark-Server-Token': env('POSTMARK_TOKEN') },
      { From: from(), To: msg.to, Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html, MessageStream: env('POSTMARK_STREAM', 'outbound') });
    return t;
  }
  outbox.push({ ...msg, at: Date.now() });
  if (outbox.length > 50) outbox.shift();
  if (process.env.MAIL_LOG !== 'quiet') console.log(`[mail:log] to ${msg.to}: ${msg.subject}\n${msg.text}`);
  return 'log';
}

// What the admin panel shows (never a secret).
const status = () => ({ transport: transportName(), from: from(), smtpHost: env('SMTP_HOST') || null, publicUrl: env('PUBLIC_URL') || null });

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A plain message with a code and, when PUBLIC_URL is set, a link that does the same.
function compose({ brand, to, subject, intro, code, link, linkLabel, outro }) {
  const text = [intro, '', `Code: ${code}`, ...(link ? ['', `${linkLabel}: ${link}`] : []), '', outro].join('\n');
  const html = `<div style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#222;max-width:520px">
<p style="color:#b36b05;font-weight:700;letter-spacing:.2em">${escHtml(brand)}</p>
<p>${escHtml(intro)}</p>
<p style="font-size:28px;letter-spacing:.3em;font-weight:700">${escHtml(code)}</p>
${link ? `<p><a href="${escHtml(link)}" style="display:inline-block;background:#ff9f1c;color:#1a1000;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:700">${escHtml(linkLabel)}</a></p>` : ''}
<p style="color:#777;font-size:12px">${escHtml(outro)}</p></div>`;
  return { to, subject, text, html };
}

module.exports = { send, status, transportName, compose, outbox };
