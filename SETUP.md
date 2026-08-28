# Hiring Management Dashboard

A modern internal hiring dashboard that uses an **existing Google Sheet as the
database** and **Google Apps Script as the JSON API**. Every role, applicant,
count, status and interview is read live from Google Sheets. There is **no demo
data** and **no hard-coded** roles.

```
                GOOGLE SHEETS   <- source of truth
                     |
                     v
              GOOGLE APPS SCRIPT
                     |
                     v
              DASHBOARD / WEBSITE
                     |
                     v
              USER EDITS DATA
                     |
                     v
              GOOGLE APPS SCRIPT  (GET + query params)
                     |
                     v
                GOOGLE SHEETS
```

## Spreadsheet layout (uses your existing structure)

### `Roles` tab

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| Role ID | Role Title | Department | Status | Approval Stage | Interview Kit |
| R001 | Satellite Systems Engineer | Engineering | Open | Approved | Complete |
| R002 | Mechanical Engineering Lead | Engineering | Open | Approved | Complete |

- `D Status` = `Open` or `Closed` → drives the Open/Closed card color and counts.
- `B Role Title` = the name of that role's applicant tab.

### Role applicant tabs (one per role, named after the role title)

| A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Applicant ID | Full Name | Email ID | Phone | Position | Resume | Experience | CTC | Priority | Status | Time we can go for | Review (Anisha) | Interviewer 1 | Interviewer 2 | Interviewer 3 | Interviewer 4 |
| APP001 | Vishalya | … | 8977026096 | Sat Sys | … | 1.5 |  | 1* | next round | 28 aug interview | strong |  |  |  |  |

- **Every sheet except `Roles` is auto-detected as a role tab.** Adding a new
  role + sheet makes it appear automatically (no code change, no hard-coded list).

### Tab-name matching (keeps your real sheet names untouched)

Your applicant tabs have the exact Google-Form/import names, e.g.
`Satellite Systems Engineer (Responses)` while the `Roles` master has the clean
display title `Satellite Systems Engineer`. Apps Script **never renames or
number-prefixes** your tabs. Instead it maps a tab to a role by:

1. matching `Role ID`, then
2. a **fuzzy, case/whitespace-insensitive** match that ignores suffixes like
   `(Responses)` / `(Form Responses)` and punctuation.

So `Satellite Systems Engineer (Responses)` → role `Satellite Systems Engineer`,
and the dashboard/apps/updates all use the clean title for display while writes
still go to the correct `(Responses)` tab. A tab not present in the `Roles`
master is still auto-detected (shown under its own tab name) and its applicants
count toward total applicants / interviews.

- Blank cells / incomplete rows are handled gracefully and never deleted.
- **`J Status` values are never normalized or rewritten.** The exact sheet text
  (e.g. `next round`, `Call done`, `Tech 1`, `PSR`, `reject`, `Cultural fit`,
  `Details`) is preserved in the sheet; the UI only *displays* it and applies a
  display-only color category.
- **Interviews:** only `K Time we can go for` text that is a real, interpretable
  date/time (e.g. `28 aug interview`, `2026-08-28`, `2026-08-29 11:00 AM`) is
  shown as a **confirmed** Upcoming Interview. Text like `next round`,
  `Tuesday`, `45 days`, `1 month` is shown under **Pending Scheduling** instead.
  No interview date is ever invented.

## Apps Script setup

1. In the Google Sheet: **Extensions → Apps Script**.
2. Paste the contents of `Code.gs` (replace any existing code).
3. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (or Anyone with a Google account)
4. Copy the generated URL ending in `/exec`.
5. **Important:** each time you change `Code.gs`, publish a **new version**
   (Deploy → Manage deployments → Edit → New version → Deploy), otherwise the
   old code keeps serving.

## Running the dashboard

Open `index.html` in a browser (double-click, or serve statically, e.g.
`python -m http.server`). First launch: paste the `/exec` URL in the banner or
via **Settings**. The URL is remembered in `localStorage`.

Auto-refreshes every ~45s; **Refresh** button forces an immediate reload
(bypasses cache). A "Last updated: <time>" indicator sits in the top bar.

Read-only API results are cached in-memory for ~24s so navigation, role-detail
opens, and view switches don't re-hit Google each time. Writes always go to the
server and invalidate the cache.

## Dark mode

Click the sun/moon button in the top bar to toggle light/dark. The choice is
remembered per-browser in `localStorage`.

## Sharing with teammates (host on your network)

The dashboard is plain static files + the Apps Script `/exec` URL (pre-filled as
the default, so teammates don't need to configure anything). To let other
machines on the same network use it:

1. Start the built-in server from this folder (on the machine hosting the sheet):
   ```
   node serve.js 8080
   ```
   (requires only Node.js — no dependencies.)
2. Note the **Network** URLs it prints (one per LAN IPv4), e.g.
   `http://192.168.1.10:8080`.
3. Share that URL with teammates — they open it in any browser on the same
   network and everything works; the Apps Script URL is already set by default.

> Firewall note: Windows may prompt to allow `node` through the firewall on
> first run — click Allow. Also ensure the Waits/Sheet allows the Apps Script
> Web App to be called; access to the dashboard itself is via the URL above,
> which is open to anyone who can reach it on your network.

For access from anywhere (outside your network) instead, deploy the same folder
to free static hosting (Netlify / Vercel / GitHub Pages) and share that URL.

## API reference (all GET, no credentials exposed)

| Action | Params | Returns |
|---|---|---|
| `dashboard` | — | `{ stats, roles, upcomingInterviews, interviews:{upcoming,pending,completed} }` |
| `roles` | — | Role list with live `applicantCount` |
| `roleapplicants` | `role` | Applicants for one role (pipeline source) |
| `applicants` | — | All applicants across all role tabs |
| `candidate` | `id` (Applicant ID) | One applicant's full record (all 5 reviews) |
| `interviews` | — | `{ upcoming, pending, completed, recentCompleted }` |
| `update` | `id`, `field`, `value` | Writes one field back to the correct sheet row |
| `addapplicant` | `role`, `name`, `email`, … | Appends a new applicant row to that role's tab |

`field` may be any of: `status`, `priority`, `time`, `ctc`, `experience`,
`reviewAnisha`, `review1..4`, `name`, `email`, `phone`, `resume`, `position`.

## File map

```
Code.gs        Apps Script backend (Roles + auto-detected role tabs, JSON API)
index.html     Single-page UI (no build step)
css/style.css  Theme & layout (light + dark)
js/api.js      Apps Script API client (with short-lived read cache)
js/app.js      Rendering, navigation, pipeline, editing, filters, refresh
serve.js       Optional no-dependency static server for sharing on your network
SETUP.md       This file
```

## UI structure

Navigation: **Dashboard · Roles · Applicants · Interviews**

- **Dashboard** — Open/Closed/Total stats, dynamic role cards + **Add Candidate**
  button, and a right-hand rail showing **Upcoming Interviews** at top with
  **Latest Completed** (past 5) below.
- **Roles** — full role-card grid.
- **Role detail** — role facts + a **table** of that role's applicants showing
  **Candidate, Status, Experience, CTC, Mobile** (click a row to open the
  candidate).
- **Applicants** — every applicant, with search (name/email/phone/ID/role) and
  role/department/status/priority filters, plus **Add Candidate**.
- **Interviews** — Upcoming / Pending Scheduling / Completed.
- **Candidate profile** — contact, application, all 5 review fields (empty ones
  show "Not reviewed"), and edit buttons that write back to Sheets.

## Adding a candidate from the website

The **Add Candidate** button opens a form. Pick the **role** (from the Roles
tab) and fill in details. On submit, Apps Script's `addapplicant` action writes
a new row to the **correct role's applicant tab** (auto-matching the numbered /
`(Responses)` tab name), auto-generates the next `Applicant ID`, and the count
and lists update. Only the chosen role's tab is touched — other tabs are never
modified.
