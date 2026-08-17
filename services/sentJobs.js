const db = require('./db');

// sentJobs entries: { jobId, email, title, sentAt } — one row per
// (job, recipient) pair that has actually been emailed successfully.
// Tracking per-recipient (not just per-job) means a job already sent to
// some people can still go out to someone new who hasn't received it yet.

function pairKey(jobId, email) {
  return `${jobId}::${email.toLowerCase()}`;
}

function getSentPairSet() {
  return new Set(db.get('sentJobs').value().map((r) => pairKey(r.jobId, r.email)));
}

/** Has this specific job already been sent to this specific recipient? */
function hasBeenSentTo(jobId, email) {
  return getSentPairSet().has(pairKey(jobId, email));
}

/**
 * True only if EVERY given recipient has already received this job.
 * Used to decide whether to hide a job from search entirely — if even one
 * current recipient hasn't received it yet, it still shows up. With zero
 * recipients, there's no one to have received anything, so this returns
 * false (nothing is considered "fully sent").
 */
function isFullySentToAll(jobId, recipientEmails) {
  if (recipientEmails.length === 0) return false;
  const sentSet = getSentPairSet();
  return recipientEmails.every((email) => sentSet.has(pairKey(jobId, email)));
}

/** Record that this exact set of jobs was just sent to this one recipient. */
function markSentToRecipient(jobs, email) {
  const sentSet = getSentPairSet();
  const newRecords = jobs
    .filter((job) => !sentSet.has(pairKey(job.id, email)))
    .map((job) => ({ jobId: job.id, title: job.title, email: email.toLowerCase(), sentAt: new Date().toISOString() }));
  if (newRecords.length > 0) {
    db.get('sentJobs').push(...newRecords).write();
  }
}

module.exports = { hasBeenSentTo, isFullySentToAll, markSentToRecipient };
