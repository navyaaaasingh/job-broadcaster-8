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
 * Operates entirely on the in-memory buffer provided by multer.
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
 * Prepare resume text for Gemini.
 *
 * We preserve BOTH the beginning and the end of long resumes.
 *
 * This is important because:
 * - Candidate name/profile/experience usually appear near the beginning.
 * - Skills/certifications often appear near the end.
 *
 * Simply taking the first N characters can accidentally remove
 * the Skills section.
 */
function prepareResumeText(resumeText) {
  const MAX_RESUME_CHARS = 10000;

  if (resumeText.length <= MAX_RESUME_CHARS) {
    return resumeText;
  }

  const FIRST_PART_CHARS = 6500;
  const LAST_PART_CHARS = 3500;

  const firstPart = resumeText.slice(0, FIRST_PART_CHARS);
  const lastPart = resumeText.slice(-LAST_PART_CHARS);

  return `${firstPart}

[... middle of resume omitted to reduce input size ...]

${lastPart}`;
}

/**
 * Extract a structured job-search profile from ONE resume.
 *
 * ONE Gemini call is made per candidate.
 *
 * Returns:
 * - candidateName
 * - topSkills
 * - suggestedRoles
 * - experienceLevel
 * - searchQuery
 */
async function extractProfileFromResume(
  resumeText,
  { location = '' } = {}
) {
  const resumeForGemini = prepareResumeText(resumeText);

  const locationInstruction = location
    ? `- Include this location in the searchQuery: ${location}.`
    : '';

  const prompt = `You are an AI job-search assistant.

Analyze the COMPLETE resume provided below and create a structured job-search profile specifically for THIS candidate.

Return ONLY a valid JSON object.

Required format:

{
  "candidateName": null,
  "topSkills": [],
  "suggestedRoles": [],
  "experienceLevel": "",
  "searchQuery": ""
}

IMPORTANT SKILL EXTRACTION RULES:

- Inspect the ENTIRE resume before selecting skills.
- The resume may contain a dedicated "Skills" section near the end.
- Do not ignore skills that appear later in the resume.
- Use both the candidate's experience/projects and their explicit Skills section.
- If the resume contains at least 5 identifiable relevant skills, return EXACTLY 5.
- NEVER return an empty topSkills array when the resume contains identifiable skills.
- Do not invent skills that are not supported by the resume.
- Choose the 5 skills that are most useful for finding jobs for THIS candidate.
- Rank them from most relevant to least relevant.
- Prefer specific technical, product, AI, data, design, business, or professional skills over generic soft skills.

CANDIDATE NAME:

- Extract the candidate's name if clearly visible.
- If unclear, return null.
- Do not invent a name.

SUGGESTED ROLES:

- Return up to 4 realistic job titles.
- Base them on the candidate's actual education, projects, internships, and work experience.
- Match the candidate's actual seniority.
- Do not recommend senior roles to candidates without sufficient experience.
- For freshers, use entry-level, graduate, associate, junior, or internship roles where appropriate.
- Do not suggest unrelated career paths.

EXPERIENCE LEVEL:

Choose exactly ONE:

"0-1 years"
"1-2 years"
"2-3 years"
"3-5 years"
"5-8 years"
"8+ years"

Estimate professional experience from the resume.

SEARCH QUERY:

Create ONE concise job-search query specifically for this candidate.

The query must:
- Reflect the candidate's suggested roles.
- Include their strongest skills.
- Reflect their experience level.
${locationInstruction}
- Be suitable for job boards such as LinkedIn, Indeed, Naukri, and similar platforms.
- Be specific to this candidate.
- Do not create a generic query.

Example output:

{
  "candidateName": "Rahul Sharma",
  "topSkills": [
    "Python",
    "SQL",
    "Machine Learning",
    "Pandas",
    "Scikit-learn"
  ],
  "suggestedRoles": [
    "Junior Data Scientist",
    "Machine Learning Engineer",
    "Data Analyst"
  ],
  "experienceLevel": "0-1 years",
  "searchQuery": "entry-level data scientist, machine learning engineer, or data analyst jobs requiring Python, SQL, Machine Learning, Pandas, and Scikit-learn"
}

COMPLETE RESUME:

${resumeForGemini}
`;

  const response = await callGemini(prompt, {
    jsonMode: true
  });

  let profile;

  try {
    profile = JSON.parse(response);
  } catch (error) {
    console.error('[resume-parser] Gemini returned invalid JSON');
    console.error('[resume-parser] Response:', response);

    throw new Error(
      'Gemini returned an invalid profile response.'
    );
  }

  /**
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

  /**
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

  /**
   * Normalize candidate name.
   */
  const candidateName =
    typeof profile.candidateName === 'string' &&
    profile.candidateName.trim().length > 0
      ? profile.candidateName.trim()
      : null;

  /**
   * Validate experience level.
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

  /**
   * Normalize search query.
   */
  const searchQuery =
    typeof profile.searchQuery === 'string'
      ? profile.searchQuery.trim()
      : '';

  /**
   * Safety check:
   *
   * If Gemini somehow returns zero skills despite the resume
   * containing text, log it so it can be diagnosed rather than
   * silently producing "none detected".
   */
  if (topSkills.length === 0) {
    console.warn(
      '[resume-parser] Gemini returned zero skills for resume.'
    );
  }

  return {
    candidateName,

    // New field.
    topSkills,

    // Backward compatibility with existing frontend code
    // that uses p.skills.join(...).
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
 * Process multiple resumes independently.
 *
 * Maximum of 3 Gemini requests are made concurrently.
 *
 * Each candidate gets:
 * - Their own profile
 * - Their own top 5 skills
 * - Their own roles
 * - Their own search query
 */
async function processMultipleResumes(
  resumes,
  { location = '' } = {}
) {
  const results = [];

  // Keep concurrency low to reduce Gemini rate-limit risk.
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
