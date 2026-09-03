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

| A | B | C | D |
|---|---|---|---|
| Role ID | Role Title | Status | Assigned to |
| R001 | Satellite Systems Engineer | Open | Palaniappan |
| R002 | Mechanical Engineering Lead | Open | Akshanth |

- `C Status` = `Open` or `Closed` → drives the Open/Closed card color and counts.
- `B Role Title` = matched against each applicant's `Position Applied For`.
- `D Assigned to` shows on the role card and in the role-detail header.

### No sign-in / permissions

There is **no Users tab and no login**. Anyone who can reach the dashboard and
the Apps Script Web App sees **everything** and can **edit everything** — every
role, every applicant, every field, Add Candidate, Delete, and interview
scheduling. The backend enforces no user or role checks (data is editable via the
dashboard by anyone with the link).

- Do **not** create a `Users` tab — it is not read by the backend and will be
  ignored by the auto role-tab detection.

### `Applicants` tab (one tab holding every applicant)

| A | B | C | D | E | F | G | H | I | J | K | L | M | N | O |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Applicant ID | Full Name | Email ID | Phone | Position Applied For | Resume/CV | Experience | CTC | Priority | Status | Review (Anisha) | Interviewer 1 | Interviewer 2 | Interviewer 3 | Interviewer 4 |
| APP001 | Vishalya | … | 8977026096 | Satellite Systems Engineer | … | 1.5 |  | 1* | next round | strong |  |  |  |  |

- **`A Applicant ID` is required.** The dashboard keys every read, edit and
  delete on it (`?action=candidate&id=`, `?action=update&id=`). Without it the
  backend reads every column one position to the left and nothing matches.
- `E Position Applied For` is matched fuzzily against `Roles!B Role Title`, so
  Google Form values like `Satellite Systems Engineer (Responses)` still resolve.

### `Interview Events` tab (created automatically)

The interview **tracker** stores a 14-column record in a tab named
**`Interview Events`**, created on first use:

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| Event ID | Candidate | Role | Date | Time | Duration (min) | Interviewer Name |

| H | I | J | K | L | M | N |
|---|---|---|---|---|---|---|
| Interviewer Email | Meet Link | Status | Notes | Participants | Candidate Email | Result |

It is tracker-only: no Google Calendar events are created.

**Upcoming vs Completed is derived, never stored.** `interviewPhase_` compares
`Date + Time + Duration` against the clock on every read, so a record moves to
**Completed** by itself the moment its slot ends — no manual status, no reload.
The `J Status` column only ever holds `active` / `cancelled` (cancelled rows are
hidden from both lists). A record with a date but no time is treated as running
to the end of that day, so it flips at midnight rather than at 00:00 that
morning. A record with no date at all stays in Upcoming so it can't get lost.

`D Date` and `E Time` are stored as **plain text** (`YYYY-MM-DD` and `HH:MM`)
and the columns are formatted as text on creation. This matters: if Sheets is
allowed to coerce them into real date values, reads come back as
`Wed Sep 10 2026 00:00:00 GMT+0530…` and every date comparison breaks. Reads go
through `isoDate_` / `isoTime_`, which recover either form.

**Result + Note** are the outcome of a finished interview, edited inline in the
Completed list and written by `?action=trackerresult&id=…&result=…&note=…`.
`Result` (column N) accepts `Selected`, `Rejected`, `On hold`, `No show`;
`Note` is free text stored in `K Notes`. Choosing `Rejected` also sets that
candidate's `Status` to `Rejected` on the `Applicants` tab.

Do not point `SETTINGS.INTERVIEWS_TAB_NAME` at a tab that already holds
applicant data — `saveInterviewRow_` overwrites whole rows.

### `Interviewers` tab (created automatically)

The tracker modal's **Interviewer** dropdown lists names from a two-column
**`Interviewers`** tab (`Interviewer Name | Interviewer Email`), created on first
use. From the modal you can pick an existing interviewer or choose **Add new
interviewer…** to persist a new name + email (via the `intervieweradd` action);
it then appears in the dropdown for every future interview.

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
- **Interviews:** the "Time we can go for" applicant column was removed from the
  sheet, so **no upcoming/pending interview info is derived from applicants**.
  Interviews are managed in the **Interview Tracker** (the `Interview Events`
  tab), which stores date/time/status per interview record.

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

### Granting Drive access (required for resume upload)

Resume upload writes to Google Drive, which needs the **Drive OAuth scope** on
the deployment. A Web App that was first authorised *before* the Drive code
existed keeps its older, narrower token, and every upload fails with:

```
You do not have permission to call DriveApp.getFoldersByName.
Required permissions: .../auth/drive.readonly || .../auth/drive
```

To fix it:

1. In the Apps Script editor: **Project Settings** → tick
   *Show "appsscript.json" manifest file in editor*.
2. Replace the manifest with the [`appsscript.json`](appsscript.json) in this
   repo — it declares `.../auth/spreadsheets` and `.../auth/drive` explicitly,
   so the consent screen always asks for Drive.
3. Pick any function (e.g. `getResumeFolderLink_`) and **Run** it once. Accept
   the Google permission prompt, including Drive.
4. **Deploy → Manage deployments → Edit → New version → Deploy.**

Verify with `<your /exec URL>?action=resumefolder` — it should return
`{"ok":true,"name":"Vyomic Resumes","url":"..."}` rather than a permission
error.

### How the file actually gets there

Apps Script **cannot read a file out of a `multipart/form-data` body.** With a
`FormData` POST the text fields do arrive in `e.parameter`, but the file never
does, so `doPost` answers `{"error":"no file received"}`. The client therefore
base64-encodes the bytes and posts them as a normal
`application/x-www-form-urlencoded` field (`dataWebSafe`), which Apps Script
parses into `e.parameter` like any other param, and `uploadBlob_` turns back
into a Blob. The encoding is **web-safe** base64 (`-` and `_` instead of `+`
and `/`, no padding) because those characters pass through URL encoding
unexpanded — standard base64 would inflate the payload by ~7%.

Uploads are capped client-side at **8 MB** (`API.MAX_RESUME_BYTES`).

## Running the dashboard

Open `index.html` in a browser (double-click, or serve statically, e.g.
`python -m http.server`). First launch: paste the `/exec` URL in the banner or
via **Settings**. The URL is remembered in `localStorage`.

There is **no sign-in** — the dashboard loads straight into the data for
everyone.

A loading animation (a looping satellite) shows while data is fetched; it
disappears once the first batch loads.

Auto-refreshes every ~45s; **Refresh** button forces an immediate reload
(bypasses cache). A "Last updated: <time>" indicator sits in the top bar.

Read-only API results are cached in-memory for ~24s so navigation, role-detail
opens, and view switches don't re-hit Google each time. Writes always go to the
server and invalidate the cache.

## Dark mode

Click the sun/moon button in the top bar to toggle light/dark. The choice is
remembered per-browser in `localStorage`.

## Sharing with teammates

### Option A — GitHub Pages (live now)
Repository: `github.com/midhun-0001/hiring-dashboard`
Live URL: **https://midhun-0001.github.io/hiring-dashboard/**

Anyone with the link can open the dashboard in any browser, on any network.
After editing local files, deploy by committing + pushing:
```
git add -A
git commit -m "update"
git push
```
GitHub Pages rebuilds automatically (it already serves this `master` branch root).

> **Privacy note:** this page and the Apps Script `/exec` URL are public. Anyone
> with the link can **read** the applicant data from the sheet. Writes happen only
> via the dashboard. Use host-on-your-network (Option B) or a private host if the
> data must stay internal.

> **Important:** the dashboard talks to your Apps Script Web App (`/exec` URL,
> embedded as the default in `js/api.js`). That Apps Script must be **deployed
> with the current `Code.gs`** (see Deploy section) for the newest features
> (Add Candidate, Latest Completed, **interview tracker**, **Delete Candidate**)
> to work — the frontend is live on Pages, but a stale Apps
> Script deployment won't expose those endpoints. After re-deploying, no Calendar
> OAuth scope is needed — interviews are tracker-only records in the sheet (no
> Google Calendar events are created).

### Option B — host on your network

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
| `tracker` | — | `{ events, upcoming, past, now, results }` — split by date, not by stored status |
| `trackerresult` | `id`, `result`, `note` | Writes Result (col N) + Note (col K) for one record |
| `dashboard` | — | `{ stats, roles, statusOptions, upcomingInterviews, interviews:{upcoming,pending,completed} }` |
| `roles` | — | Role list with live `applicantCount` |
| `roleapplicants` | `role` | Applicants for one role's tab |
| `applicants` | — | All applicants across every role tab (`{ applicants, statusOptions }`) |
| `candidate` | `id` | One applicant's full record (all 5 reviews) |
| `interviews` | — | `{ upcoming, pending, completed, recentCompleted }` |
| `calendar` | — | `{ events, upcoming, past }` from the `Interview Events` tab (tracker) |
| `tracker` | — | Alias of `calendar` — `{ events, upcoming, past }` |
| `trackercreate` | `candidate`,`candidateEmail`,`role`,`date`,`time`,`duration`,`interviewer`,`interviewerEmail`,`notes` | Adds a tracker record to the `Interview Events` tab (no calendar event) |
| `trackerupdate` | `id`, … | Updates an existing tracker record |
| `trackercancel` | `id` | Marks a tracker record cancelled (removed from lists) |
| `interviewers` | — | `{ interviewers:[{name,email}] }` from the `Interviewers` tab (lists the modal's Interviewer dropdown) |
| `intervieweradd` | `name`, `email` | Adds/updates an interviewer in the `Interviewers` tab; returns `{ interviewer, interviewers }` |
| `resumefolder` | — | Returns the Drive folder (`Vyomic Resumes`) where uploaded resumes are stored, shared anyone-with-link: `{ name, url }` |
| `update` | `id`, `field`, `value` | Writes one field back (no permission check) |
| `addapplicant` | `role`, `name`, `email`, … | Appends a new applicant row to the role's tab |
| `deletecandidate` | `id` | Deletes the applicant's row from its tab |

`field` may be any of: `status`, `priority`, `ctc`, `experience`,
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
  show "Not reviewed"), and edit buttons that write back to Sheets. **Edit Status,
  Priority, Time, CTC, Contact, Reviews and Delete Candidate are available to
  everyone** (no sign-in / permissions). In the **Interviews** tab, **Schedule**
  and **Edit / Cancel** are also available to everyone.

## Adding a candidate from the website

The **Add Candidate** button opens a form. Pick the **role** (from the Roles
tab) and fill in details. On submit, Apps Script's `addapplicant` action writes
a new row to the **correct role's applicant tab** (auto-matching the numbered /
`(Responses)` tab name), auto-generates the next `Applicant ID`, and the count
and lists update. Only the chosen role's tab is touched — other tabs are never
modified.
