/**
 * Fixed list of extra job pages to check beyond Adzuna/Reed/Jooble.
 *
 * How to add a source:
 * 1. Go to the site yourself and run a real search there (e.g. NHS Jobs,
 *    a company's careers page).
 * 2. Copy the resulting URL from your browser's address bar — including
 *    whatever keyword/location filters you applied.
 * 3. Add an entry below with that URL.
 *
 * This is deliberately NOT dynamic per-search — these are checked as-is
 * on every search, then filtered locally by role/keywords/experience the
 * same way Adzuna/Reed/Jooble results are. If you want different keyword
 * searches, add a URL per search you care about, or update these URLs
 * periodically.
 *
 * IMPORTANT — do not add linkedin.com or indeed.com URLs here. Both
 * explicitly prohibit automated access in their Terms of Service, and
 * both actively block it. This system is only meant for sources that
 * genuinely permit normal fetching (checked against robots.txt before
 * every request regardless of what's listed here).
 */
module.exports = [
  // Example — replace with a real NHS Jobs search URL once you've run a
  // search on jobs.nhs.uk yourself and copied the resulting link:
  // { id: 'nhs-jobs', name: 'NHS Jobs', url: 'https://www.jobs.nhs.uk/candidate/search/results?...' },

  // Example — a specific company careers/listings page:
  // { id: 'blackpool-council', name: 'Blackpool Council Careers', url: 'https://www.blackpool.gov.uk/jobs' },
];
