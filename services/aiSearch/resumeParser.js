const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { callGemini } = require('./geminiClient');

/**
 * Extract raw text from an uploaded resume file. Operates entirely on the
 * in-memory buffer multer provides — nothing here touches disk, and the
 * caller is responsible for discarding the buffer once done (this module
 * never stores or logs resume content itself).
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
  throw new Error(`Unsupported resume file type: .${ext}. Use PDF, DOCX, or TXT.`);
}

/**
 * Ask Gemini to read a resume and extract a job-search-relevant profile:
 * key skills, suitable role titles, and an estimated experience level.
 * Also builds a ready-to-use search prompt combining these, so the result
 * can feed straight into the AI search pipeline (services/aiSearch/pipeline.js)
 * without any further assembly.
 */
async function extractProfileFromResume(resumeText, { location = '' } = {}) {
  const truncated = resumeText.slice(0, 8000); // keep prompt size sane

  const prompt = `Below is the text of a candidate's resume/CV. Read it and extract a job-search profile.

Return ONLY a JSON object with exactly these fields:
{
  "candidateName": string or null (best guess from the resume header, or null if unclear),
  "skills": array of up to 10 concise skill/technology strings,
  "suggestedRoles": array of up to 4 job title strings this person is realistically suited for right now (be honest about seniority — a resume with no professional experience should suggest entry-level/graduate/intern titles, not senior ones),
  "experienceLevel": one of "0-1 years", "1-2 years", "2-3 years", "3-5 years", "5-8 years", "8+ years",
  "searchPrompt": a single natural-language sentence suitable for searching job boards, combining the suggested roles and top skills${location ? ` and this location: ${location}` : ''}
}

Resume text:
${truncated}`;

  const response = await callGemini(prompt, { jsonMode: true });
  const profile = JSON.parse(response);

  return {
    candidateName: profile.candidateName || null,
    skills: Array.isArray(profile.skills) ? profile.skills.slice(0, 10) : [],
    suggestedRoles: Array.isArray(profile.suggestedRoles) ? profile.suggestedRoles.slice(0, 4) : [],
    experienceLevel: profile.experienceLevel || null,
    searchPrompt: profile.searchPrompt || '',
  };
}

/** Full per-resume step: extract text, then extract a profile from it. */
async function processResumeFile(buffer, filename, { location = '' } = {}) {
  const text = await extractTextFromResume(buffer, filename);
  if (!text || text.trim().length < 50) {
    throw new Error(`Could not read meaningful text from ${filename}.`);
  }
  const profile = await extractProfileFromResume(text, { location });
  return { fileName: filename, ...profile };
}

/**
 * Merge several resume profiles into one combined search prompt covering
 * all of them — used when multiple resumes are uploaded at once (e.g. a
 * cohort of learners) so one search run covers the whole group rather than
 * one slow AI-search pipeline run per resume.
 */
function buildCombinedSearchPrompt(profiles, { extraPrompt = '', location = '' } = {}) {
  const allRoles = [...new Set(profiles.flatMap((p) => p.suggestedRoles))];
  const allSkills = [...new Set(profiles.flatMap((p) => p.skills))];

  const parts = [];
  if (allRoles.length > 0) parts.push(allRoles.slice(0, 6).join(' or '));
  if (allSkills.length > 0) parts.push(`for candidates skilled in ${allSkills.slice(0, 12).join(', ')}`);
  if (location) parts.push(`in ${location}`);
  if (extraPrompt.trim()) parts.push(extraPrompt.trim());

  return parts.join(' ').trim();
}

module.exports = { extractTextFromResume, extractProfileFromResume, processResumeFile, buildCombinedSearchPrompt };
