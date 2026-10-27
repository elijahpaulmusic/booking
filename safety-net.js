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
      template_params: { to_email: to, to_name: to, subject, message: html, reply_to: to },
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
  const intro =
    `<h2 style="color:#A87C1F;">Elijah Paul Music — upcoming bookings</h2>` +
    `<p>This is an automatic message from Elijah's booking system. It was sent because Elijah has not logged in for ${ALERT_AFTER_DAYS} days, and he set this up in case he is ever unable to perform for his upcoming clients.</p>` +
    `<p><strong>What to do:</strong> please contact the clients below to let them know Elijah may be unable to perform at their event, so they can make other arrangements. A suggested message is at the bottom.</p>` +
    `<p style="background:#FBF6EA;border:1px solid #E8D9A8;border-radius:8px;padding:12px 14px;"><strong>All client emails (copy into BCC):</strong><br>${esc(allEmails) || 'None found'}</p>`;
  const tpl =
    `<hr style="border:none;border-top:1px solid #eee;margin:20px 0;">` +
    `<p style="font-size:14px;"><strong>Suggested message to each client:</strong></p>` +
    `<blockquote style="border-left:3px solid #A87C1F;margin:0;padding:6px 14px;color:#555;font-size:14px;">` +
    `Dear [client],<br><br>I'm writing on behalf of Elijah Paul regarding your upcoming event on [date]. Sadly, Elijah is unable to perform as planned, and I wanted to let you know as early as possible so you can make alternative arrangements. I'm very sorry for the disruption. Please reply to this email if you have any questions.<br><br>With sincere apologies,<br>[your name]</blockquote>`;

  // Lean table (short per-cell styles + cellpadding) keeps the email small.
  const bd = 'border-bottom:1px solid #eee';
  const rowsHtml = rows.map(r =>
    `<tr><td style="${bd}">${esc(r.name) || '—'}</td><td style="${bd}">${esc(fmtDate(r.date))}</td><td style="${bd}">${esc(r.venue) || '—'}</td><td style="${bd}">${esc(r.email) || '—'}</td></tr>`
  ).join('');
  const table =
    `<table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0;">` +
    `<thead><tr><th align="left" style="border-bottom:2px solid #ccc">Client</th><th align="left" style="border-bottom:2px solid #ccc">Event date</th><th align="left" style="border-bottom:2px solid #ccc">Venue</th><th align="left" style="border-bottom:2px solid #ccc">Email</th></tr></thead>` +
    `<tbody>${rowsHtml || '<tr><td colspan="4">No upcoming bookings with an email on file.</td></tr>'}</tbody></table>`;

  let body = `<div style="font-family:Arial,sans-serif;max-width:680px;color:#222;line-height:1.6;">${intro}${table}${tpl}</div>`;

  // Safety guard: EmailJS caps all template variables at 50KB combined. If a very
  // large client list would exceed that, fall back to a compact one-line-per-client
  // list — far smaller — so the alert always sends rather than failing.
  if (body.length > 45000) {
    const compact = rows.map(r =>
      `${esc(fmtDate(r.date))} — ${esc(r.name) || '—'} — ${esc(r.venue) || '—'} — ${esc(r.email) || '—'}`
    ).join('<br>');
    body = `<div style="font-family:Arial,sans-serif;max-width:680px;color:#222;line-height:1.6;">${intro}<p style="font-size:14px;line-height:1.8;">${compact || 'No upcoming bookings with an email on file.'}</p>${tpl}</div>`;
  }
  return body;
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

// ══════════════════════════════════════════════════════════════════════
// PRE-EVENT CONFIRMATION DRAFTS
// Emails ELIJAH (not the client) a ready-to-send confirmation email for each
// upcoming solo booking ~2 weeks out, pre-filled from the uploaded .ics notes.
// He adds the payment link, attaches the invoice, and forwards it on.
// ══════════════════════════════════════════════════════════════════════
const PRE_EVENT_MAX_DAYS = 14; // start drafting this many days before the event
const PRE_EVENT_MIN_DAYS = 8;  // still catch late .ics uploads down to here

// Work out the service from the calendar title prefix.
// NB: check "SOLO SAX AND DJ" (combo) before "SAX AND DJ" (sax_dj).
function detectService(title) {
  const t = (title || '').toUpperCase();
  if (t.includes('SOLO SAX AND DJ')) return 'combo';
  if (t.includes('SAX AND DJ'))      return 'sax_dj';
  if (t.includes('SOLO SAX'))        return 'sax_bt';
  return null; // not a solo sax booking (e.g. DUALERS GIG) → no draft
}
// "SOLO SAX - Sally Grey - £450" → { full:'Sally Grey', first:'Sally' }
function nameFromTitle(title) {
  const parts = (title || '').split(/\s[—–-]\s/).map(s => s.trim()).filter(Boolean);
  const full = parts.length >= 2 ? parts[1] : '';
  const first = (full.split(/\s+/)[0] || '').trim();
  return { full, first };
}
// Turn the labelled notes block into { label(lowercase): value }
function parseNotes(notes) {
  const out = {};
  (notes || '').split('\n').forEach(line => {
    const m = line.match(/^([^:]{2,40}?):\s*(.*)$/);
    if (m) out[m[1].trim().toLowerCase()] = m[2].trim();
  });
  return out;
}
// Build the client-ready email text for the right template.
// f = { first, venue, arrive, setTimes, requests, emergency }
function preEventText(service, f) {
  const isDJ = service === 'sax_dj';
  const L = [];
  L.push(`Hi ${f.first || 'there'},`);
  L.push('');
  L.push(isDJ
    ? "Hope you're well! Really looking forward to playing for you in next week! As the date is fast approaching I thought I would send through the event details I have to confirm the final details:"
    : "Hope you're well! Really looking forward to playing for you next week! As the date is fast approaching I thought I would send through the event details I have to confirm the final details:");
  L.push('');
  L.push(`Venue: ${f.venue || ''}`);
  L.push('');
  L.push(`Arrive time: ${f.arrive || ''}`);
  L.push(`Set time(s): ${f.setTimes || ''}`);
  L.push('');
  L.push(isDJ
    ? "Are these correct? Does the DJ know I'm playing alongside them and were you able to send them this link to my requirements? https://www.elijahpaul.com/fordjs"
    : "Are these correct? Does the DJ know I'm playing alongside them?");
  L.push('');
  L.push("As I'll be performing during the evening with your DJ, could you let me know when your evening food will be brought out? From experience, evening food tends to take guests away from the dance floor for about 30 minutes from when it's first brought out. If my set times as they are currently will clash with your evening food, I'm happy to discuss options for changing my set times so as many of your guests can enjoy my evening sets as possible!");
  L.push('');
  // Song / style requests
  L.push(f.requests ? `Song/style requests: ${f.requests}` : 'Song/style requests:');
  L.push('');
  const noReq = f.requests ? '' : "I currently don't have any requests from you for my sets. ";
  if (isDJ) {
    L.push(`${noReq}You're welcome to choose any songs you like, and if you're short for ideas you can choose from my repertoire list. For ease, I made this setlist builder, use this link to choose songs for my evening sets:`);
    L.push('');
  } else {
    L.push(`${noReq}You're welcome to choose any songs you like, and if you're short for ideas you can choose from my repertoire list. For ease, I made this setlist builder, use this link for the reception drinks set:`);
    L.push('');
    L.push('And this link for the wedding breakfast set:');
    L.push('');
    L.push('And this link for any songs you would like to hear Sax with alongside your DJ:');
    L.push('');
    L.push("Once chosen, simply copy the setlist into the reply to this email! I'll play anything you choose. Don't feel like you have to choose every single song, you're welcome to select as many or as few as you like! You're also welcome to just send through a genre or a vibe for any particular set and I'll be happy to choose great songs I know work well.");
    L.push('');
    L.push("So I don't repeat songs you have selected for your Ceremony, First Dance, or (if applicable) Father-Daughter Dance, please send them through and I'll make sure not to perform them (unless you would like me to as well)!");
  }
  L.push('');
  L.push(`Any other info: Emergency number to be used in the very rare instance I'll be late: ${f.emergency || ''}`);
  if (!f.emergency) {
    L.push('');
    L.push("I currently don't have an emergency number I could use on the day just in case. As it's your Wedding/event you might not have your phone on you before or during the event when I may need to phone so I like to have a contact of someone that will. Obviously, it's unlikely I'll need it and if you'll have your phone on you this isn't required at all but just in case I thought I'd ask.");
  }
  L.push('');
  L.push("Let me know if this is all correct as well as any additional information I might need. More than welcome to add any requests or make timing changes at any time up to 2 days before the event. If you would prefer to call me about anything too, you're welcome to any day Monday-Thursday between 3pm-10pm on 07519 356742.");
  L.push('');
  L.push("Also, just in case you would like to settle the remaining balance early, here's a payment link: [add payment link here before sending]");
  L.push('I have also attached the final invoice for convenience. More than welcome to pay at any time up to 14 days after the event so no rush!');
  L.push('');
  L.push('Speak soon!');
  L.push('');
  L.push('Kind regards,');
  L.push('Elijah');
  return L.join('\n');
}
function preEventHtml(text) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6;white-space:pre-wrap;">${esc(text)}</div>`;
}

async function runPreEvent(sn, ownerEmail) {
  if (!ownerEmail) { console.log('Pre-event: no owner email configured — skipping.'); return; }
  const ics = (sn.icsBookings && sn.icsBookings.bookings) || [];
  const todayStr = new Date().toISOString().split('T')[0];
  const sentMap = sn.preEventSent || {};
  let inWindow = 0, sent = 0;
  for (const b of ics) {
    if (!b || !b.date || !b.email || !b.notes) continue;   // need notes to fill the email
    const service = detectService(b.name);
    if (!service) continue;                                  // skip band/DUALERS gigs
    const dUntil = Math.round((new Date(b.date + 'T12:00:00') - new Date(todayStr + 'T12:00:00')) / DAY);
    if (dUntil > PRE_EVENT_MAX_DAYS || dUntil < PRE_EVENT_MIN_DAYS) continue;
    inWindow++;
    const key = (b.email + '|' + b.date).replace(/[.#$\[\]/]/g, '_');
    if (sentMap[key]) continue;                              // already drafted — never duplicate
    try {
      const nm = nameFromTitle(b.name);
      const nf = parseNotes(b.notes);
      const f = {
        first: nm.first,
        venue: nf['exact location'] || b.venue || '',
        arrive: nf['arrive time'] || '',
        setTimes: nf['set times'] || '',   // keep the "90x minutes:" label — tells the client how long they've booked
        requests: nf['song/style requests'] || '',
        emergency: nf['emergency'] || '',
      };
      const subject = `Pre-event draft → ${b.email} · ${nm.full || nm.first} · ${fmtDate(b.date)}`;
      await sendEmail(ownerEmail, subject, preEventHtml(preEventText(service, f)));
      await db.ref('safetyNet/preEventSent/' + key).set(new Date().toISOString());
      sent++;
      console.log(`  pre-event draft → ${nm.full} (${b.date}, ${service}, ${dUntil}d)`);
    } catch (e) {
      console.error(`  pre-event draft FAILED for ${b.date} ${b.email}: ${e.message}`);
    }
  }
  console.log(`Pre-event: ${inWindow} booking(s) in the ${PRE_EVENT_MIN_DAYS}-${PRE_EVENT_MAX_DAYS} day window, ${sent} new draft(s) sent.`);
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

  // Pre-event confirmation drafts run independently of the dead-man's switch.
  if (config.preEventEnabled !== false) {
    try { await runPreEvent(sn, ownerEmail); }
    catch (e) { console.error('Pre-event module error:', e.message); }
  } else {
    console.log('Pre-event drafts disabled in settings — skipping.');
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
