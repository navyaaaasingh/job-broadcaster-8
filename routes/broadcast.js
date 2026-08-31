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

/**
 * In-memory resume upload.
 *
 * Files are never written to disk.
 * Resumes remain in memory only while being processed.
 */
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 10
  }
});

/**
 * Strict PHRASE match.
 *
 * Used for the Job Title / Role field.
 * Requires the words to appear together and in order.
 */
function jobMatchesPhrase(job, phrase) {
  const clean = (phrase || '').trim();

  if (!clean) return true;

  const haystack =
    `${job.title || ''} ${job.description || ''}`.toLowerCase();

  const escapedWords = clean
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );

  const pattern = escapedWords.join('\\s+');

  return new RegExp(`\\b${pattern}\\b`, 'i').test(
    haystack
  );
}

/**
 * Looser AND match.
 *
 * Used for the general Keywords field.
 * Every comma/newline separated term must appear somewhere
 * in the job.
 */
function jobMatchesKeywords(job, keywords) {
  const terms = (keywords || '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (terms.length === 0) return true;

  const haystack =
    `${job.title || ''} ${job.description || ''}`.toLowerCase();

  return terms.every((term) => {
    const escaped = term
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return new RegExp(`\\b${escaped}\\b`, 'i').test(
      haystack
    );
  });
}

/**
 * Experience-level synonym map.
 */
const EXPERIENCE_SYNONYMS = {
  '0-1 years': [
    '0-1 year',
    '0-1 years',
    'entry level',
    'entry-level',
    'graduate',
    'no experience required',
    'no experience necessary',
    'fresher',
    'trainee',
    'apprentice'
  ],

  '1-2 years': [
    '1-2 year',
    '1-2 years',
    'junior',
    'early career'
  ],

  '2-3 years': [
    '2-3 year',
    '2-3 years',
    'mid level',
    'mid-level',
    'intermediate'
  ],

  '3-5 years': [
    '3-5 year',
    '3-5 years',
    'mid-senior',
    'experienced'
  ],

  '5-8 years': [
    '5-8 year',
    '5-8 years',
    'senior',
    'experienced'
  ],

  '8+ years': [
    '8+ years',
    'senior',
    'lead',
    'principal',
    'director',
    'head of',
    'extensive experience'
  ]
};

const ALL_EXPERIENCE_PHRASES =
  Object.values(EXPERIENCE_SYNONYMS).flat();

/**
 * Check whether a piece of text contains a phrase.
 */
function textMentionsPhrase(haystack, phrase) {
  const escapedWords = phrase
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );

  const pattern = escapedWords.join('\\s+');

  return new RegExp(`\\b${pattern}\\b`, 'i').test(
    haystack
  );
}

/**
 * Experience filter.
 *
 * A job passes if:
 * 1. It matches the selected experience bracket, OR
 * 2. It does not mention any experience-level language.
 *
 * A job is excluded only when it explicitly indicates
 * an incompatible experience level.
 */
function jobMatchesExperience(
  job,
  experienceBracket
) {
  const clean = (experienceBracket || '').trim();

  if (!clean) return true;

  const synonyms = EXPERIENCE_SYNONYMS[clean];

  if (!synonyms) return true;

  const haystack =
    `${job.title || ''} ${job.description || ''}`.toLowerCase();

  const matchesSelectedBracket =
    synonyms.some((phrase) =>
      textMentionsPhrase(haystack, phrase)
    );

  if (matchesSelectedBracket) return true;

  const mentionsAnyExperience =
    ALL_EXPERIENCE_PHRASES.some((phrase) =>
      textMentionsPhrase(haystack, phrase)
    );

  return !mentionsAnyExperience;
}

const router = express.Router();

/**
 * ============================================================
 * STANDARD SEARCH
 * ============================================================
 *
 * Find jobs using Adzuna + Reed + Jooble + configured
 * web sources.
 */
router.post('/search', async (req, res) => {
  const {
    role = '',
    keywords = '',
    location = '',
    experience = '',
    includeSent = false
  } = req.body || {};

  /*
   * Do NOT include experience in the API search query.
   *
   * Many APIs use AND-style matching, so adding phrases like
   * "0-1 years" can eliminate otherwise suitable jobs.
   */
  const searchKeywords = [
    role,
    keywords
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  try {
    const [
      adzuna,
      reed,
      jooble,
      webExtracted
    ] = await Promise.all([
      fetchAdzunaJobs({
        keywords: searchKeywords,
        location
      }),

      fetchReedJobs({
        keywords: searchKeywords,
        location
      }),

      fetchJoobleJobs({
        keywords: searchKeywords,
        location
      }),

      fetchWebExtractedJobs()
    ]);

    const all = [
      ...adzuna,
      ...reed,
      ...jooble,
      ...webExtracted
    ];

    const byId = new Map();

    for (const job of all) {
      if (job.id && job.title) {
        byId.set(job.id, job);
      }
    }

    let jobs = [...byId.values()];

    /*
     * Role and experience are hard filters.
     */
    jobs = jobs.filter(
      (job) =>
        jobMatchesPhrase(job, role) &&
        jobMatchesExperience(job, experience)
    );

    /*
     * Keywords are soft filters.
     *
     * We tag jobs instead of hiding them.
     */
    jobs = jobs.map((job) => ({
      ...job,

      matchesKeywords:
        jobMatchesKeywords(job, keywords)
    }));

    jobs.sort(
      (a, b) =>
        Number(b.matchesKeywords) -
        Number(a.matchesKeywords)
    );

    /*
     * Remove jobs already sent to every current recipient.
     */
    const recipientEmails =
      recipients
        .listRecipients()
        .map((r) => r.email);

    const totalBeforeFilter = jobs.length;

    if (!includeSent) {
      jobs = jobs.filter(
        (job) =>
          !sentJobs.isFullySentToAll(
            job.id,
            recipientEmails
          )
      );
    } else {
      jobs = jobs.map((job) => ({
        ...job,

        alreadySent:
          sentJobs.isFullySentToAll(
            job.id,
            recipientEmails
          )
      }));
    }

    const skippedCount =
      totalBeforeFilter - jobs.length;

    storeJobs(jobs);

    res.json({
      jobs,
      count: jobs.length,
      skippedAlreadySent: skippedCount
    });
  } catch (err) {
    console.error(
      '[search] failed:',
      err.message
    );

    res.status(500).json({
      error: 'Search failed.',
      detail: err.message
    });
  }
});

/**
 * ============================================================
 * AI SEARCH
 * ============================================================
 *
 * Natural-language prompt → Gemini query planner →
 * Tavily → rendered pages → structured/Gemini extraction.
 */
router.post('/ai-search', async (req, res) => {
  const {
    prompt = '',
    includeSent = false
  } = req.body || {};

  if (!prompt.trim()) {
    return res.status(400).json({
      error: 'Enter a search prompt.'
    });
  }

  try {
    let jobs =
      await runAiSearchPipeline(prompt);

    const recipientEmails =
      recipients
        .listRecipients()
        .map((r) => r.email);

    const totalBeforeFilter =
      jobs.length;

    if (!includeSent) {
      jobs = jobs.filter(
        (job) =>
          !sentJobs.isFullySentToAll(
            job.id,
            recipientEmails
          )
      );
    } else {
      jobs = jobs.map((job) => ({
        ...job,

        alreadySent:
          sentJobs.isFullySentToAll(
            job.id,
            recipientEmails
          )
      }));
    }

    const skippedCount =
      totalBeforeFilter - jobs.length;

    storeJobs(jobs);

    res.json({
      jobs,
      count: jobs.length,
      skippedAlreadySent: skippedCount
    });
  } catch (err) {
    console.error(
      '[ai-search] failed:',
      err.message
    );

    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * ============================================================
 * RESUME-DRIVEN AI SEARCH
 * ============================================================
 *
 * Each uploaded resume is processed independently.
 *
 * Flow:
 *
 * Resume
 *   ↓
 * Resume parser
 *   ↓
 * Candidate profile
 *   ↓
 * Candidate-specific searchQuery
 *   ↓
 * Query planner
 *   ↓
 * Tavily
 *   ↓
 * Jobs for that candidate
 *
 * IMPORTANT:
 * The resume parser now returns `searchQuery`.
 * Do NOT use the old `searchPrompt` field.
 */
router.post(
  '/ai-search/resumes',
  resumeUpload.array('resumes', 10),
  async (req, res) => {
    const files = req.files || [];

    const {
      location = '',
      extraPrompt = '',
      includeSent = false
    } = req.body || {};

    if (files.length === 0) {
      return res.status(400).json({
        error:
          'Upload at least one resume (PDF, DOCX, or TXT).'
      });
    }

    try {
      /**
       * --------------------------------------------------------
       * STEP 1: Process each resume
       * --------------------------------------------------------
       */

      const results =
        await Promise.allSettled(
          files.map((file) =>
            processResumeFile(
              file.buffer,
              file.originalname,
              { location }
            )
          )
        );

      const profiles =
        results
          .filter(
            (result) =>
              result.status === 'fulfilled'
          )
          .map(
            (result) => result.value
          );

      const failed =
        results
          .map((result, index) =>
            result.status === 'rejected'
              ? {
                  fileName:
                    files[index].originalname,

                  error:
                    result.reason?.message ||
                    'Unknown resume processing error.'
                }
              : null
          )
          .filter(Boolean);

      /**
       * Log failures individually.
       */
      for (const failure of failed) {
        console.error(
          `[ai-search/resumes] Failed to process "${failure.fileName}":`,
          failure.error
        );
      }

      if (profiles.length === 0) {
        return res.status(400).json({
          error:
            'Could not process any of the uploaded resumes.',
          failed
        });
      }

      /**
       * --------------------------------------------------------
       * STEP 2: Build candidate-specific search prompts
       * --------------------------------------------------------
       *
       * IMPORTANT:
       *
       * OLD:
       * p.searchPrompt
       *
       * NEW:
       * p.searchQuery
       *
       * Every candidate gets their OWN search query.
       */
      const searchPrompts =
        profiles.map((profile) => {
          const candidateQuery =
            typeof profile.searchQuery === 'string'
              ? profile.searchQuery.trim()
              : '';

          const extra =
            typeof extraPrompt === 'string'
              ? extraPrompt.trim()
              : '';

          if (candidateQuery && extra) {
            return `${candidateQuery} ${extra}`;
          }

          return candidateQuery || extra;
        });

      console.log(
        '[ai-search/resumes] Search prompts:',
        searchPrompts
      );

      /**
       * --------------------------------------------------------
       * STEP 3: Search independently for each candidate
       * --------------------------------------------------------
       *
       * We deliberately keep each candidate's results separate
       * until after their individual search has completed.
       */
      const perProfileJobs =
        await Promise.all(
          searchPrompts.map(
            async (searchPrompt, index) => {
              if (!searchPrompt) {
                console.warn(
                  `[ai-search/resumes] Empty search prompt for profile ${index + 1}.`
                );

                return [];
              }

              try {
                console.log(
                  `[ai-search/resumes] Searching profile ${index + 1}:`,
                  searchPrompt
                );

                const jobs =
                  await runAiSearchPipeline(
                    searchPrompt
                  );

                console.log(
                  `[ai-search/resumes] Profile ${index + 1} found ${jobs.length} jobs.`
                );

                return jobs;
              } catch (err) {
                console.error(
                  `[ai-search/resumes] Search failed for profile ${index + 1}:`,
                  err.message
                );

                return [];
              }
            }
          )
        );

      /**
       * --------------------------------------------------------
       * STEP 4: Merge all candidate results
       * --------------------------------------------------------
       */

      let jobs =
        perProfileJobs.flat();

      /**
       * Deduplicate identical job postings.
       */
      const byKey = new Map();

      for (const job of jobs) {
        if (
          job &&
          job.url &&
          job.title
        ) {
          const key =
            `${job.url}::${job.title.toLowerCase()}`;

          if (!byKey.has(key)) {
            byKey.set(key, job);
          }
        }
      }

      jobs = [...byKey.values()];

      /**
       * --------------------------------------------------------
       * STEP 5: Remove jobs already sent
       * --------------------------------------------------------
       */

      const recipientEmails =
        recipients
          .listRecipients()
          .map((r) => r.email);

      const totalBeforeFilter =
        jobs.length;

      if (!includeSent) {
        jobs = jobs.filter(
          (job) =>
            !sentJobs.isFullySentToAll(
              job.id,
              recipientEmails
            )
        );
      } else {
        jobs = jobs.map((job) => ({
          ...job,

          alreadySent:
            sentJobs.isFullySentToAll(
              job.id,
              recipientEmails
            )
        }));
      }

      const skippedCount =
        totalBeforeFilter - jobs.length;

      /**
       * --------------------------------------------------------
       * STEP 6: Cache jobs
       * --------------------------------------------------------
       */

      storeJobs(jobs);

      /**
       * --------------------------------------------------------
       * STEP 7: Return candidate profiles
       * --------------------------------------------------------
       *
       * Return BOTH topSkills and skills.
       *
       * topSkills = canonical new field.
       * skills = backwards compatibility for existing frontend.
       */

      const profileResults =
        profiles.map((profile, index) => ({
          fileName:
            profile.fileName,

          candidateName:
            profile.candidateName,

          topSkills:
            Array.isArray(profile.topSkills)
              ? profile.topSkills
              : Array.isArray(profile.skills)
                ? profile.skills
                : [],

          skills:
            Array.isArray(profile.topSkills)
              ? profile.topSkills
              : Array.isArray(profile.skills)
                ? profile.skills
                : [],

          suggestedRoles:
            Array.isArray(profile.suggestedRoles)
              ? profile.suggestedRoles
              : [],

          experienceLevel:
            profile.experienceLevel || null,

          searchQuery:
            profile.searchQuery || '',

          jobsFound:
            perProfileJobs[index]?.length || 0
        }));

      res.json({
        jobs,

        count:
          jobs.length,

        skippedAlreadySent:
          skippedCount,

        profiles:
          profileResults,

        failed,

        searchPromptsUsed:
          searchPrompts
      });
    } catch (err) {
      console.error(
        '[ai-search/resumes] failed:',
        err.message
      );

      res.status(500).json({
        error: err.message
      });
    }
  }
);

/**
 * ============================================================
 * RECIPIENTS
 * ============================================================
 */

/**
 * List recipients.
 */
router.get('/recipients', (req, res) => {
  res.json(
    recipients.listRecipients()
  );
});

/**
 * Add one recipient.
 */
router.post('/recipients', (req, res) => {
  const {
    email,
    name = ''
  } = req.body || {};

  if (
    !email ||
    !email.includes('@')
  ) {
    return res.status(400).json({
      error:
        'A valid email is required.'
    });
  }

  const record =
    recipients.addRecipient(
      email,
      name
    );

  if (!record) {
    return res.status(400).json({
      error:
        'Invalid email address.'
    });
  }

  res.json({
    ok: true,
    recipient: record
  });
});

/**
 * Add multiple recipients.
 */
router.post(
  '/recipients/bulk',
  (req, res) => {
    const { emails } =
      req.body || {};

    if (
      !Array.isArray(emails) ||
      emails.length === 0
    ) {
      return res.status(400).json({
        error:
          'Provide a non-empty array of emails.'
      });
    }

    const result =
      recipients.addRecipients(
        emails
      );

    res.json({
      ok: true,
      ...result,
      total:
        recipients
          .listRecipients()
          .length
    });
  }
);

/**
 * Remove recipient.
 */
router.delete(
  '/recipients/:email',
  (req, res) => {
    recipients.removeRecipient(
      req.params.email
    );

    res.json({
      ok: true
    });
  }
);

/**
 * ============================================================
 * SEND JOBS
 * ============================================================
 */

router.post('/send', async (req, res) => {
  const {
    jobIds = [],
    experience = {},
    subject = '',
    message = ''
  } = req.body || {};

  if (
    !Array.isArray(jobIds) ||
    jobIds.length === 0
  ) {
    return res.status(400).json({
      error:
        'Select at least one job to send.'
    });
  }

  const allJobs =
    getJobsByIds(jobIds).map(
      (job) => ({
        ...job,
        experience:
          experience[job.id] || null
      })
    );

  if (allJobs.length === 0) {
    return res.status(400).json({
      error:
        'None of the selected jobs were found in cache. Please re-run the search and re-select.'
    });
  }

  const list =
    recipients.listRecipients();

  if (list.length === 0) {
    return res.status(400).json({
      error:
        'No recipients added yet.'
    });
  }

  const assignments = [];
  const alreadyCaughtUp = [];

  for (const recipient of list) {
    const jobsForRecipient =
      allJobs.filter(
        (job) =>
          !sentJobs.hasBeenSentTo(
            job.id,
            recipient.email
          )
      );

    if (
      jobsForRecipient.length === 0
    ) {
      alreadyCaughtUp.push(
        recipient.email
      );
    } else {
      assignments.push({
        recipient,
        jobs: jobsForRecipient
      });
    }
  }

  if (
    assignments.length === 0
  ) {
    return res.status(400).json({
      error:
        'Every recipient has already received all of the selected jobs — nothing new to send.'
    });
  }

  try {
    const result =
      await sendPersonalizedBroadcast({
        assignments,
        subject,
        message
      });

    for (
      const { email, jobs } of result.sent
    ) {
      sentJobs.markSentToRecipient(
        jobs,
        email
      );
    }

    res.json({
      ok: true,
      recipientsTotal:
        list.length,
      sent:
        result.sent.length,
      alreadyCaughtUp:
        alreadyCaughtUp.length,
      failed:
        result.failed
    });
  } catch (err) {
    console.error(
      '[send] failed:',
      err.message
    );

    res.status(500).json({
      error: 'Send failed.',
      detail: err.message
    });
  }
});

/**
 * ============================================================
 * MULTER ERROR HANDLER
 * ============================================================
 */

router.use(
  (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      if (
        err.code ===
        'LIMIT_FILE_SIZE'
      ) {
        return res.status(400).json({
          error:
            'One of the resume files is over the 5MB limit.'
        });
      }

      if (
        err.code ===
        'LIMIT_FILE_COUNT'
      ) {
        return res.status(400).json({
          error:
            'Upload at most 10 resumes at once.'
        });
      }

      return res.status(400).json({
        error:
          `Upload error: ${err.message}`
      });
    }

    next(err);
  }
);

module.exports = router;
