const express = require('express');
const multer = require('multer');
const { fetchAdzunaJobs } = require('../services/fetchers/adzuna');
const { fetchReedJobs } = require('../services/fetchers/reed');
const { fetchJoobleJobs } = require('../services/fetchers/jooble');
const { fetchWebExtractedJobs } = require('../services/webExtract');
const { runAiSearchPipeline } = require('../services/aiSearch/pipeline');
const { processResumeFile } = require('../services/aiSearch/resumeParser');
const { storeJobs, getJobsByIds } = require('../services/jobCache');
const recipients = require('../services/recipients');
const sentJobs = require('../services/sentJobs');
const { sendPersonalizedBroadcast } = require('../services/broadcastMailer');

// In-memory storage only — resumes are never written to disk. Files are
// held in RAM just long enough to extract text and discard the buffer.
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 }, // 5MB/file, 10 files max
});

/**
 * Strict PHRASE match — used for the Job Title/Role field. Requires the
 * words to appear together, in order, not just scattered independently
 * anywhere in the text. This is what avoids false positives like a college
 * lecturer posting matching "IT support" just because it separately
 * mentions "basic IT skills" in one sentence and "learning support" in
 * another — the role name should mean exactly what it says.
 */
function jobMatchesPhrase(job, phrase) {
  const clean = (phrase || '').trim();
  if (!clean) return true;

  const haystack = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  const escapedWords = clean
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const pattern = escapedWords.join('\\s+');
  return new RegExp(`\\b${pattern}\\b`, 'i').test(haystack);
}

/**
 * Looser AND match — used for the general Keywords field. Each
 * comma-or-newline-separated term just needs to appear somewhere in the
 * job (as a whole word), independently — good for extra qualifiers like
 * "remote, urgent" where the terms aren't meant to form one phrase.
 */
function jobMatchesKeywords(job, keywords) {
  const terms = (keywords || '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  return terms.every((term) => {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
  });
}

/**
 * Experience-level synonym map — since most job postings don't literally
 * write "0-1 years," they use phrases like "entry-level," "graduate," or
 * "senior." Each bracket lists alternate phrasings that count as a match.
 * Deliberately approximate: "senior" appears under both 5-8 and 8+ since
 * postings rarely commit to an exact year range for senior roles.
 */
const EXPERIENCE_SYNONYMS = {
  '0-1 years': ['0-1 year', '0-1 years', 'entry level', 'entry-level', 'graduate', 'no experience required', 'no experience necessary', 'fresher', 'trainee', 'apprentice'],
  '1-2 years': ['1-2 year', '1-2 years', 'junior', 'early career'],
  '2-3 years': ['2-3 year', '2-3 years', 'mid level', 'mid-level', 'intermediate'],
  '3-5 years': ['3-5 year', '3-5 years', 'mid-senior', 'experienced'],
  '5-8 years': ['5-8 year', '5-8 years', 'senior', 'experienced'],
  '8+ years': ['8+ years', 'senior', 'lead', 'principal', 'director', 'head of', 'extensive experience'],
};

const ALL_EXPERIENCE_PHRASES = Object.values(EXPERIENCE_SYNONYMS).flat();

function textMentionsPhrase(haystack, phrase) {
  const escapedWords = phrase
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escapedWords.join('\\s+');
  return new RegExp(`\\b${pattern}\\b`, 'i').test(haystack);
}

/**
 * Experience filter: a job passes if EITHER (a) it matches the selected
 * bracket's recognized phrasings, OR (b) it doesn't mention any
 * experience-level language at all (across every bracket) — since an
 * unspecified posting might genuinely fit. A job only gets excluded when
 * it explicitly states a level that ISN'T the selected one. No bracket
 * selected ("any") always passes everything.
 */
function jobMatchesExperience(job, experienceBracket) {
  const clean = (experienceBracket || '').trim();
  if (!clean) return true;

  const synonyms = EXPERIENCE_SYNONYMS[clean];
  if (!synonyms) return true;

  const haystack = `${job.title || ''} ${job.description || ''}`.toLowerCase();

  const matchesSelectedBracket = synonyms.some((phrase) => textMentionsPhrase(haystack, phrase));
  if (matchesSelectedBracket) return true;

  const mentionsAnyExperience = ALL_EXPERIENCE_PHRASES.some((phrase) => textMentionsPhrase(haystack, phrase));
  return !mentionsAnyExperience;
}

const router = express.Router();

/** Step 1: find jobs — search Adzuna + Reed + Jooble + configured web sources. */
router.post('/search', async (req, res) => {
  const { role = '', keywords = '', location = '', experience = '', includeSent = false } = req.body || {};

  // Deliberately NOT including `experience` in the query sent to the APIs.
  // Adzuna's AND-mode search (what_and) requires every word to appear
  // literally — appending "0-1 years" would require those exact tokens in
  // a posting's own text, wiping out almost all real results at the
  // source. Experience is matched entirely on our side instead (below).
  const searchKeywords = [role, keywords].filter(Boolean).join(' ').trim();

  try {
    const [adzuna, reed, jooble, webExtracted] = await Promise.all([
      fetchAdzunaJobs({ keywords: searchKeywords, location }),
      fetchReedJobs({ keywords: searchKeywords, location }),
      fetchJoobleJobs({ keywords: searchKeywords, location }),
      fetchWebExtractedJobs(),
    ]);

    const all = [...adzuna, ...reed, ...jooble, ...webExtracted];
    const byId = new Map();
    for (const job of all) {
      if (job.id && job.title) byId.set(job.id, job);
    }
    let jobs = [...byId.values()];

    // Job Title/Role and Experience stay as HARD filters — Role is what
    // actually prevents false positives like a Lecturer posting matching
    // "IT support" (see jobMatchesPhrase), and Experience follows the
    // "explicit contradiction excludes, unspecified passes" rule above.
    jobs = jobs.filter((job) => jobMatchesPhrase(job, role) && jobMatchesExperience(job, experience));

    // Keywords is a SOFT filter: tag each job rather than hiding it, and
    // let the frontend group/label matches vs. non-matches — a job that
    // fits the role but not every keyword might still be worth seeing.
    jobs = jobs.map((job) => ({ ...job, matchesKeywords: jobMatchesKeywords(job, keywords) }));
    jobs.sort((a, b) => Number(b.matchesKeywords) - Number(a.matchesKeywords));

    // Filter out jobs already sent to EVERY current recipient — if even
    // one person on the list hasn't received it yet, it still shows up.
    const recipientEmails = recipients.listRecipients().map((r) => r.email);
    const totalBeforeFilter = jobs.length;
    if (!includeSent) {
      jobs = jobs.filter((job) => !sentJobs.isFullySentToAll(job.id, recipientEmails));
    } else {
      jobs = jobs.map((job) => ({
        ...job,
        alreadySent: sentJobs.isFullySentToAll(job.id, recipientEmails),
      }));
    }
    const skippedCount = totalBeforeFilter - jobs.length;

    storeJobs(jobs); // cache so /send can resolve selected IDs later
    res.json({ jobs, count: jobs.length, skippedAlreadySent: skippedCount });
  } catch (err) {
    console.error('[search] failed:', err.message);
    res.status(500).json({ error: 'Search failed.', detail: err.message });
  }
});

/**
 * Prompt-driven search: converts a natural-language request into search
 * queries, finds candidate pages via Tavily, renders them with Playwright
 * (for JS-heavy career sites), and extracts structured job postings with
 * Gemini. Returns jobs in the same shape as /search, and applies the same
 * already-sent filtering, so results merge into the same select/send flow.
 *
 * This is a genuinely slower endpoint than /search (real browser renders +
 * multiple AI calls) — expect it to take longer, and treat missing
 * GEMINI_API_KEY / TAVILY_API_KEY as a clear configuration error rather
 * than a silent empty result.
 */
router.post('/ai-search', async (req, res) => {
  const { prompt = '', includeSent = false } = req.body || {};
  if (!prompt.trim()) {
    return res.status(400).json({ error: 'Enter a search prompt.' });
  }

  try {
    let jobs = await runAiSearchPipeline(prompt);

    const recipientEmails = recipients.listRecipients().map((r) => r.email);
    const totalBeforeFilter = jobs.length;
    if (!includeSent) {
      jobs = jobs.filter((job) => !sentJobs.isFullySentToAll(job.id, recipientEmails));
    } else {
      jobs = jobs.map((job) => ({
        ...job,
        alreadySent: sentJobs.isFullySentToAll(job.id, recipientEmails),
      }));
    }
    const skippedCount = totalBeforeFilter - jobs.length;

    storeJobs(jobs);
    res.json({ jobs, count: jobs.length, skippedAlreadySent: skippedCount });
  } catch (err) {
    console.error('[ai-search] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Resume-driven search: accepts one or more resume files (PDF/DOCX/TXT),
 * extracts a job-search profile from each (skills, suitable roles,
 * experience level) via Gemini, then runs ONE search PER resume — not one
 * merged search across all of them. A merged search dilutes relevance
 * (e.g. 3 candidates' skills mashed into one over-long query tends to
 * return fewer, less-targeted results) and caps total results at a single
 * pipeline run's worth. Running one per resume gives each candidate their
 * own properly-targeted search, and naturally surfaces more total jobs
 * across a multi-resume upload.
 *
 * Resume content is never written to disk or logged — files exist only
 * in memory for the duration of this request, and the uploaded buffers
 * are discarded once processing finishes (multer's memoryStorage, no
 * temp files, no persistence).
 */
router.post('/ai-search/resumes', resumeUpload.array('resumes', 10), async (req, res) => {
  const files = req.files || [];
  const { location = '', extraPrompt = '', includeSent = false } = req.body || {};

  if (files.length === 0) {
    return res.status(400).json({ error: 'Upload at least one resume (PDF, DOCX, or TXT).' });
  }

  try {
    const results = await Promise.allSettled(
      files.map((file) => processResumeFile(file.buffer, file.originalname, { location }))
    );

    const profiles = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? { fileName: files[i].originalname, error: r.reason.message } : null))
      .filter(Boolean);

    // Log each failure individually — these were previously only caught by
    // Promise.allSettled and returned in the response body, never logged
    // server-side, making them invisible in Render's logs when debugging.
    for (const f of failed) {
      console.error(`[ai-search/resumes] Failed to process "${f.fileName}":`, f.error);
    }

    if (profiles.length === 0) {
      return res.status(400).json({ error: 'Could not process any of the uploaded resumes.', failed });
    }

    const searchPrompts = profiles.map((p) =>
      extraPrompt.trim() ? `${p.searchPrompt} ${extraPrompt.trim()}` : p.searchPrompt
    );

    const perProfileJobs = await Promise.all(searchPrompts.map((prompt) => runAiSearchPipeline(prompt)));

    // Merge across all resumes, then dedupe — the same posting can
    // legitimately be a good fit for more than one candidate.
    let jobs = perProfileJobs.flat();
    const byKey = new Map();
    for (const job of jobs) {
      if (job.url && job.title) byKey.set(`${job.url}::${job.title.toLowerCase()}`, job);
    }
    jobs = [...byKey.values()];

    const recipientEmails = recipients.listRecipients().map((r) => r.email);
    const totalBeforeFilter = jobs.length;
    if (!includeSent) {
      jobs = jobs.filter((job) => !sentJobs.isFullySentToAll(job.id, recipientEmails));
    } else {
      jobs = jobs.map((job) => ({
        ...job,
        alreadySent: sentJobs.isFullySentToAll(job.id, recipientEmails),
      }));
    }
    const skippedCount = totalBeforeFilter - jobs.length;

    storeJobs(jobs);
    res.json({
      jobs,
      count: jobs.length,
      skippedAlreadySent: skippedCount,
      profiles: profiles.map((p, i) => ({
        fileName: p.fileName,
        candidateName: p.candidateName,
        skills: p.skills,
        suggestedRoles: p.suggestedRoles,
        experienceLevel: p.experienceLevel,
        jobsFound: perProfileJobs[i].length,
      })),
      failed,
      searchPromptsUsed: searchPrompts,
    });
  } catch (err) {
    console.error('[ai-search/resumes] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Step 3: recipients — list, add one, add many, remove. */
router.get('/recipients', (req, res) => {
  res.json(recipients.listRecipients());
});

router.post('/recipients', (req, res) => {
  const { email, name = '' } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  const record = recipients.addRecipient(email, name);
  if (!record) return res.status(400).json({ error: 'Invalid email address.' });
  res.json({ ok: true, recipient: record });
});

router.post('/recipients/bulk', (req, res) => {
  const { emails } = req.body || {};
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty array of emails.' });
  }
  const result = recipients.addRecipients(emails);
  res.json({ ok: true, ...result, total: recipients.listRecipients().length });
});

router.delete('/recipients/:email', (req, res) => {
  recipients.removeRecipient(req.params.email);
  res.json({ ok: true });
});

/** Step 2 + 4: selected jobs get sent — each recipient gets whichever of
 * the selected jobs they haven't already received before, so no one is
 * ever emailed the same posting twice. */
router.post('/send', async (req, res) => {
  const { jobIds = [], experience = {}, subject = '', message = '' } = req.body || {};

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one job to send.' });
  }

  const allJobs = getJobsByIds(jobIds).map((job) => ({
    ...job,
    experience: experience[job.id] || null,
  }));
  if (allJobs.length === 0) {
    return res.status(400).json({
      error: 'None of the selected jobs were found in cache. Please re-run the search and re-select.',
    });
  }

  const list = recipients.listRecipients();
  if (list.length === 0) {
    return res.status(400).json({ error: 'No recipients added yet.' });
  }

  const assignments = [];
  const alreadyCaughtUp = [];
  for (const recipient of list) {
    const jobsForRecipient = allJobs.filter((job) => !sentJobs.hasBeenSentTo(job.id, recipient.email));
    if (jobsForRecipient.length === 0) {
      alreadyCaughtUp.push(recipient.email);
    } else {
      assignments.push({ recipient, jobs: jobsForRecipient });
    }
  }

  if (assignments.length === 0) {
    return res.status(400).json({
      error: 'Every recipient has already received all of the selected jobs — nothing new to send.',
    });
  }

  try {
    const result = await sendPersonalizedBroadcast({ assignments, subject, message });

    for (const { email, jobs } of result.sent) {
      sentJobs.markSentToRecipient(jobs, email);
    }

    res.json({
      ok: true,
      recipientsTotal: list.length,
      sent: result.sent.length,
      alreadyCaughtUp: alreadyCaughtUp.length,
      failed: result.failed,
    });
  } catch (err) {
    console.error('[send] failed:', err.message);
    res.status(500).json({ error: 'Send failed.', detail: err.message });
  }
});

// Catches multer errors (file too large, too many files) before they'd
// otherwise surface as an unhandled exception / raw 500 HTML page.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'One of the resume files is over the 5MB limit.' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Upload at most 10 resumes at once.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  next(err);
});

module.exports = router;
