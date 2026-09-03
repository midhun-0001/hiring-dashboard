/**
 * HIRING MANAGEMENT DASHBOARD - Google Apps Script backend (JSON API only)
 *
 * MODEL  (matches the existing spreadsheet - source of truth)
 * ----------------------------------------------------------------------
 *  - A "Roles" master tab: one row per role.
 *  - ONE "Applicants" tab holding every applicant. The role an applicant
 *    applied for is read from the "Position Applied For" column (col E);
 *    matching to a Roles-tab title is fuzzy / case-insensitive.
 *
 * ROLES TAB COLUMNS
 *   A Role ID | B Role Title | C Status (Open/Closed) | D Assigned to
 *
 * APPLICANT TAB COLUMNS (single "Applicants" tab)
 *   A Applicant ID | B Full Name | C Email ID | D Phone Number
 *   E Position Applied For | F Resume/CV | G Total Years of Experience
 *   H CTC | I Priority | J Status
 *   K Review (Anisha) | L Interviewer Review 1 | M Interviewer Review 2
 *   N Interviewer Review 3 | O Interviewer Review 4
 *
 * NOTE: Applicant "Status" (col J) values are NEVER normalized or overwritten
 * automatically. The original sheet value is always preserved; the UI only
 * *displays* them (and may visually categorize them).
 *
 *
 * API (all GET + query params to avoid Apps Script CORS preflight)
 *   ?action=dashboard                 -> { stats, roles, upcomingInterviews }
 *   ?action=roles                     -> role cards (with applicantCount)
 *   ?action=roleapplicants&role=Title -> applicants for one role
 *   ?action=applicants                -> ALL applicants
 *   ?action=candidate&id=APP123       -> one applicant by Applicant ID
 *   ?action=interviews                -> upcoming / pending / completed
 *   ?action=update&id=APP123&field=status&value=.. -> update one field
 *   ?action=calendar                  -> scheduled interviews (upcoming / past)
 *   ?action=tracker                   -> interview tracker (upcoming / past, alias of calendar)
 *   ?action=trackercreate/update/cancel -> add/edit/remove a tracker record
 *   ?action=trackerresult&id=..&result=..&note=.. -> outcome of a finished interview
 *   ?action=addapplicant              -> append a new applicant row
 *   ?action=deletecandidate           -> delete an applicant row
 *
 * Note: there is no login / user / permission model. Everyone who can reach the
 * Web App sees everything and can edit everything. Nothing in this file exposes
 * credentials; the client only sees the /exec URL.
 */

// NOTE: this project is tracker-only — interview records are stored in the
// Interview Events sheet and no real Google Calendar events are created.
//
// UPCOMING vs COMPLETED IS DERIVED, NEVER STORED. interviewPhase_ compares
// date + time + duration against the clock on every read, so a record moves to
// Completed by itself the moment its slot ends. The Status column only ever
// holds active/cancelled. Result + Note (columns N and K) are written by the
// Completed list via ?action=trackerresult.

var SETTINGS = {
  ROLES_TAB_NAME: "Roles",
  // All applicants live in ONE tab. The role an applicant applied for is read
  // from the "Position Applied For" column (E) - Role column (index 16) may
  // exist but is ignored/no longer required. Matching is fuzzy/insensitive.
  APP_TAB_NAME: "Applicants",
  ROLES_COLS: { id:0, title:1, status:2, assignedTo:3 },
  APP_COLS: {
    applicantId:0, name:1, email:2, phone:3, position:4, resume:5,
    experience:6, ctc:7, priority:8, status:9,
    reviewAnisha:11, review1:12, review2:13, review3:14, review4:15
  },
  // Interview tracker. Records are stored in a dedicated "Interview Events"
  // tab (source of truth). No Google Calendar events are created. NOTE: must
  // NOT be an existing data tab. The sheet's "Interviews" tab holds a copy of
  // the applicant data, so we point at a separate "Interview Events" tab. This
  // tab is created on demand with the correct header.
  INTERVIEWS_TAB_NAME: "Interview Events",
  CALENDAR_ID: "",
  // Events tab: A Event ID | B Candidate | C Role | D Date | E Time
  //             F Duration (min) | G Interviewer Name | H Interviewer Email
  //             I Meet Link | J Status (active/cancelled) | K Notes
  //             L Participants | M Candidate Email | N Result
  // Upcoming vs completed is NOT stored - it is derived from Date+Time+Duration
  // against the current clock (see interviewPhase_).
  INTERVIEWS_COLS: {
    eventId:0, candidate:1, role:2, date:3, time:4, duration:5,
    interviewer:6, interviewerEmail:7, meet:8, status:9, notes:10,
    participants:11, candidateEmail:12, result:13
  },
  INTERVIEWS_WIDTH: 14,
  // Allowed values for the Result column, offered in the Completed list.
  INTERVIEW_RESULTS: ["Selected", "Rejected", "On hold", "No show"],
  // Interviewer directory. Source of the "Interviewer" dropdown options in the
  // tracker modal (name + email). A Name | B Email. New interviewers added from
  // the UI are persisted here so they appear in the dropdown next time.
  INTERVIEWERS_TAB_NAME: "Interviewers",
  INTERVIEWERS_COLS: { name:0, email:1 }
};

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function norm_(v) { return (v !== undefined && v !== null) ? String(v).trim() : ""; }
// Normalize a role/tab name for fuzzy matching: lowercase, drop numeric
// prefixes (e.g. "5. Mission Planning Engineer" -> "Mission Planning Engineer"),
// drop common Google Form suffixes and punctuation, collapse whitespace.
// Used ONLY for matching; the original sheet/tab names are never renamed.
function normTitle_(s) {
  return norm_(s)
    .toLowerCase()
    .replace(/^\s*\d+(\.|\)|\s)*\s*/, " ")   // leading number prefix: "5. " / "5) " / "5 "
    .replace(/\(responses\)/g, " ")
    .replace(/\((form responses)\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function pad2_(n) { return ("0" + n).slice(-2); }
function isYes_(v) { var s = norm_(v).toLowerCase(); return s==="yes"||s==="y"||s==="true"||s==="1"||s==="complete"||s==="done"||s==="set"; }
function text_(v) { return { value: String(v === undefined || v === null ? "" : v) }; }

/* ============================================================
 * Response cache - avoids re-reading every sheet on heavy views.
 * Dashboard/interviews results are cached for TTL seconds; any
 * write (update/add/delete/calendar) clears the cache so changes
 * appear on the next load.
 * ============================================================ */
var CACHE_KEY = "hiring_dashboard_v1";
var CACHE_EXPIRES = 30;

function cacheGet_() {
  try {
    var data = CacheService.getScriptCache().get(CACHE_KEY);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}
function cachePut_(obj) {
  try {
    CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(obj), CACHE_EXPIRES);
  } catch (e) {}
}
function cacheClear_() {
  try {
    CacheService.getScriptCache().remove(CACHE_KEY);
  } catch (e) {}
}

/* ============================================================
 * Field-name resolution
 * ============================================================ */

// Resolve any case/format variant of a field name to its canonical APP key
// (e.g. "reViEwAnIsHa" or "reviewanisa" -> "reviewAnisha"). Returns "" if none.
function canonField_(field) {
  var f = String(field || "").trim().toLowerCase();
  var keys = Object.keys(SETTINGS.APP_COLS);
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === f) return keys[i];
  }
  return "";
}

/* ============================================================
 * Roles tab
 * ============================================================ */

function readRoles_() {
  var sh = ss_().getSheetByName(SETTINGS.ROLES_TAB_NAME);
  if (!sh) return [];
  var lastRow = sh.getLastRow();
  if (lastRow < 1) return [];
  var lastCol = Math.min(sh.getLastColumn(), 5);
  var data = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var C = SETTINGS.ROLES_COLS;
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var title = norm_(r[C.title]);
    if (!title) continue;
    var owner = norm_(r[C.assignedTo]) || "(none)";
    out.push({
      id: norm_(r[C.id]),
      title: title,
      status: norm_(r[C.status]).toLowerCase() === "closed" ? "closed" : "open",
      assignedTo: owner,
      // kept for older clients that still read approvalStage
      approvalStage: owner
    });
  }
  return out;
}

// Locate a role row in the Roles sheet (1-based) by ID, then by title.
function locateRole_(id, title) {
  var sh = ss_().getSheetByName(SETTINGS.ROLES_TAB_NAME);
  if (!sh) return null;
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  var C = SETTINGS.ROLES_COLS;
  var data = sh.getRange(1, 1, lastRow, Math.min(sh.getLastColumn(), 4)).getValues();
  for (var i = 1; i < data.length; i++) {
    if (id && norm_(data[i][C.id]) === String(id).trim()) return { row: i + 1 };
  }
  for (var j = 1; j < data.length; j++) {
    if (title && norm_(data[j][C.title]) === String(title).trim()) return { row: j + 1 };
  }
  return null;
}

/* ============================================================
 * Applicant single-tab
 * ============================================================ */

// Map one raw row -> applicant object with meta. The role an applicant
// applied for is read from the "Position Applied For" column (E).
function mapApplicant_(row) {
  var C = SETTINGS.APP_COLS;
  var role = norm_(row[C.position]);
  return {
    id: norm_(row[C.applicantId]),
    name: norm_(row[C.name]),
    email: norm_(row[C.email]),
    phone: norm_(row[C.phone]),
    position: role,
    resume: norm_(row[C.resume]),
    experience: norm_(row[C.experience]),
    ctc: norm_(row[C.ctc]),
    priority: norm_(row[C.priority]),
    status: norm_(row[C.status]),
    reviewAnisha: norm_(row[C.reviewAnisha]),
    review1: norm_(row[C.review1]),
    review2: norm_(row[C.review2]),
    review3: norm_(row[C.review3]),
    review4: norm_(row[C.review4]),
    tab: SETTINGS.APP_TAB_NAME,
    role: role,
    roleTitle: role
  };
}

// Read the single "Applicants" tab (row numbers preserved for updates).
function readApplicants_() {
  var sh = ss_().getSheetByName(SETTINGS.APP_TAB_NAME);
  var out = [];
  if (!sh) return out;
  var lastRow = sh.getLastRow();
  if (lastRow < 1) return out;
  var lastCol = sh.getLastColumn();
  var data = sh.getRange(1, 1, lastRow, lastCol).getValues();
  for (var i = 1; i < data.length; i++) {
    var a = mapApplicant_(data[i]);
    if (!a.name && !a.id) continue; // skip fully-blank rows
    a.row = i + 1; // real sheet row (row 1 = header)
    out.push(a);
  }
  return out;
}

// Backward-compat alias (tab is ignored - there is a single Applicants tab).
function readTab_(tab) { return readApplicants_(); }

// Return the list of allowed Status values from the sheet's data-validation
// dropdown on the Status column (column J), so the website shows exactly the
// same options as the sheet. Falls back to the distinct Status values actually
// present in the data if no validation list is configured.
function statusOptions_() {
  var sh = ss_().getSheetByName(SETTINGS.APP_TAB_NAME);
  var out = [];
  if (sh) {
    try {
      var lastRow = Math.max(sh.getLastRow(), 2);
      var statusCol = SETTINGS.APP_COLS.status + 1; // 1-based column letter index
      var dvs = sh.getRange(2, statusCol, lastRow - 1, 1).getDataValidations();
      for (var i = 0; i < dvs.length; i++) {
        var dv = dvs[i][0];
        if (!dv) continue;
        var crit = dv.getCriteriaValues();
        if (crit && crit[0]) {
          if (Array.isArray(crit[0])) {
            out = crit[0].slice();
          } else if (crit[0].getValues && typeof crit[0].getValues === "function") {
            var vals = crit[0].getValues();
            for (var r = 0; r < vals.length; r++) out.push(String(vals[r][0]));
          }
          break;
        }
      }
    } catch (e) { out = []; }
  }
  if (!out.length) {
    var seen = {};
    readApplicants_().forEach(function (a) {
      var s = norm_(a.status);
      if (s && !seen[s]) { seen[s] = true; out.push(s); }
    });
  }
  out = out.filter(function (s) { return norm_(s) !== ""; });
  out.sort(function (a, b) { return String(a).localeCompare(String(b)); });
  return out;
}

// Read the interviewer directory (Name + Email). Used to build the tracker
// modal's "Interviewer" dropdown options. The tab is created on demand with a
// header if missing.
function readInterviewers_() {
  var sh = ss_().getSheetByName(SETTINGS.INTERVIEWERS_TAB_NAME);
  if (!sh) {
    sh = ss_().insertSheet(SETTINGS.INTERVIEWERS_TAB_NAME);
    sh.getRange(1, 1, 1, 2).setValues([["Interviewer Name", "Interviewer Email"]]);
  }
  var out = [];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return out;
  var data = sh.getRange(1, 1, lastRow, 2).getValues();
  for (var i = 1; i < data.length; i++) {
    var name = norm_(data[i][0]);
    if (!name) continue;
    out.push({ name: name, email: norm_(data[i][1]) });
  }
  return out;
}

// Add (or update) an interviewer in the directory; returns the saved entry.
// Matching is case-insensitive on the name to avoid duplicates.
function addInterviewer_(name, email) {
  var n = norm_(name);
  if (!n) throw new Error("interviewer name required");
  var sh = ss_().getSheetByName(SETTINGS.INTERVIEWERS_TAB_NAME);
  if (!sh) readInterviewers_(); // creates the tab + header
  sh = ss_().getSheetByName(SETTINGS.INTERVIEWERS_TAB_NAME);
  var emailVal = norm_(email);
  var list = readInterviewers_();
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].name).toLowerCase() === n.toLowerCase()) {
      // existing interviewer: refresh the email.
      sh.getRange(i + 2, 2, 1, 1).setValue(emailVal);
      return { name: list[i].name, email: emailVal };
    }
  }
  sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setValues([[n, emailVal]]);
  return { name: n, email: emailVal };
}

// Resolve a role name (title, id, or tab-like name) to a Roles-tab title,
// falling back to the raw input. Matching is fuzzy / case-insensitive.
function resolveRoleTitle_(role) {
  var roles = readRoles_();
  var s = norm_(role);
  if (!s) return "";
  for (var i = 0; i < roles.length; i++) {
    var r = roles[i];
    if (norm_(r.id).toLowerCase() === s.toLowerCase()) return r.title;
    if (normTitle_(r.title) === normTitle_(s)) return r.title;
  }
  return s;
}

/* ============================================================
 * Aggregation
 * ============================================================ */

// Attach applicantCount ("in process" = total minus rejected) to each role
// from the single Applicants tab (count rows whose Role column matches the role
// title, excluding rejected/backed-out ones) plus lastActivityRow, then order
// roles dynamically: more in-process applicants first, ties broken by the most
// recent applicant (higher sheet row = more recently added/updated).
function withCounts_(roles) {
  var all = readApplicants_();
  roles.forEach(function (r) {
    var n = 0, lastRow = 0;
    for (var j = 0; j < all.length; j++) {
      var a = all[j];
      if ((normTitle_(a.roleTitle) === normTitle_(r.title)) ||
          (r.id && norm_(a.roleTitle).toLowerCase() === norm_(r.id).toLowerCase())) {
        if (isRejected_(a.status)) continue; // excluded from the in-process count
        n++;
        if (a.row && a.row > lastRow) lastRow = a.row;
      }
    }
    r.applicantCount = n;
    r.lastActivityRow = lastRow;
    r.tab = r.title;
  });
  roles.sort(function (x, y) {
    var dx = (y.applicantCount || 0) - (x.applicantCount || 0); // primary: more applicants
    if (dx !== 0) return dx;
    return (y.lastActivityRow || 0) - (x.lastActivityRow || 0); // tie-break: most recent
  });
  return roles;
}

function buildDashboard_() {
  var roles = withCounts_(readRoles_());
  var openRoles = 0, closedRoles = 0;
  roles.forEach(function (r) {
    if (r.status === "open") openRoles++; else closedRoles++;
  });

  var all = allApplicants_(roles);
  var totalApplicants = all.length;
  var upcoming = [], pending = [], completed = [];

  // The "Time we can go for" column was removed from the sheet, so no upcoming /
  // pending interview info is derived from applicants any more (always empty).
  // completed = anyone with a status that signals done/hired/rejected already
  completed = all.filter(function (a) {
    return isCompleted_(a.status);
  }).map(function (a) { return interviewRow_(a, { kind: "none", raw: "", date: "", time: "" }); });
  // Order completed by interview/scheduling date, newest first (dated ones
  // first, then undated). recentCompleted = latest 5.
  completed.sort(byDateDesc_);

  return {
    stats: { openRoles: openRoles, closedRoles: closedRoles, totalApplicants: totalApplicants },
    roles: roles,
    statusOptions: statusOptions_(),
    upcomingInterviews: upcoming,
    interviews: {
      upcoming: upcoming,
      pending: pending,
      completed: completed,
      recentCompleted: completed.slice(0, 5)
    }
  };
}

function byDateDesc_(x, y) {
  var d = (x.date || "0000") + " " + (x.time || "");
  var e = (y.date || "0000") + " " + (y.time || "");
  return e.localeCompare(d);
}

function isCompleted_(status) {
  var s = norm_(status).toLowerCase();
  return s.indexOf("reject") !== -1 || s.indexOf("selected") !== -1 || s === "done" || s === "hired";
}

// True when an applicant's status marks them as rejected/backed-out.
function isRejected_(status) {
  var s = norm_(status).toLowerCase();
  return s.indexOf("reject") !== -1 || s.indexOf("backout") !== -1;
}

function interviewRow_(a, iv) {
  return {
    candidate: a.name,
    role: a.roleTitle,
    tab: a.tab,
    row: a.row,
    id: a.id,
    date: iv.date,
    time: iv.time,
    raw: iv.raw,
    interviewer: firstReview_(a),
    status: a.status,
    kind: iv.kind
  };
}

function firstReview_(a) {
  return a.review1 || a.reviewAnisha || a.review2 || a.review3 || a.review4 || "";
}

function allApplicants_(roles) {
  return readApplicants_();
}

/* ============================================================
 * Application -> sheet mapping helpers
 * ============================================================ */

var FIELD_MAP = {
  status: "J", priority: "I", ctc: "H", experience: "G",
  reviewAnisha: "L", review1: "M", review2: "N", review3: "O", review4: "P",
  name: "B", email: "C", phone: "D", position: "E", resume: "F",
  role: "E"
};

// Find the applicant row by Applicant ID (case-insensitive) in the single
// Applicants tab. Returns {tab, row} or null (tab is always the Applicants tab).
function locateApplicant_(id, preferredTab) {
  if (!id) return null;
  var list = readApplicants_();
  for (var j = 0; j < list.length; j++) {
    if (norm_(list[j].id).toLowerCase() === norm_(id).toLowerCase()) {
      return { tab: SETTINGS.APP_TAB_NAME, row: list[j].row };
    }
  }
  return null;
}

/* ============================================================
 * Interview tracker (Interview Events sheet)
 * ============================================================
 * Tracker-only: interview records live in the "Interview Events" tab of the
 * sheet (Event ID, candidate, role, date, time, duration, interviewer,
 * interviewer email, Meet link, status, notes, participants, candidate email).
 * No real Google Calendar events are created and no invite emails are sent.
 * ============================================================ */

function readInterviews_() {
  var sh = ss_().getSheetByName(SETTINGS.INTERVIEWS_TAB_NAME);
  var out = [];
  if (!sh) return out;
  var lastRow = sh.getLastRow();
  if (lastRow < 1) return out;
  var lastCol = Math.min(sh.getLastColumn(), SETTINGS.INTERVIEWS_WIDTH);
  var data = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var C = SETTINGS.INTERVIEWS_COLS;
  var nowS = nowStamp_();
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!norm_(r[C.eventId]) && !norm_(r[C.candidate])) continue;
    var parts = [];
    try { parts = JSON.parse(norm_(r[C.participants]) || "[]") || []; } catch (e) { parts = []; }
    var rec = {
      eventId: norm_(r[C.eventId]),
      candidate: norm_(r[C.candidate]),
      candidateEmail: norm_(r[C.candidateEmail]),
      role: norm_(r[C.role]),
      date: isoDate_(r[C.date]),
      time: isoTime_(r[C.time]),
      duration: parseInt(r[C.duration], 10) || 60,
      interviewer: norm_(r[C.interviewer]),
      interviewerEmail: norm_(r[C.interviewerEmail]),
      participants: parts,
      meet: norm_(r[C.meet]),
      status: norm_(r[C.status]).toLowerCase() === "cancelled" ? "cancelled" : "active",
      notes: norm_(r[C.notes]),
      result: norm_(r[C.result]),
      row: i + 1
    };
    rec.endsAt = interviewEndStamp_(rec);
    rec.phase = interviewPhase_(rec, nowS);
    out.push(rec);
  }
  return out;
}

// All events in the Interviews tab (no per-user filtering).
function allInterviews_() {
  return readInterviews_();
}

// store/update a row in the Interviews tab by event row; if row is null, append.
var INTERVIEW_HEADERS = [
  "Event ID", "Candidate", "Role", "Date", "Time", "Duration (min)",
  "Interviewer Name", "Interviewer Email", "Meet Link", "Status", "Notes",
  "Participants", "Candidate Email", "Result"
];

// Get (or create) the tracker sheet, guaranteeing the full header and that the
// Date/Time columns are formatted as plain text. Without the text format Sheets
// re-coerces every "2026-09-10" we write back into a date value.
function interviewSheet_() {
  var W = SETTINGS.INTERVIEWS_WIDTH;
  var sh = ss_().getSheetByName(SETTINGS.INTERVIEWS_TAB_NAME);
  var created = false;
  if (!sh) { sh = ss_().insertSheet(SETTINGS.INTERVIEWS_TAB_NAME); created = true; }

  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, W).setValues([INTERVIEW_HEADERS]);
    sh.setFrozenRows(1);
    created = true;
  } else {
    // Backfill any header cell that is blank (column A has historically been
    // empty) and any column added since the tab was made.
    var have = sh.getLastColumn();
    var hdr = sh.getRange(1, 1, 1, Math.max(have, 1)).getValues()[0];
    var wrote = false;
    for (var ci = 0; ci < W; ci++) {
      if (!norm_(hdr[ci])) {
        try { sh.getRange(1, ci + 1, 1, 1).setValue(INTERVIEW_HEADERS[ci]); wrote = true; } catch (e5) {}
      }
    }
    if (wrote && have < W) created = true; // widened -> (re)apply the text format
  }

  if (created) {
    try {
      var C = SETTINGS.INTERVIEWS_COLS;
      var rows = Math.max(sh.getMaxRows() - 1, 1);
      sh.getRange(2, C.date + 1, rows, 2).setNumberFormat("@"); // Date + Time
    } catch (e6) { /* formatting is best-effort */ }
  }
  return sh;
}

// store/update a row in the tracker tab by row number; if row is null, append.
function saveInterviewRow_(ev) {
  var W = SETTINGS.INTERVIEWS_WIDTH;
  var sh = interviewSheet_();
  var C = SETTINGS.INTERVIEWS_COLS;
  var row = [];
  for (var z = 0; z < W; z++) row.push("");
  row[C.eventId] = ev.eventId;
  row[C.candidate] = ev.candidate;
  row[C.role] = ev.role;
  row[C.date] = isoDate_(ev.date);   // always store canonical ISO text
  row[C.time] = isoTime_(ev.time);
  row[C.duration] = ev.duration;
  row[C.interviewer] = ev.interviewer;
  row[C.interviewerEmail] = ev.interviewerEmail;
  row[C.meet] = ev.meet;
  row[C.status] = ev.status;
  row[C.notes] = ev.notes || "";
  row[C.participants] = JSON.stringify(ev.participants || []);
  row[C.candidateEmail] = ev.candidateEmail;
  row[C.result] = ev.result || "";
  var target = ev.row || (sh.getLastRow() + 1);
  sh.getRange(target, 1, 1, W).setValues([row]);
  ev.row = target;
  ev.date = row[C.date];
  ev.time = row[C.time];
  ev.endsAt = interviewEndStamp_(ev);
  ev.phase = interviewPhase_(ev);
  return ev;
}

// Write just the Result + Note cells for one record. A targeted write so an
// inline edit in the Completed list can't clobber the rest of the row.
function setTrackerResult_(p) {
  var id = norm_(p.id || p.eventId);
  if (!id) throw new Error("interview id required");
  var ev = readInterviews_().filter(function (x) { return x.eventId === id; })[0];
  if (!ev) throw new Error("interview not found: " + id);

  var C = SETTINGS.INTERVIEWS_COLS;
  var sh = interviewSheet_();
  if (p.result !== undefined) {
    var want = norm_(p.result);
    if (want) {
      // accept only known values, case-insensitively, so the column stays clean
      var ok = "";
      SETTINGS.INTERVIEW_RESULTS.forEach(function (r) {
        if (r.toLowerCase() === want.toLowerCase()) ok = r;
      });
      if (!ok) throw new Error("unknown result: " + want);
      want = ok;
    }
    sh.getRange(ev.row, C.result + 1).setValue(want);
    ev.result = want;
  }
  if (p.note !== undefined || p.notes !== undefined) {
    var note = norm_(p.note !== undefined ? p.note : p.notes);
    sh.getRange(ev.row, C.notes + 1).setValue(note);
    ev.notes = note;
  }
  return ev;
}

function toIso_(dt) {
  var p = function (n) { return ("0" + n).slice(-2); };
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()) + " " + p(dt.getHours()) + ":" + p(dt.getMinutes());
}

/* ============================================================
 * Date / time normalisation for the tracker
 * ============================================================
 * THE BUG THIS FIXES: writing the string "2026-09-10" with setValues() lets
 * Sheets coerce the cell into a real date value. Reading it back yields a JS
 * Date, and norm_() turned that into "Wed Sep 10 2026 00:00:00 GMT+0530...".
 * Comparing that string against "2026-09-03" put every record in "upcoming"
 * forever ("W" > "2"), so nothing ever moved to Completed.
 * Every read now goes through isoDate_ / isoTime_, so both a real date value
 * and a text cell end up as "YYYY-MM-DD" / "HH:MM".
 * ============================================================ */

function isDate_(v) { return Object.prototype.toString.call(v) === "[object Date]"; }

function isoDate_(v) {
  if (v === null || v === undefined || v === "") return "";
  if (isDate_(v)) {
    if (isNaN(v.getTime())) return "";
    return v.getFullYear() + "-" + pad2_(v.getMonth() + 1) + "-" + pad2_(v.getDate());
  }
  var s = norm_(v);
  if (!s) return "";
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);           // ISO (what we write)
  if (m) return m[1] + "-" + pad2_(m[2]) + "-" + pad2_(m[3]);
  // Legacy hand-typed cells. Day-first, matching the sheet's en-IN locale;
  // only reachable for rows not written by this app.
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return m[3] + "-" + pad2_(m[2]) + "-" + pad2_(m[1]);
  var d = new Date(s);                                        // "Wed Sep 10 2026 ..."
  if (!isNaN(d.getTime())) return d.getFullYear() + "-" + pad2_(d.getMonth() + 1) + "-" + pad2_(d.getDate());
  return "";
}

function isoTime_(v) {
  if (v === null || v === undefined || v === "") return "";
  if (isDate_(v)) {
    if (isNaN(v.getTime())) return "";
    return pad2_(v.getHours()) + ":" + pad2_(v.getMinutes());
  }
  if (typeof v === "number") {
    // a time-only Sheets value is a fraction of a day
    var mins = Math.round(v * 24 * 60);
    return pad2_(Math.floor(mins / 60) % 24) + ":" + pad2_(mins % 60);
  }
  var s = norm_(v);
  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return "";
  var h = parseInt(m[1], 10);
  var ap = (s.match(/(am|pm)/i) || [])[1];
  if (ap) {
    ap = ap.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }
  if (h > 23) h = 23;
  return pad2_(h) + ":" + m[2];
}

// "YYYY-MM-DD HH:MM" for right now, in the script/sheet timezone. Comparable
// with the stamps produced by interviewEndStamp_ as plain strings.
function nowStamp_() {
  var n = new Date();
  return n.getFullYear() + "-" + pad2_(n.getMonth() + 1) + "-" + pad2_(n.getDate()) +
    " " + pad2_(n.getHours()) + ":" + pad2_(n.getMinutes());
}

// The moment an interview is over = date + time + duration. A record with no
// time is treated as running to the end of its day, so it flips to completed at
// midnight rather than at 00:00 of the same morning.
function interviewEndStamp_(ev) {
  var date = isoDate_(ev.date);
  if (!date) return "";
  var time = isoTime_(ev.time);
  var addMins = parseInt(ev.duration, 10) || 0;
  if (!time) { time = "23:59"; addMins = 0; }
  var hm = time.split(":");
  var d = new Date(
    parseInt(date.slice(0, 4), 10),
    parseInt(date.slice(5, 7), 10) - 1,
    parseInt(date.slice(8, 10), 10),
    parseInt(hm[0], 10),
    parseInt(hm[1], 10)
  );
  d = new Date(d.getTime() + addMins * 60000);
  return d.getFullYear() + "-" + pad2_(d.getMonth() + 1) + "-" + pad2_(d.getDate()) +
    " " + pad2_(d.getHours()) + ":" + pad2_(d.getMinutes());
}

// Which list a record belongs in. Date decides; nothing is stored.
function interviewPhase_(ev, nowS) {
  if (ev.status === "cancelled") return "cancelled";
  var end = interviewEndStamp_(ev);
  if (!end) return "upcoming";   // undated -> keep visible instead of losing it
  return end <= (nowS || nowStamp_()) ? "completed" : "upcoming";
}

function createTrackerRow_(p) {
  if (!norm_(p.candidate)) throw new Error("candidate name required");
  if (!norm_(p.date)) throw new Error("interview date required");
  var ev = {
    eventId: "TRK" + new Date().getTime() + Math.floor(Math.random() * 900 + 100),
    candidate: norm_(p.candidate),
    candidateEmail: norm_(p.candidateEmail),
    role: norm_(p.role),
    date: norm_(p.date),
    time: norm_(p.time || ""),
    duration: parseInt(p.duration, 10) || 60,
    interviewer: norm_(p.interviewer),
    interviewerEmail: norm_(p.interviewerEmail),
    participants: [],
    meet: "",
    status: "active",
    notes: norm_(p.notes),
    result: ""
  };
  return saveInterviewRow_(ev);
}

function updateTrackerRow_(p) {
  var id = p.id || p.eventId || "";
  if (!id) throw new Error("interview id required");
  var ev = readInterviews_().filter(function (x) { return x.eventId === id; })[0];
  if (!ev) throw new Error("interview not found");
  var merged = {
    eventId: id,
    candidate: norm_(p.candidate || ev.candidate),
    candidateEmail: norm_(p.candidateEmail === undefined ? ev.candidateEmail : p.candidateEmail),
    role: norm_(p.role || ev.role),
    date: norm_(p.date || ev.date),
    time: norm_(p.time || ev.time),
    duration: parseInt(p.duration, 10) || ev.duration,
    interviewer: norm_(p.interviewer === undefined ? ev.interviewer : p.interviewer),
    interviewerEmail: norm_(p.interviewerEmail === undefined ? ev.interviewerEmail : p.interviewerEmail),
    status: norm_(p.status === undefined ? ev.status : p.status) || "active",
    meet: ev.meet,
    notes: norm_(p.notes === undefined ? ev.notes : p.notes),
    result: norm_(p.result === undefined ? ev.result : p.result),
    row: ev.row
  };
  return saveInterviewRow_(merged);
}

function cancelTrackerRow_(p) {
  var id = p.id || p.eventId || "";
  if (!id) throw new Error("interview id required");
  var ev = readInterviews_().filter(function (x) { return x.eventId === id; })[0];
  if (!ev) throw new Error("interview not found");
  ev.status = "cancelled";
  ev.row = ev.row;
  saveInterviewRow_(ev);
  return { ok: true, eventId: id, status: "cancelled" };
}

/* ============================================================
 * HTTP handler
 * ============================================================ */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || "dashboard";

    if (action === "dashboard") {
      var cached = cacheGet_();
      if (cached) return json_(cached);
      var dash = buildDashboard_();
      cachePut_(dash);
      return json_(dash);

    } else if (action === "roles") {
      return json_(withCounts_(readRoles_()));

    } else if (action === "applicants") {
      return json_({ applicants: allApplicants_(readRoles_()), statusOptions: statusOptions_() });

    } else if (action === "roleapplicants") {
      var role = resolveRoleTitle_(p.role || p.title || "");
      var rlist = allApplicants_(readRoles_());
      var rmatched = rlist.filter(function (a) { return normTitle_(a.roleTitle) === normTitle_(role); });
      return json_({ role: role, tab: SETTINGS.APP_TAB_NAME, applicants: rmatched });

    } else if (action === "candidate") {
      var id = p.id || "";
      var tab = p.tab || "";
      var loc = tab ? findInTab_(tab, id) : locateApplicant_(id);
      if (!loc) throw new Error("candidate not found: " + id);
      var hit = readTab_(loc.tab).filter(function (a) { return a.row === loc.row; })[0];
      if (!hit) throw new Error("candidate not found");
      return json_(hit);

    } else if (action === "interviews") {
      var ics = cacheGet_();
      return json_(ics ? ics.interviews : buildDashboard_().interviews);

    } else if (action === "update") {
      cacheClear_();
      var uid = p.id || "";
      var field = p.field || p.col || "";
      var val = p.value !== undefined ? p.value : "";
      var utab = p.tab || "";
      var loc = utab ? findInTab_(utab, uid) : locateApplicant_(uid);
      if (!loc) throw new Error("applicant not found: " + uid);
      var cfield = canonField_(field) || field; // canonical APP key, or fall back to raw
      var letter = FIELD_MAP[cfield] || (String(cfield).length === 1 ? String(cfield).toUpperCase() : "");
      if (!letter) throw new Error("unknown field: " + field);
      var sh = ss_().getSheetByName(loc.tab);
      var row = sh.getRange(loc.row, 1, 1, sh.getLastColumn()).getValues()[0];
      row[letter.charCodeAt(0) - 65] = String(val);
      sh.getRange(loc.row, 1, 1, row.length).setValues([row]);
      return json_({ ok: true, tab: loc.tab, row: loc.row, field: field, value: String(val) });

    } else if (action === "addapplicant") {
      cacheClear_();
      var arole = resolveRoleTitle_(p.role || "");
      var ash = ss_().getSheetByName(SETTINGS.APP_TAB_NAME);
      if (!ash) throw new Error("no Applicants tab found");
      p.role = arole;
      var data = addApplicant_(ash, p);
      return json_({ ok: true, tab: SETTINGS.APP_TAB_NAME, row: data.row, id: data.id, applicant: data.applicant });

    } else if (action === "deletecandidate") {
      cacheClear_();
      var did = p.id || "";
      var dtab = p.tab || "";
      var dloc = dtab ? findInTab_(dtab, did) : locateApplicant_(did);
      if (!dloc) throw new Error("candidate not found: " + did);
      ss_().getSheetByName(dloc.tab).deleteRow(dloc.row);
      return json_({ ok: true, tab: dloc.tab, row: dloc.row, id: did });

    } else if (action === "tracker" || action === "calendar") {
      // The interview's own Date (+ Time + Duration) decides the list:
      // still to come -> "upcoming"; already finished -> "past" (Completed).
      // Nothing is stored, so a record moves across on its own as time passes.
      var nowS = nowStamp_();
      var evs = allInterviews_().filter(function (x) { return x.status !== "cancelled"; });
      var upcoming = [], past = [];
      evs.forEach(function (x) {
        x.phase = interviewPhase_(x, nowS);
        (x.phase === "completed" ? past : upcoming).push(x);
      });
      var startKey = function (x) { return (x.date || "9999-99-99") + " " + (x.time || "99:99"); };
      upcoming.sort(function (a, b) { return startKey(a).localeCompare(startKey(b)); }); // soonest first
      past.sort(function (a, b) { return startKey(b).localeCompare(startKey(a)); });      // most recent first
      return json_({
        events: evs, upcoming: upcoming, past: past,
        now: nowS, results: SETTINGS.INTERVIEW_RESULTS
      });

    } else if (action === "trackercreate" || action === "calendarcreate") {
      cacheClear_();
      var ce = createTrackerRow_(p);
      return json_({ ok: true, eventId: ce.eventId, event: ce });

    } else if (action === "trackerupdate" || action === "calendarupdate") {
      cacheClear_();
      var ue = updateTrackerRow_(p);
      return json_({ ok: true, eventId: ue.eventId, event: ue });

    } else if (action === "trackercancel" || action === "calendarcancel") {
      cacheClear_();
      return json_(cancelTrackerRow_(p));

    } else if (action === "trackerresult") {
      // Result + Note for a finished interview, stored on the tracker row.
      cacheClear_();
      var re = setTrackerResult_(p);
      return json_({ ok: true, eventId: re.eventId, result: re.result, note: re.notes, event: re });

    } else if (action === "interviewers") {
      return json_({ interviewers: readInterviewers_() });

    } else if (action === "intervieweradd") {
      cacheClear_();
      var iv = addInterviewer_(p.name, p.email);
      return json_({ ok: true, interviewer: iv, interviewers: readInterviewers_() });

    } else if (action === "drivediag") {
      // Diagnostic: what Drive access does this deployment really have?
      return json_(driveDiag_());

    } else if (action === "resumefolder") {
      // Drive folder where uploaded resumes are stored, shared anyone-with-link,
      // so Settings can show the user where resumes go.
      var rFolder = getResumeFolderLink_();
      return json_({ ok: true, name: rFolder.name, url: rFolder.url });

    } else if (action === "rolesetstatus") {
      // Flip a role's open/closed Status in the Roles sheet (column C).
      cacheClear_();
      var rsStatus = String(norm_(p.status || "")).toLowerCase() === "closed" ? "closed" : "open";
      var rsId = norm_(p.id || "");
      var rsTitle = norm_(p.title || "");
      var rsLoc = locateRole_(rsId, rsTitle);
      if (!rsLoc) throw new Error("role not found: " + (rsTitle || rsId));
      var rsSheet = ss_().getSheetByName(SETTINGS.ROLES_TAB_NAME);
      rsSheet.getRange(rsLoc.row, SETTINGS.ROLES_COLS.status + 1, 1, 1).setValue(
        rsStatus === "closed" ? "Closed" : "Open"
      );
      return json_({ ok: true, row: rsLoc.row, status: rsStatus });

    } else {
      throw new Error("unknown action: " + action);
    }
  } catch (err) {
    return error_(err);
  }
}

function findInTab_(tab, id) {
  return locateApplicant_(id); // single Applicants tab; `tab` is ignored
}

function tabForRole_(role) {
  return resolveRoleTitle_(role);
}

// Generate the next Applicant ID: max existing numeric suffix + 1.
function nextApplicantId_() {
  var max = 0;
  readApplicants_().forEach(function (a) {
    var m = norm_(a.id).match(/app?\s*(\d+)/i);
    if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
  });
  return "APP" + pad2_(max + 1);
}

// Append a new applicant row to the single Applicants tab.
function addApplicant_(sh, p) {
  var C = SETTINGS.APP_COLS;
  var row = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];
  row[C.applicantId] = norm_(p.app && p.app.id ? p.app.id : nextApplicantId_());
  row[C.name] = norm_(p.name);
  row[C.email] = norm_(p.email);
  row[C.phone] = norm_(p.phone);
  row[C.position] = norm_(p.position || p.role);
  row[C.resume] = norm_(p.resume);
  row[C.experience] = norm_(p.experience);
  row[C.ctc] = norm_(p.ctc);
  row[C.priority] = norm_(p.priority);
  row[C.status] = norm_(p.status);
  row[C.reviewAnisha] = norm_(p.reviewAnisha);
  row[C.review1] = norm_(p.review1);
  row[C.review2] = norm_(p.review2);
  row[C.review3] = norm_(p.review3);
  row[C.review4] = norm_(p.review4);
  var newRow = sh.getLastRow() + 1;
  sh.getRange(newRow, 1, 1, 16).setValues([row]);
  var applicant = mapApplicant_(row);
  applicant.row = newRow;
  return { row: newRow, id: row[C.applicantId], applicant: applicant };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function error_(err) {
  return ContentService.createTextOutput(JSON.stringify({ error: String(err.message || err) })).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
 * File upload (POST) -> resume link
 * ============================================================
 * The web app accepts a multipart/form POST with a field named "file"
 * (a Blob) plus text params. Uploaded resumes are stored in a fixed Google Drive
 * folder (RESUME_FOLDER_ID), shared "anyone with the link can view", and the
 * resulting shareable link is stored in the applicant's Resume column (F).
 * ============================================================ */

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || "";

    if (action !== "uploadresume") {
      throw new Error("unknown action: " + action);
    }

    var blob = uploadBlob_(p);
    if (!blob) {
      throw new Error("no file received - the request carried no 'dataWebSafe' " +
        "or 'data' field. Apps Script cannot read a file out of a " +
        "multipart/form-data body; send the bytes as base64 instead.");
    }

    var folder = driveFolderOrThrow_();
    var candidateName = norm_(p.candidate || p.name || "");
    var ext = "";
    var m = /^(.+?)(\.[a-z0-9]{1,6})$/i.exec(norm_(p.filename || blob.getName() || ""));
    if (m) ext = m[2];
    var safeName = candidateName ? candidateName.replace(/[^a-z0-9 _-]+/gi, "_") : "resume";
    var fname = (safeName || "resume") + (ext || ".pdf");
    var file = folder.createFile(blob.setName(fname));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var url = file.getUrl();

    // If an applicant id was supplied, write the link straight to its Resume col.
    var id = p.id || "";
    if (id) {
      var loc = locateApplicant_(id);
      if (loc) {
        var sh = ss_().getSheetByName(loc.tab);
        sh.getRange(loc.row, SETTINGS.APP_COLS.resume + 1, 1, 1).setValue(url);
        cacheClear_();
      }
    }

    return json_({ ok: true, url: url, name: fname, fileId: file.getId() });
  } catch (err) {
    return error_(err);
  }
}

/* Turn the POST params into a Blob.
 * Apps Script cannot extract a file from a multipart/form-data body - the text
 * fields show up in e.parameter but the file never does, which is why a
 * FormData upload always failed with "no file received". The client therefore
 * sends the bytes as web-safe base64 in a form-urlencoded field. The standard
 * base64 and multipart branches are kept as fallbacks. */
function uploadBlob_(p) {
  var name = norm_(p.filename) || "resume";
  var type = norm_(p.mimeType) || "application/octet-stream";

  var ws = norm_(p.dataWebSafe);
  if (ws) return Utilities.newBlob(Utilities.base64DecodeWebSafe(ws), type, name);

  var std = norm_(p.data);
  if (std) {
    // tolerate a web-safe payload arriving in the plain field
    if (std.indexOf("-") !== -1 || std.indexOf("_") !== -1) {
      return Utilities.newBlob(Utilities.base64DecodeWebSafe(std), type, name);
    }
    return Utilities.newBlob(Utilities.base64Decode(std), type, name);
  }

  var f = p.file;
  if (f && typeof f.getBytes === "function") return f;   // never happens today
  return null;
}

/* Drive calls fail with "You do not have permission to call DriveApp..." when
 * the drive scope is not on the token. The usual cause is NOT a missing consent
 * click: it is an "oauthScopes" whitelist in appsscript.json that omits Drive,
 * so the scope is never requested and Google never prompts for it. Telling
 * people to "accept the prompt" in that state is a dead end - point at the
 * manifest instead. */
function driveFolderOrThrow_() {
  try {
    return resumeFolder_();
  } catch (err) {
    var msg = String(err && err.message ? err.message : err);
    if (msg.indexOf("permission") !== -1 || msg.indexOf("scope") !== -1 ||
        msg.indexOf("auth") !== -1) {
      throw new Error("Drive is not authorised for this Apps Script project. " +
        "This is almost always an oauthScopes whitelist in appsscript.json that " +
        "omits Drive - so no consent prompt ever appears. Fix: Apps Script editor > " +
        "Project Settings > show appsscript.json > delete the whole \"oauthScopes\" " +
        "block > save > run authorizeAll() and accept the prompt > Deploy a new " +
        "version. Run authorizeAll() for a per-service pass/fail report. " +
        "(Original: " + msg + ")");
    }
    throw err;
  }
}

// Google Drive folder where uploaded resumes are stored. Leave it as "" to let
// resumeFolder_ fall back to the folder the spreadsheet itself lives in.
var RESUME_FOLDER_ID = "16LUbWGPRZAHldrSAemMzoNY6ykaSjg-n";

function errMsg_(e) { return String(e && e.message ? e.message : e); }

/* Resolve a folder to drop resumes into, cheapest access first.
 *
 * The old version's first step was `getFoldersByName`, a Drive-WIDE SEARCH that
 * needs the broad drive/drive.readonly scope - the exact call that was failing.
 * It is gone. Every step below touches a single known file/folder instead, so
 * the upload works on a narrowly-scoped grant:
 *
 *   1. RESUME_FOLDER_ID              - one folder, by id
 *   2. the spreadsheet's own folder   - reuses the access we must already have
 *                                       to read the sheet at all
 *   3. My Drive root                  - last resort, always writable
 *
 * It also no longer swallows errors: the old `catch (e) { byId = null; }` hid
 * why step 1 failed, so a wrong folder id and a missing scope produced the
 * same misleading message. */
function resumeFolder_() {
  var tried = [];

  if (norm_(RESUME_FOLDER_ID)) {
    try { return DriveApp.getFolderById(RESUME_FOLDER_ID); }
    catch (e) { tried.push('getFolderById("' + RESUME_FOLDER_ID + '"): ' + errMsg_(e)); }
  } else {
    tried.push("RESUME_FOLDER_ID is empty - skipped");
  }

  try {
    var parents = DriveApp.getFileById(ss_().getId()).getParents();
    if (parents.hasNext()) return parents.next();
    tried.push("the spreadsheet has no parent folder");
  } catch (e2) {
    tried.push("spreadsheet's folder: " + errMsg_(e2));
  }

  try { return DriveApp.getRootFolder(); }
  catch (e3) { tried.push("getRootFolder: " + errMsg_(e3)); }

  throw new Error("No writable Drive folder found. Tried -> " + tried.join(" | "));
}

/**
 * ============================================================
 *  >>> RUN THIS ONCE FROM THE APPS SCRIPT EDITOR <<<
 * ============================================================
 * Pick `authorizeAll` in the function dropdown and press Run.
 *
 * Why: the consent screen only asks for permissions the code it can see
 * actually needs. This function touches every service the web app uses -
 * Spreadsheet, Drive and UrlFetch - in one go, so a single prompt covers all
 * of them. Accept it (Advanced > Go to project > Allow if it warns about an
 * unverified app), then create a NEW deployment.
 *
 * It prints a pass/fail line per service, so you can see what is still denied
 * without deploying anything.
 */
function authorizeAll() {
  var report = [];
  var sheetOk = false, driveOk = false, fetchOk = false;

  try {
    report.push("OK    Spreadsheet: " + ss_().getName());
    sheetOk = true;
  } catch (e) { report.push("FAIL  Spreadsheet: " + errMsg_(e)); }

  try {
    report.push("OK    Drive root: " + DriveApp.getRootFolder().getName());
    driveOk = true;
  } catch (e) { report.push("FAIL  Drive root: " + errMsg_(e)); }

  try {
    var f = resumeFolder_();
    report.push("OK    Resume folder: " + f.getName() + "  (" + f.getUrl() + ")");
  } catch (e) { report.push("FAIL  Resume folder: " + errMsg_(e)); }

  // Prove we can actually create + share a file, which is what upload does.
  try {
    var probe = resumeFolder_().createFile(
      Utilities.newBlob("upload permission probe", "text/plain", "vyomic-upload-probe.txt"));
    probe.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var url = probe.getUrl();
    probe.setTrashed(true);   // clean up after ourselves
    report.push("OK    Create + share a file: " + url + "  (probe trashed)");
  } catch (e) { report.push("FAIL  Create + share a file: " + errMsg_(e)); }

  try {
    UrlFetchApp.fetch("https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=" +
      encodeURIComponent(ScriptApp.getOAuthToken()), { muteHttpExceptions: true });
    report.push("OK    UrlFetch (used by ?action=drivediag)");
    fetchOk = true;
  } catch (e) { report.push("FAIL  UrlFetch: " + errMsg_(e)); }

  /* Interpret the pattern rather than leaving you to guess.
   * Spreadsheet OK while Drive AND UrlFetch are denied, with no consent prompt
   * shown, means the scopes were never REQUESTED - i.e. appsscript.json has an
   * "oauthScopes" whitelist listing only a Spreadsheet scope. Google cannot
   * prompt for a permission the script does not ask for, which is why granting
   * "all permissions" changes nothing. */
  report.push("");
  if (sheetOk && !driveOk && !fetchOk) {
    report.push("DIAGNOSIS: the scopes were never requested, so there was nothing to grant.");
    report.push("Spreadsheet works but Drive and UrlFetch are both denied, and you saw");
    report.push("no permission prompt. That means appsscript.json has an \"oauthScopes\"");
    report.push("whitelist containing only a Spreadsheet scope.");
    report.push("");
    report.push("FIX (30 seconds, in the Apps Script editor):");
    report.push("  1. Project Settings (gear, left sidebar)");
    report.push("  2. tick 'Show \"appsscript.json\" manifest file in editor'");
    report.push("  3. open appsscript.json from the Editor file list");
    report.push("  4. DELETE the whole \"oauthScopes\": [ ... ] block, including the");
    report.push("     trailing comma, then save (Ctrl+S)");
    report.push("  5. run authorizeAll again -> a consent prompt WILL appear -> Allow");
    report.push("     (if it warns 'unverified app': Advanced > Go to project > Allow)");
    report.push("");
    report.push("Removing the block lets Apps Script auto-detect scopes from the code.");
    report.push("DriveApp and UrlFetchApp are referenced here, so both get requested.");
    report.push("");
    report.push("Then: Deploy > New deployment > Web app, Execute as Me, Access Anyone,");
    report.push("and paste the new /exec URL into the dashboard's Settings.");
  } else if (driveOk && fetchOk) {
    report.push("All good - Drive and UrlFetch are authorised.");
    report.push("Next: Deploy > New deployment (Execute as Me, Access Anyone), then put");
    report.push("the new /exec URL in the dashboard's Settings.");
  } else {
    report.push("Partially authorised. Re-run after accepting any prompt; if a FAIL");
    report.push("above names a 'Required permissions' scope, that scope is missing from");
    report.push("appsscript.json - deleting the whole \"oauthScopes\" block is the");
    report.push("simplest fix, as it restores automatic scope detection.");
  }

  var text = report.join("\n");
  Logger.log(text);
  return text;
}

/* Report what Drive access this deployment actually has, instead of guessing.
 * Exposed as ?action=drivediag. Deliberately never returns the OAuth token -
 * only the list of scopes it carries. */
function driveDiag_() {
  var out = {};

  try { out.effectiveUser = Session.getEffectiveUser().getEmail(); }
  catch (e) { out.effectiveUser = "ERR: " + (e.message || e); }
  try { out.activeUser = Session.getActiveUser().getEmail(); }
  catch (e) { out.activeUser = "ERR: " + (e.message || e); }

  // Ask Google which scopes the running token was actually granted. This is the
  // ground truth - the editor's consent screen and the deployment's token can
  // and do disagree.
  try {
    var res = UrlFetchApp.fetch(
      "https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=" +
      encodeURIComponent(ScriptApp.getOAuthToken()),
      { muteHttpExceptions: true }
    );
    var info = JSON.parse(res.getContentText());
    out.grantedScopes = info.scope ? String(info.scope).split(/\s+/).sort() : info;
  } catch (e) {
    out.grantedScopes = "ERR: " + (e.message || e) +
      " (add https://www.googleapis.com/auth/script.external_request to the manifest)";
  }
  out.hasDriveScope = (out.grantedScopes && out.grantedScopes.join)
    ? out.grantedScopes.join(" ").indexOf("auth/drive") !== -1
    : "unknown";

  out.folderId = RESUME_FOLDER_ID;
  try {
    var f = DriveApp.getFolderById(RESUME_FOLDER_ID);
    out.getFolderById = { ok: true, name: f.getName(), url: f.getUrl() };
  } catch (e) {
    out.getFolderById = { ok: false, error: String(e.message || e) };
  }
  try {
    var parents = DriveApp.getFileById(ss_().getId()).getParents();
    out.sheetFolder = parents.hasNext()
      ? { ok: true, name: parents.next().getName() }
      : { ok: false, error: "spreadsheet has no parent folder" };
  } catch (e) {
    out.sheetFolder = { ok: false, error: String(e.message || e) };
  }
  try {
    out.rootFolder = { ok: true, name: DriveApp.getRootFolder().getName() };
  } catch (e) {
    out.rootFolder = { ok: false, error: String(e.message || e) };
  }
  // Which folder the upload would actually land in, given the above.
  try {
    var chosen = resumeFolder_();
    out.resolvedFolder = { ok: true, name: chosen.getName(), url: chosen.getUrl() };
  } catch (e) {
    out.resolvedFolder = { ok: false, error: String(e.message || e) };
  }
  return out;
}

// Return the Drive folder that uploaded resumes go into, shared "anyone with the
// link can view" so the Settings screen can show a link to it. Sharing the whole
// folder (view) is separate from per-file sharing done by doPost.
function getResumeFolderLink_() {
  var folder = driveFolderOrThrow_();
  try {
    var access = folder.getSharingAccess();
    var perm = folder.getSharingPermission();
    if (access !== DriveApp.Access.ANYONE_WITH_LINK) {
      folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }
  } catch (e) {
    // Drive may not expose sharing for some folder states; fall back silently.
  }
  return { name: folder.getName(), url: folder.getUrl() };
}

