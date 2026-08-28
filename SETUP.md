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
- `F Interview Kit` (Complete/Incomplete) is no longer shown in the UI.

### `Users` tab (optional — enables named sign-in & permissions)

Add a tab named **`Users`** to control who can see and edit what. It is read by
Apps Script and **enforced on the server** (not just hidden in the UI).

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| User ID | Name | Role | Access | Assigned Roles | Review Column |
| HR01 | HR | HR | All | | |
| P001 | Person 1 | Interviewer | Assigned | Mission Planning Engineer, GNSS | Anisha |

- `D Access`:
  - `All` — full access: view everything, edit any field, **Add** and **Delete**
    candidates.
  - `Assigned` — interviewer: can **only view roles listed in `E Assigned Roles`**
    (comma/newline separated role titles, fuzzy-matched to tabs) and can **only
    edit the review field named in `F Review Column`**. Cannot add or delete.
- `F Review Column` maps a reviewer label to a sheet column:
  `Anisha` → Review (Anisha); `Interviewer 1..4` → Interviewer Review 1..4.
- On first load the dashboard asks you to **sign in**. Your choice is remembered
  in `localStorage`. **Add Candidate / Delete** buttons appear only for
  `Access: All` users; interviewers get a single **Edit Reviews** button limited
  to their assigned review column. Permissions are also enforced by Apps Script
  on every read/write.

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

On load you're asked to **sign in** (choose your name from the `Users` tab, or
use "Full access (temporary)" if the `Users` tab isn't created). Your access
level controls what you can see/edit. Use the name chip in the top bar to switch
or sign out.

A **"Open source sheet"** link is shown inside the loading animation that opens
the Google Sheet in a new tab.

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
> (Add Candidate, Latest Completed, **sign-in/permissions**, **Delete
> Candidate**) to work — the frontend is live on Pages, but a stale Apps Script
> deployment won't expose those endpoints (sign-in then falls back to a
> temporary full-access session).

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
| `users` | — | List of user IDs + names (for the sign-in dropdown) |
| `login` | `user` (ID or name) | The user's safe profile `{id, name, role, access, reviewField}` |
| `dashboard` | `user` | `{ stats, roles, upcomingInterviews, interviews:{upcoming,pending,completed} }` (filtered to visible roles) |
| `roles` | `user` | Role list (filtered to visible roles) with live `applicantCount` |
| `roleapplicants` | `role`, `user` | Applicants for one role; `denied:true` if not permitted |
| `applicants` | `user` | All applicants across the user's visible role tabs |
| `candidate` | `id`, `user` | One applicant's full record (all 5 reviews) |
| `interviews` | `user` | `{ upcoming, pending, completed, recentCompleted }` |
| `update` | `id`, `field`, `value`, `user` | Writes one field back (permission-checked) |
| `addapplicant` | `role`, `name`, `email`, …, `user` | Appends a new applicant row (HR only) |
| `deletecandidate` | `id`, `user` | Deletes the applicant's row from its tab (HR only) |

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
  show "Not reviewed"), and edit buttons that write back to Sheets. Buttons are
  permission-aware: HR sees all edits plus **Delete Candidate**; interviewers see
  only **Edit Reviews** for their assigned review column.

## Adding a candidate from the website

The **Add Candidate** button opens a form. Pick the **role** (from the Roles
tab) and fill in details. On submit, Apps Script's `addapplicant` action writes
a new row to the **correct role's applicant tab** (auto-matching the numbered /
`(Responses)` tab name), auto-generates the next `Applicant ID`, and the count
and lists update. Only the chosen role's tab is touched — other tabs are never
modified.
