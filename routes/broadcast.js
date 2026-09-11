const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
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

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
});

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

// Training-provider promotions are not useful job-search results for this app.
// Match provider names/domains rather than generic words such as "training"
// so legitimate jobs that mention training are not accidentally removed.
const TRAINING_PROVIDER_PATTERNS = [
  /(^|[^a-z])newto([^a-z]|$)/i,
  /(^|[^a-z])itol(?:\s+training)?([^a-z]|$)/i,
  /(?:^|[./\s_-])newto(?:\.co\.uk|\.com)?(?:$|[./\s_-])/i,
  /(?:^|[./\s_-])itoltraining(?:\.co\.uk|\.com)?(?:$|[./\s_-])/i,
];

function isTrainingProviderPromotion(job) {
  const haystack = [job.title, job.company, job.description, job.url, job.source]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return TRAINING_PROVIDER_PATTERNS.some((pattern) => pattern.test(haystack));
}

function filterTrainingProviderPromotions(jobs) {
  return jobs.filter((job) => !isTrainingProviderPromotion(job));
}

const EXPERIENCE_SYNONYMS = {
  '0-3 years': [
    '0-3 year',
    '0-3 years',
    '0-1 year',
    '0-1 years',
    '1-2 year',
    '1-2 years',
    '2-3 year',
    '2-3 years',
    'entry level',
    'entry-level',
    'graduate',
    'no experience required',
    'no experience necessary',
    'fresher',
    'trainee',
    'apprentice',
    'junior',
    'early career',
  ],
  '3-5 years': [
    '3-5 year',
    '3-5 years',
    'mid-senior',
    'experienced',
  ],
  '5-8 years': [
    '5-8 year',
    '5-8 years',
    'senior',
    'experienced',
  ],
  '8+ years': [
    '8+ years',
    'senior',
    'lead',
    'principal',
    'director',
    'head of',
    'extensive experience',
  ],
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

  const searchKeywords = [role, keywords].filter(Boolean).join(' ').trim();

  try {
    const [adzuna, reed, jooble, webExtracted] = await Promise.all([
      fetchAdzunaJobs({ keywords: searchKeywords, location }),
      fetchReedJobs({ keywords: searchKeywords, location }),
      fetchJoobleJobs({ keywords: searchKeywords, location }),
      fetchWebExtractedJobs(),
    ]);

    const all = filterTrainingProviderPromotions([...adzuna, ...reed, ...jooble, ...webExtracted]);
    const byId = new Map();
    for (const job of all) {
      if (job.id && job.title) byId.set(job.id, job);
    }
    let jobs = [...byId.values()];

    jobs = jobs.filter((job) => jobMatchesPhrase(job, role) && jobMatchesExperience(job, experience));

    jobs = jobs.map((job) => ({ ...job, matchesKeywords: jobMatchesKeywords(job, keywords) }));
    jobs.sort((a, b) => Number(b.matchesKeywords) - Number(a.matchesKeywords));

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
    console.error('[search] failed:', err.message);
    res.status(500).json({ error: 'Search failed.', detail: err.message });
  }
});

/** Prompt-driven AI search. */
router.post('/ai-search', async (req, res) => {
  const { prompt = '', includeSent = false } = req.body || {};
  if (!prompt.trim()) {
    return res.status(400).json({ error: 'Enter a search prompt.' });
  }

  try {
    let jobs = filterTrainingProviderPromotions(await runAiSearchPipeline(prompt));

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
 * extracts a job-search profile from each — including the TOP 5 most
 * relevant skills, ranked by employability, not just the first 5 listed —
 * then runs ONE search PER resume using those top skills + suggested
 * roles. Resume content is never written to disk or logged; files exist
 * only in memory for the duration of this request.
 *
 * Both resume processing and the per-resume searches run sequentially
 * (not in parallel) — each involves several Gemini calls internally, and
 * running multiple resumes' worth of those simultaneously is what
 * previously burst past Gemini's free-tier rate limit.
 */
router.post('/ai-search/resumes', resumeUpload.array('resumes', 10), async (req, res) => {
  const files = req.files || [];
  const { location = '', extraPrompt = '', includeSent = false } = req.body || {};

  if (files.length === 0) {
    return res.status(400).json({ error: 'Upload at least one resume (PDF, DOCX, or TXT).' });
  }

  try {
    const results = [];
    for (const file of files) {
      try {
        const value = await processResumeFile(file.buffer, file.originalname, { location });
        results.push({ status: 'fulfilled', value });
      } catch (reason) {
        results.push({ status: 'rejected', reason });
      }
    }

    const profiles = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? { fileName: files[i].originalname, error: r.reason.message } : null))
      .filter(Boolean);

    for (const f of failed) {
      console.error(`[ai-search/resumes] Failed to process \"${f.fileName}\":`, f.error);
    }

    if (profiles.length === 0) {
      return res.status(400).json({ error: 'Could not process any of the uploaded resumes.', failed });
    }

    const searchPrompts = profiles.map((p) => {
      const basePrompt = (p.searchQuery || '').trim();
      const extra = extraPrompt.trim();

      if (!basePrompt) {
        throw new Error(
          `Gemini generated an empty search query for ${p.fileName}.`
        );
      }

      return extra
        ? `${basePrompt} ${extra}`
        : basePrompt;
    });

    const perProfileJobs = [];

    for (const prompt of searchPrompts) {
      console.log(
        '[ai-search/resumes] Running search with prompt:',
        prompt
      );

      const jobsForProfile = filterTrainingProviderPromotions(
        await runAiSearchPipeline(prompt)
      );

      console.log(
        `[ai-search/resumes] Search returned ${jobsForProfile.length} jobs.`
      );

      perProfileJobs.push(jobsForProfile);
    }

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
        topSkills: p.topSkills,
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

/**
 * Export selected jobs to an .xlsx file. Works identically regardless of
 * which of the three search tabs (structured Search, AI Search, From
 * Resume) produced the selection — all three already store their results
 * in the same jobCache via storeJobs(), so this just resolves whichever
 * IDs the frontend currently has checked, the same way /send does.
 */
router.post('/export/excel', (req, res) => {
  const { jobIds = [] } = req.body || {};

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one job to export.' });
  }

  const jobs = getJobsByIds(jobIds);
  if (jobs.length === 0) {
    return res.status(400).json({
      error: 'None of the selected jobs were found in cache. Please re-run the search and re-select.',
    });
  }

  try {
    const rows = jobs.map((job) => ({
      Title: job.title || '',
      Company: job.company || '',
      Location: job.location || '',
      Experience: job.experience || '',
      Source: job.source || '',
      'Apply Link': job.url || '',
      Description: job.description || '',
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = [
      { wch: 32 },
      { wch: 24 },
      { wch: 18 },
      { wch: 14 },
      { wch: 12 },
      { wch: 40 },
      { wch: 60 },
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Jobs');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=\"selected-jobs.xlsx\"');
    res.send(buffer);
  } catch (err) {
    console.error('[export/excel] failed:', err.message);
    res.status(500).json({ error: 'Export failed.', detail: err.message });
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
 * the selected jobs they haven't already received before. */
router.post('/send', async (req, res) => {
  const { jobIds = [], experience = {}, subject = '', message = '' } = req.body || {};

  if (!Array.isArray(jobIds) || jobIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one job.' });
  }

  const jobs = getJobsByIds(jobIds);
  if (jobs.length === 0) {
    return res.status(400).json({ error: 'Selected jobs are no longer available in cache.' });
  }

  const recipientList = recipients.listRecipients();
  if (recipientList.length === 0) {
    return res.status(400).json({ error: 'Add at least one recipient before sending.' });
  }

  try {
    const result = await sendPersonalizedBroadcast({
      jobs,
      recipients: recipientList,
      experience,
      subject,
      message,
    });
    res.json(result);
  } catch (err) {
    console.error('[send] failed:', err.message);
    res.status(500).json({ error: 'Broadcast failed.', detail: err.message });
  }
});

module.exports = router;
