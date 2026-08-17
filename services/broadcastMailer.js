const axios = require('axios');

const SENDER_NAME = process.env.SENDER_NAME || 'Job Broadcaster';

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Send one personalized email to a single recipient via Resend's HTTP API. */
async function sendBroadcastEmail({ recipient, subject, message, jobs }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not set — cannot send email.');
  }

  const greetName = recipient.name && recipient.name.trim() ? recipient.name.trim() : 'there';

  const tableRowsHtml = jobs
    .map(
      (j) => `
      <tr>
        <td style="padding:12px;border:1px solid #e2e2e2;">${escapeHtml(j.company)}</td>
        <td style="padding:12px;border:1px solid #e2e2e2;">${escapeHtml(j.title)}</td>
        <td style="padding:12px;border:1px solid #e2e2e2;">${escapeHtml(j.location) || '-'}</td>
        <td style="padding:12px;border:1px solid #e2e2e2;">${escapeHtml(j.experience) || '-'}</td>
        <td style="padding:12px;border:1px solid #e2e2e2;text-align:center;">
          <a href="${j.url}" style="background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:6px;display:inline-block;">Apply Now</a>
        </td>
      </tr>`
    )
    .join('');

  const html = `
    <div style="font-family:-apple-system,Arial,sans-serif;color:#222;line-height:1.6;">
      <p>Dear ${escapeHtml(greetName)},</p>
      <p>We from <strong>${escapeHtml(SENDER_NAME)}</strong> have brought you in with a few job links listed below where you could apply for these jobs that are active and related. Kindly ensure to apply to all of these job postings mentioned below without further delay.</p>
      ${message ? `<p>${escapeHtml(message).replace(/\n/g, '<br/>')}</p>` : ''}
      <table style="border-collapse:collapse;width:100%;margin:18px 0;font-size:14px;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:12px;border:1px solid #e2e2e2;text-align:left;">Company</th>
            <th style="padding:12px;border:1px solid #e2e2e2;text-align:left;">Job Title</th>
            <th style="padding:12px;border:1px solid #e2e2e2;text-align:left;">Location</th>
            <th style="padding:12px;border:1px solid #e2e2e2;text-align:left;">Experience</th>
            <th style="padding:12px;border:1px solid #e2e2e2;text-align:left;">Apply</th>
          </tr>
        </thead>
        <tbody>${tableRowsHtml}</tbody>
      </table>
      <p>Kindly check in and apply to the role that best suits your profile, and should you have any queries kindly feel free to write back.</p>
    </div>
  `;

  const textRows = jobs
    .map(
      (j) =>
        `• ${j.title} — ${j.company} (${j.location || 'n/a'})` +
        (j.experience ? `\n  Experience: ${j.experience}` : '') +
        `\n  Apply: ${j.url}`
    )
    .join('\n\n');

  const text =
    `Dear ${greetName},\n\n` +
    `We from ${SENDER_NAME} have brought you in with a few job links listed below where you could apply for these jobs that are active and related. Kindly ensure to apply to all of these job postings mentioned below without further delay.\n\n` +
    (message ? `${message}\n\n` : '') +
    `${textRows}\n\n` +
    `Kindly check in and apply to the role that best suits your profile, and should you have any queries kindly feel free to write back.`;

  await axios.post(
    'https://api.resend.com/emails',
    {
      from: process.env.RESEND_FROM || 'Job Broadcaster <onboarding@resend.dev>',
      to: recipient.email,
      subject: subject || `Job Listing for the week`,
      text,
      html,
    },
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
}

/**
 * Send email to a list of (recipient, jobs) assignments — each recipient
 * gets their own resolved job list, which may differ from person to person
 * (e.g. because some of them already received certain jobs previously).
 * Runs in small batches so a large list doesn't trip rate limits; one
 * recipient's failure doesn't stop the rest.
 */
async function sendPersonalizedBroadcast({ assignments, subject, message }) {
  const results = { sent: [], failed: [] };
  const BATCH_SIZE = 5;

  for (let i = 0; i < assignments.length; i += BATCH_SIZE) {
    const batch = assignments.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ recipient, jobs }) => {
        try {
          await sendBroadcastEmail({ recipient, subject, message, jobs });
          results.sent.push({ email: recipient.email, jobs });
        } catch (err) {
          const detail = err.response?.data || err.message;
          console.error(`[broadcast] failed for ${recipient.email}:`, detail);
          results.failed.push({ email: recipient.email, error: detail });
        }
      })
    );
  }

  return results;
}

module.exports = { sendBroadcastEmail, sendPersonalizedBroadcast };
