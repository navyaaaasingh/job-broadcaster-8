const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { callGemini } = require('./geminiClient');

/**
 * Extract raw text from an uploaded resume file.
 *
 * Supports PDF, DOCX, and TXT.
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
 * Ask Gemini to analyze ONE candidate's resume.
 *
 * Returns:
 * - Candidate name
 * - Top 5 skills
 * - Suggested roles
 * - Experience level
 * - Candidate-specific job search query
 *
 * Uses ONE Gemini call per candidate.
 */
async function extractProfileFromResume(
  resumeText,
  { location = '' } = {}
) {
  // Limit input size to control token usage.
  const truncated = resumeText.slice(0, 8000);

  const locationInstruction = location
    ? `- Include this location in the searchQuery: ${location}.`
    : '';

  const prompt = `You are an AI job-search assistant.

Analyze the candidate's resume below and create a structured job-search profile specifically for THIS candidate.

Return ONLY a valid JSON object with exactly these fields:

{
  "candidateName": string or null,
  "topSkills": [
    "skill 1",
    "skill 2",
    "skill 3",
    "skill 4",
    "skill 5"
  ],
  "suggestedRoles": [
    "job title 1",
    "job title 2",
    "job title 3",
    "job title 4"
  ],
  "experienceLevel": "0-1 years",
  "searchQuery": "single natural-language job search query"
}

Rules:

1. candidateName
- Extract the candidate's name from the resume header if available.
- If the name is unclear, return null.
- Do not invent a name.

2. topSkills
- Return EXACTLY 5 skills whenever the resume contains enough information.
- Select the 5 strongest and most job-relevant skills.
- Skills can include technical skills, tools, technologies, frameworks, platforms, or highly relevant professional skills.
- Prefer specific skills such as Python, SQL, React, AWS, Figma, Product Management, etc.
- Do NOT invent skills that are not supported by the resume.
- Avoid generic skills such as communication unless there are not enough relevant technical or professional skills.
- Rank the skills from strongest and most relevant to least relevant.

3. suggestedRoles
- Return up to 4 realistic job titles.
- Base these on the candidate's actual resume.
- Match the candidate's experience and seniority.
- Do not recommend senior roles to candidates without sufficient experience.
- For freshers, prefer entry-level, graduate, associate, junior, or internship roles where appropriate.
- Do not invent an unrelated career path.

4. experienceLevel
Choose exactly ONE of:
- "0-1 years"
- "1-2 years"
- "2-3 years"
- "3-5 years"
- "5-8 years"
- "8+ years"

Estimate this from the candidate's actual professional experience, internships, and relevant work history.

5. searchQuery
Create ONE concise natural-language job search query specifically for this candidate.

The search query MUST:
- Reflect the candidate's suggested roles.
- Include the candidate's strongest skills.
- Reflect the candidate's experience level.
${locationInstruction}
- Be suitable for searching job boards such as LinkedIn, Indeed, Naukri, or other job-search systems.
- Do NOT create a generic query that could apply equally to every candidate.

Example:

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

Resume text:

${truncated}
`;

  const response = await callGemini(prompt, {
    jsonMode: true
  });

  let profile;

  try {
    profile = JSON.parse(response);
  } catch (error) {
    console.error('Gemini JSON parsing error:', error);
    console.error('Gemini response:', response);

    throw new Error(
      'Gemini returned an invalid JSON response.'
    );
  }

  const topSkills = Array.isArray(profile.topSkills)
    ? profile.topSkills
        .filter(
          (skill) =>
            typeof skill === 'string' &&
            skill.trim().length > 0
        )
        .slice(0, 5)
    : [];

  const suggestedRoles = Array.isArray(profile.suggestedRoles)
    ? profile.suggestedRoles
        .filter(
          (role) =>
            typeof role === 'string' &&
            role.trim().length > 0
        )
        .slice(0, 4)
    : [];

  return {
    candidateName:
      typeof profile.candidateName === 'string'
        ? profile.candidateName.trim()
        : null,

    topSkills,

    suggestedRoles,

    experienceLevel:
      typeof profile.experienceLevel === 'string'
        ? profile.experienceLevel
        : null,

    searchQuery:
      typeof profile.searchQuery === 'string'
        ? profile.searchQuery.trim()
        : ''
  };
}

/**
 * Full processing pipeline for ONE resume.
 *
 * Resume
 *   ↓
 * Extract text
 *   ↓
 * Gemini
 *   ↓
 * Candidate profile
 *   ↓
 * Candidate-specific search query
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
 * Each candidate gets:
 * - Their own top 5 skills
 * - Their own suggested roles
 * - Their own experience level
 * - Their own search query
 *
 * Each resume requires ONE Gemini call.
 */
async function processMultipleResumes(
  resumes,
  { location = '' } = {}
) {
  return Promise.all(
    resumes.map((resume) =>
      processResumeFile(
        resume.buffer,
        resume.originalname || resume.filename,
        { location }
      )
    )
  );
}

module.exports = {
  extractTextFromResume,
  extractProfileFromResume,
  processResumeFile,
  processMultipleResumes
};
