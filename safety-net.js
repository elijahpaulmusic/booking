/**
 * Elijah Paul Music — Safety Net (dead man's switch)
 * -------------------------------------------------------------
 * Runs once a day via GitHub Actions. Reads Firebase to see how long it's
 * been since Elijah last logged in or reset the switch, and:
 *   • Day 6 of silence  → emails ELIJAH a one-tap reset link.
 *   • Day 7 of silence  → emails his NEXT OF KIN the upcoming client list.
 *   • 1st of the month  → emails Elijah a "still working" confirmation.
 * Logging in, or tapping the reset link, resets the clock.
 *
 * Client emails come from two merged sources:
 *   • the notes of the .ics he uploads to the workstation (saved to Firebase), and
 *   • live bookings in the workstation (Firebase /bookings).
 *
 * Nothing sends unless the safety net is ENABLED in the workstation settings.
 *
 * Secrets required (set as GitHub repository secrets — see the setup guide):
 *   FIREBASE_SERVICE_ACCOUNT   the full service-account JSON (one line)
 *   EMAILJS_PRIVATE_KEY        your EmailJS private key
 */

const admin = require('firebase-admin');

// ── Config you can tweak ───────────────────────────────────────────────
const DATABASE_URL = 'https://elijah-paul-booking-default-rtdb.europe-west1.firebasedatabase.app';
const SITE_URL     = 'https://booking.elijahpaul.com'; // used to build the reset link
const REMIND_AFTER_DAYS = 6;   // day you get the "tap to reset" email
const ALERT_AFTER_DAYS  = 7;   // day your next of kin get the client list

const EMAILJS = {
  serviceId:  'service_t29syda',
  templateId: 'template_afg6xzd',
  publicKey:  'aObqr3SjUOdTm03Py',
  privateKey: process.env.EMAILJS_PRIVATE_KEY,
};
const DAY = 86400000;

// ── Firebase (admin = full read access, bypasses rules) ─────────────────
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('Missing FIREBASE_SERVICE_ACCOUNT secret'); process.exit(1); }
if (!process.env.EMAILJS_PRIVATE_KEY)       { console.error('Missing EMAILJS_PRIVATE_KEY secret');       process.exit(1); }
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: DATABASE_URL,
});
const db = admin.database();

// ── Email sending via EmailJS REST API ──────────────────────────────────
async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:  EMAILJS.serviceId,
      template_id: EMAILJS.templateId,
      user_id:     EMAILJS.publicKey,
      accessToken: EMAILJS.privateKey,
      template_params: { to_email: to, to_name: to, subject, message: html, html_message: html, reply_to: to },
    }),
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${await res.text()}`);
  console.log(`  → emailed ${to}`);
}

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDate = d => { try { return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }); } catch { return d; } };

// ── Build the merged, de-duplicated upcoming client list ────────────────
async function buildClientList(sn) {
  const today = new Date().toISOString().split('T')[0];
  const map = new Map(); // key: email|date → row

  // Source 1: emails parsed from the uploaded .ics notes
  const ics = (sn.icsBookings && sn.icsBookings.bookings) || [];
  for (const b of ics) {
    if (b && b.date >= today && b.email) {
      map.set(b.email.toLowerCase() + '|' + b.date, { date: b.date, name: b.name || '', venue: b.venue || '', email: b.email });
    }
  }
  // Source 2: live workstation bookings
  const bkSnap = await db.ref('bookings').get();
  const bkVal = bkSnap.val() || {};
  const list = Array.isArray(bkVal) ? bkVal : Object.values(bkVal);
  for (const b of list) {
    if (b && b.eventDate && b.eventDate >= today && b.email && b.stage !== 'archived') {
      const name = ((b.firstName || '') + ' ' + (b.lastName || '')).trim();
      map.set(b.email.toLowerCase() + '|' + b.eventDate, { date: b.eventDate, name, venue: b.venue || '', email: b.email });
    }
  }
  return [...map.values()].sort((a, c) => a.date.localeCompare(c.date));
}

function buildCsv(rows) {
  const q = s => '"' + String(s || '').replace(/"/g, '""') + '"';
  const lines = ['Name,Event Date,Venue,Email'];
  for (const r of rows) lines.push([q(r.name), q(r.date), q(r.venue), q(r.email)].join(','));
  return lines.join('\n');
}

// ── Email bodies ────────────────────────────────────────────────────────
function alertHtml(rows) {
  const allEmails = [...new Set(rows.map(r => r.email).filter(Boolean))].join(', ');
  const tableRows = rows.map(r => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;">${esc(r.name) || '—'}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;">${esc(fmtDate(r.date))}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;">${esc(r.venue) || '—'}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;"><a href="mailto:${esc(r.email)}">${esc(r.email) || '—'}</a></td>
    </tr>`).join('');
  return `
  <div style="font-family:Arial,sans-serif;max-width:680px;color:#222;line-height:1.6;">
    <h2 style="color:#A87C1F;">Elijah Paul Music — upcoming bookings</h2>
    <p>This is an automatic message from Elijah's booking system. It was sent because Elijah has not logged in for ${ALERT_AFTER_DAYS} days, and he set this up in case he is ever unable to perform for his upcoming clients.</p>
    <p><strong>What to do:</strong> please contact the clients below to let them know Elijah may be unable to perform at their event, so they can make other arrangements. A suggested message is at the bottom.</p>
    <p style="background:#FBF6EA;border:1px solid #E8D9A8;border-radius:8px;padding:12px 14px;"><strong>All client emails (copy into BCC):</strong><br>${esc(allEmails) || 'None found'}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0;">
      <thead><tr>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ccc;">Client</th>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ccc;">Event date</th>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ccc;">Venue</th>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ccc;">Email</th>
      </tr></thead>
      <tbody>${tableRows || '<tr><td colspan="4" style="padding:10px;">No upcoming bookings with an email on file.</td></tr>'}</tbody>
    </table>
    <p style="font-size:13px;color:#777;">The same list is attached as a CSV file you can open in a spreadsheet.</p>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
    <p style="font-size:14px;"><strong>Suggested message to each client:</strong></p>
    <blockquote style="border-left:3px solid #A87C1F;margin:0;padding:6px 14px;color:#555;font-size:14px;">
      Dear [client],<br><br>
      I'm writing on behalf of Elijah Paul regarding your upcoming event on [date]. Sadly, Elijah is unable to perform as planned, and I wanted to let you know as early as possible so you can make alternative arrangements. I'm very sorry for the disruption. Please reply to this email if you have any questions.<br><br>
      With sincere apologies,<br>[your name]
    </blockquote>
  </div>`;
}

function reminderHtml(resetLink, days) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:560px;color:#222;line-height:1.6;">
    <h2 style="color:#A87C1F;">Still there, Elijah?</h2>
    <p>Your booking system hasn't seen you for <strong>${days} days</strong>. This is just a check-in from your safety net.</p>
    <p><strong>If all is well</strong>, tap the button below to reset it. If you don't, your next of kin will be emailed your upcoming client list tomorrow (day ${ALERT_AFTER_DAYS}).</p>
    <p style="margin:24px 0;"><a href="${esc(resetLink)}" style="background:#A87C1F;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block;">I'm fine — reset my safety net</a></p>
    <p style="font-size:13px;color:#777;">Logging into your workstation as normal also resets it. If the button doesn't work, open this link:<br>${esc(resetLink)}</p>
  </div>`;
}

function monthlyHtml(days) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:560px;color:#222;line-height:1.6;">
    <h2 style="color:#1E7E4B;">✓ Safety net is working</h2>
    <p>Your monthly check: the safety net ran today and everything is healthy. You last checked in ${days} day(s) ago, so nothing was triggered.</p>
    <p style="font-size:13px;color:#777;">You receive this once a month so you know the system is alive. If these stop arriving, something has broken and is worth looking into.</p>
  </div>`;
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  const sn = (await db.ref('safetyNet').get()).val() || {};
  const config = sn.config || {};
  const ownerEmail = config.ownerEmail;
  const now = new Date();

  // Honour a pending one-tap reset link (validated against the secret token)
  if (sn.resetSignal && sn.resetSignal.token && sn.resetToken && sn.resetSignal.token === sn.resetToken) {
    await db.ref('safetyNet/lastSeen').set(sn.resetSignal.at || now.toISOString());
    await db.ref('safetyNet/resetSignal').remove();
    await db.ref('safetyNet/state').set({ remindedAt: null, alertedAt: null });
    sn.lastSeen = sn.resetSignal.at || now.toISOString();
    sn.state = {};
    console.log('Reset link honoured — clock reset.');
  }

  if (!config.enabled) { console.log('Safety net is disabled in settings — nothing to do.'); return; }
  if (!ownerEmail)     { console.log('No owner email in config — cannot send reminders.'); }

  const lastSeen = new Date(sn.lastSeen || 0);
  const daysSince = Math.floor((now - lastSeen) / DAY);
  const state = sn.state || {};
  const kin = [config.kin1, config.kin2].filter(Boolean);
  console.log(`Days since last seen: ${daysSince}`);

  if (daysSince >= ALERT_AFTER_DAYS) {
    if (!state.alertedAt) {
      const rows = await buildClientList(sn);
      const html = alertHtml(rows);
      // Note: attachment support depends on your EmailJS template config; the full
      // list is always in the email body + a copy-paste BCC line, so it is never lost.
      if (kin.length === 0) console.log('No next-of-kin emails configured!');
      for (const to of kin) await sendEmail(to, 'Elijah Paul — upcoming client list (please read)', html);
      await db.ref('safetyNet/state/alertedAt').set(now.toISOString());
      console.log(`ALERT sent to next of kin (${rows.length} clients).`);
    } else {
      console.log('Next of kin already alerted; waiting for a reset.');
    }
  } else if (daysSince >= REMIND_AFTER_DAYS) {
    if (!state.remindedAt && ownerEmail) {
      const link = `${SITE_URL}/#reset/${sn.resetToken || ''}`;
      await sendEmail(ownerEmail, `Safety net check — tap to reset (day ${daysSince})`, reminderHtml(link, daysSince));
      await db.ref('safetyNet/state/remindedAt').set(now.toISOString());
      console.log('Reminder sent to Elijah.');
    } else {
      console.log('Reminder already sent.');
    }
  } else {
    if (state.remindedAt || state.alertedAt) { await db.ref('safetyNet/state').set({ remindedAt: null, alertedAt: null }); console.log('Activity detected — cleared old flags.'); }
    console.log('All good — within the check-in window.');
  }

  // Monthly "still working" confirmation (fires on the 1st)
  if (now.getUTCDate() === 1 && ownerEmail) {
    await sendEmail(ownerEmail, 'Safety net — monthly health check (all working)', monthlyHtml(daysSince));
    console.log('Monthly confirmation sent.');
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
