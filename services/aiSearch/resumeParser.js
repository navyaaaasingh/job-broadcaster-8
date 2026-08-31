const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { callGemini } = require('./geminiClient');

/**
 * Extract raw text from an uploaded resume.
 *
 * Supports:
 * - PDF
 * - DOCX
 * - TXT
 *
 * Everything is processed in memory.
 */
async function extractTextFromResume(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (ext === 'pdf') {
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === 'txt') {
    return buffer.toString('utf-8');
  }

  throw new Error(
    `Unsupported resume file type: .${ext}. Use PDF, DOCX, or TXT.`
  );
}

/**
 * Extract a structured job-search profile from ONE resume.
 *
 * IMPORTANT:
 * This makes exactly ONE Gemini request per candidate.
 */
async function extractProfileFromResume(
  resumeText,
  { location = '' } = {}
) {
  /*
   * Keep the resume input reasonably small.
   *
   * 6000 characters is enough for most resumes while
   * reducing Gemini input-token usage.
   */
  const truncated = resumeText.slice(0, 6000);

  const locationInstruction = location
    ? `Location for job search: ${location}`
    : '';

  const prompt = `Analyze this resume and create a job-search profile for this candidate.

Return ONLY valid JSON.

Required format:
{
  "candidateName": null,
  "topSkills": [],
  "suggestedRoles": [],
  "experienceLevel": "",
  "searchQuery": ""
}

Rules:

- candidateName: candidate's name if clearly visible, otherwise null.
- topSkills: EXACTLY 5 strongest job-relevant skills supported by the resume.
- Do not invent skills.
- suggestedRoles: up to 4 realistic job titles based on the candidate's experience.
- Match job titles to the candidate's actual seniority.
- For freshers, prefer entry-level, graduate, junior, or internship roles.
- experienceLevel must be exactly one of:
  "0-1 years",
  "1-2 years",
  "2-3 years",
  "3-5 years",
  "5-8 years",
  "8+ years"
- searchQuery: ONE concise search query specifically for this candidate.
- The search query should combine the most relevant roles, top skills, experience level, and location when provided.
- Do not create a generic query.

${locationInstruction}

Resume:
${truncated}
`;

  const response = await callGemini(prompt, {
    jsonMode: true
  });

  let profile;

  try {
    profile = JSON.parse(response);
  } catch (error) {
    console.error('[resume-parser] Invalid Gemini JSON response');
    console.error(response);

    throw new Error(
      'Gemini returned an invalid profile response.'
    );
  }

  /*
   * Normalize skills.
   */
  const topSkills = Array.isArray(profile.topSkills)
    ? profile.topSkills
        .filter(
          (skill) =>
            typeof skill === 'string' &&
            skill.trim().length > 0
        )
        .map((skill) => skill.trim())
        .slice(0, 5)
    : [];

  /*
   * Normalize suggested roles.
   */
  const suggestedRoles = Array.isArray(profile.suggestedRoles)
    ? profile.suggestedRoles
        .filter(
          (role) =>
            typeof role === 'string' &&
            role.trim().length > 0
        )
        .map((role) => role.trim())
        .slice(0, 4)
    : [];

  /*
   * Candidate name.
   */
  const candidateName =
    typeof profile.candidateName === 'string' &&
    profile.candidateName.trim().length > 0
      ? profile.candidateName.trim()
      : null;

  /*
   * Experience level.
   */
  const validExperienceLevels = [
    '0-1 years',
    '1-2 years',
    '2-3 years',
    '3-5 years',
    '5-8 years',
    '8+ years'
  ];

  const experienceLevel =
    validExperienceLevels.includes(profile.experienceLevel)
      ? profile.experienceLevel
      : null;

  /*
   * Search query.
   */
  const searchQuery =
    typeof profile.searchQuery === 'string'
      ? profile.searchQuery.trim()
      : '';

  /*
   * Return both topSkills and skills.
   *
   * "skills" is kept temporarily for backwards compatibility
   * with your existing frontend code.
   */
  return {
    candidateName,

    topSkills,

    // Backwards compatibility:
    skills: topSkills,

    suggestedRoles,

    experienceLevel,

    searchQuery
  };
}

/**
 * Process ONE uploaded resume.
 */
async function processResumeFile(
  buffer,
  filename,
  { location = '' } = {}
) {
  const text = await extractTextFromResume(
    buffer,
    filename
  );

  if (!text || text.trim().length < 50) {
    throw new Error(
      `Could not read meaningful text from ${filename}.`
    );
  }

  const profile = await extractProfileFromResume(
    text,
    { location }
  );

  return {
    fileName: filename,
    ...profile
  };
}

/**
 * Process multiple resumes.
 *
 * Resumes are processed in small batches instead of all
 * at once to reduce the chance of hitting Gemini rate limits.
 *
 * Three Gemini requests are allowed concurrently.
 */
async function processMultipleResumes(
  resumes,
  { location = '' } = {}
) {
  const results = [];
  const CONCURRENCY = 3;

  for (
    let i = 0;
    i < resumes.length;
    i += CONCURRENCY
  ) {
    const batch = resumes.slice(
      i,
      i + CONCURRENCY
    );

    const batchResults = await Promise.all(
      batch.map((resume) =>
        processResumeFile(
          resume.buffer,
          resume.originalname || resume.filename,
          { location }
        )
      )
    );

    results.push(...batchResults);
  }

  return results;
}

module.exports = {
  extractTextFromResume,
  extractProfileFromResume,
  processResumeFile,
  processMultipleResumes
};
