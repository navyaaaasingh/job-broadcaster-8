# Job Broadcaster

Search **Adzuna**, **Reed**, **Jooble**, and any other configured job pages,
pick the specific jobs you want to share, maintain a recipient list, and
send the same email template to everyone on it — trimmed per person so no
one is ever sent the same posting twice.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` — see the file itself for what each variable does and where
to get it. Nothing is required to just run the app; sources without keys
configured are skipped automatically.

## Run

```bash
npm start
```
Open `http://localhost:3000`.

## Extra job sources without an API (new)

Adzuna, Reed, and Jooble all have real public APIs. Many useful job pages
don't — a specific company's careers page, a council job board, NHS Jobs,
etc. `services/webExtract/` adds a way to include those too:

1. **`services/webExtract/sources.js`** — a fixed list of page URLs to
   check on every search. Add an entry by visiting the site yourself,
   running a real search there, and pasting the resulting URL — see the
   comments in that file for the exact format.
2. For each configured URL, the app:
   - Checks the site's `robots.txt` first and skips anything disallowed
   - Looks for `schema.org/JobPosting` structured data embedded in the
     page (many sites publish this specifically for search engines to
     read) — free, reliable, no AI needed when present
   - Falls back to AI extraction (via `ANTHROPIC_API_KEY`) only when no
     structured data is found — sends the page's text to an LLM with a
     prompt to extract job postings as JSON

**What this deliberately does NOT do:** scrape LinkedIn or Indeed. Both
explicitly prohibit automated access in their Terms of Service and actively
block it — this is a real boundary, not just a technical hurdle, so
`sources.js` should never include URLs from either site. For those two,
realistic options are an official partner/enterprise API (LinkedIn Talent
Solutions, Indeed's employer APIs), a licensed aggregator service, or
manual curation by a person.

## Everything else

See inline comments throughout `routes/broadcast.js` (the main logic file)
and each `services/*.js` file — every non-obvious decision is documented
at the point it's made, including:
- Why Job Title/Role uses strict phrase matching but Keywords is a soft,
  sortable filter instead
- Why Experience matches against a synonym list instead of exact bracket
  text, and why unspecified postings still show up
- Why job search results and the recipient list are persisted to disk
  (`data/db.json`) rather than kept only in memory
- Why email sends are one-per-recipient rather than one email with
  everyone in the "to" field
