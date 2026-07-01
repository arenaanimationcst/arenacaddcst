// scripts/send-absence-reminders.js
//
// Runs daily via GitHub Actions (see .github/workflows/absence-reminders.yml).
// Checks every active student's most recent attendance record — if 3+ days have
// passed since their last check-in, sends them an absence reminder email via EmailJS.
// Then sends ONE summary email to cadd.cst@gmail.com listing everyone notified — sent via
// direct Gmail SMTP (Nodemailer), NOT EmailJS, because EmailJS's free plan only allows
// 2 templates and this account already uses both (welcome + absence reminder).
//
// Required GitHub repo secrets (Settings → Secrets and variables → Actions):
//   FIREBASE_SERVICE_ACCOUNT  — full JSON key from Firebase Console → Project Settings
//                               → Service Accounts → Generate New Private Key (paste the
//                               entire JSON file content as the secret value)
//   EMAILJS_PUBLIC_KEY        — same Public Key already used in admin.html
//   EMAILJS_PRIVATE_KEY       — from EmailJS Dashboard → Account → API Keys → Private Key
//                               (this is DIFFERENT from the Public Key — server-side calls
//                               need both)
//   GMAIL_USER                — cadd.cst@gmail.com
//   GMAIL_APP_PASSWORD        — a 16-character App Password generated from that Google
//                               account (NOT the normal Gmail password) — see setup notes.

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const ABSENCE_THRESHOLD_DAYS = 3; // same rule as the manual "Send Absence Reminders" button in admin.html

const EMAILJS_SERVICE = 'service_ps84vnc';
const EMAILJS_ABSENCE_TEMPLATE = 'template_8elds0n';
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

const ADMIN_EMAIL = 'cadd.cst@gmail.com';
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT secret.');
  process.exit(1);
}
if (!EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY) {
  console.error('Missing EMAILJS_PUBLIC_KEY or EMAILJS_PRIVATE_KEY secret.');
  process.exit(1);
}
if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('Missing GMAIL_USER or GMAIL_APP_PASSWORD secret.');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  return null;
}

async function sendAbsenceEmail(student, daysAbsent) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE,
      template_id: EMAILJS_ABSENCE_TEMPLATE,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: student.email,
        student_name: student.name,
        student_course: student.course || '—',
        days_absent: daysAbsent
      }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`EmailJS ${res.status}: ${text}`);
  }
}

// Sends ONE digest email to the admin listing every student who got a reminder this run —
// instead of CC'ing the admin on every individual student email (which would mean 10
// students absent = 10 separate emails landing in the admin inbox). Sent via direct Gmail
// SMTP (not EmailJS) since EmailJS's free plan caps templates at 2, and this account
// already uses both slots (welcome + absence reminder).
async function sendAdminSummaryEmail(notifiedList) {
  if (!notifiedList.length) {
    console.log('No absentees today — skipping admin summary email.');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });

  const runDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const rowsText = notifiedList
    .map(s => `${s.name} (${s.course}) — ${s.days} days absent`)
    .join('<br/>');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background-color:#1a1f29;padding:24px;">
      <div style="max-width:480px;margin:0 auto;background-color:#2E3542;border-radius:12px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;">
        <div style="background-color:#232936;padding:20px 24px;border-bottom:3px solid #F47920;">
          <div style="color:#ffffff;font-size:17px;font-weight:bold;">📋 Daily Absence Summary</div>
          <div style="color:#7A8499;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">CADDesk CST · ${runDate}</div>
        </div>
        <div style="padding:20px 24px 4px;color:#B0BAC9;font-size:14px;line-height:1.6;">
          <strong style="color:#F47920;font-size:20px;">${notifiedList.length}</strong> student(s) were sent an absence reminder today (3+ days since their last check-in):
        </div>
        <div style="padding:14px 24px 22px;">
          <div style="background-color:rgba(244,121,32,0.08);border:1px solid rgba(244,121,32,0.25);border-radius:8px;padding:14px 16px;color:#ffffff;font-size:13px;line-height:1.9;font-family:'Courier New',monospace;">
            ${rowsText}
          </div>
        </div>
        <div style="padding:0 24px 20px;color:#7A8499;font-size:11px;">
          Automated daily check from the CADDesk CST attendance system.
        </div>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"CADDesk CST Bot" <${GMAIL_USER}>`,
    to: ADMIN_EMAIL,
    subject: `📋 Daily Absence Summary — ${notifiedList.length} student(s) — ${runDate}`,
    html
  });

  console.log(`📋 Admin summary sent to ${ADMIN_EMAIL} (${notifiedList.length} student(s) listed)`);
}

async function main() {
  const studentsSnap = await db.collection('cadd_students').get();
  const students = studentsSnap.docs
    .map(d => ({ docId: d.id, ...d.data() }))
    .filter(s => s.status === 'active' || !s.status);

  let sent = 0, skipped = 0, failed = 0;
  const notifiedList = [];

  for (const s of students) {
    if (!s.email) { skipped++; continue; }

    // Single equality filter only (no orderBy) — avoids needing a Firestore composite
    // index, same approach used elsewhere in this project. Most-recent check-in computed
    // client-side instead.
    const attSnap = await db.collection('cadd_attendance')
      .where('studentDocId', '==', s.docId)
      .get();

    let lastCheckInMs = null;
    attSnap.forEach(doc => {
      const ms = toMillis(doc.data().checkIn);
      if (ms && (!lastCheckInMs || ms > lastCheckInMs)) lastCheckInMs = ms;
    });

    let daysSinceLast;
    if (lastCheckInMs) {
      daysSinceLast = Math.floor((Date.now() - lastCheckInMs) / 86400000);
    } else {
      const admMs = toMillis(s.admissionDate);
      daysSinceLast = admMs ? Math.floor((Date.now() - admMs) / 86400000) : 0;
    }

    if (daysSinceLast >= ABSENCE_THRESHOLD_DAYS) {
      try {
        await sendAbsenceEmail(s, daysSinceLast);
        console.log(`✅ Sent: ${s.name} (${daysSinceLast} days absent)`);
        notifiedList.push({ name: s.name, course: s.course || '—', days: daysSinceLast });
        sent++;
      } catch (e) {
        console.error(`❌ Failed for ${s.name}:`, e.message);
        failed++;
      }
    }
  }

  await sendAdminSummaryEmail(notifiedList);

  console.log(`\nDone. Sent: ${sent} | Skipped (no email on file): ${skipped} | Failed: ${failed}`);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
