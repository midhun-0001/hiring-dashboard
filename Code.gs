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
 *   ?action=addapplicant              -> append a new applicant row
 *   ?action=deletecandidate           -> delete an applicant row
 *
 * Note: there is no login / user / permission model. Everyone who can reach the
 * Web App sees everything and can edit everything. Nothing in this file exposes
 * credentials; the client only sees the /exec URL.
 */

// NOTE: this project is tracker-only — interview records are stored in the
// Interview Events sheet and no real Google Calendar events are created. The
// auto-completion logic in the tracker/calendar list action moves any record
// whose scheduled date+time has passed into the "past"/completed area.

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
  //             L Participants | M Candidate Email
  INTERVIEWS_COLS: {
    eventId:0, candidate:1, role:2, date:3, time:4, duration:5,
    interviewer:6, interviewerEmail:7, meet:8, status:9, notes:10, participants:11, candidateEmail:12
  },
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
  var lastCol = Math.min(sh.getLastColumn(), 13);
  var data = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var C = SETTINGS.INTERVIEWS_COLS;
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!norm_(r[C.eventId]) && !norm_(r[C.candidate])) continue;
    var parts = [];
    try { parts = JSON.parse(norm_(r[C.participants]) || "[]") || []; } catch (e) { parts = []; }
    out.push({
      eventId: norm_(r[C.eventId]),
      candidate: norm_(r[C.candidate]),
      candidateEmail: norm_(r[C.candidateEmail]),
      role: norm_(r[C.role]),
      date: norm_(r[C.date]),
      time: norm_(r[C.time]),
      duration: parseInt(r[C.duration], 10) || 60,
      interviewer: norm_(r[C.interviewer]),
      interviewerEmail: norm_(r[C.interviewerEmail]),
      participants: parts,
      meet: norm_(r[C.meet]),
      status: norm_(r[C.status]).toLowerCase() === "cancelled" ? "cancelled" : "active",
      notes: norm_(r[C.notes]),
      row: i + 1
    });
  }
  return out;
}

// All events in the Interviews tab (no per-user filtering).
function allInterviews_() {
  return readInterviews_();
}

// store/update a row in the Interviews tab by event row; if row is null, append.
function saveInterviewRow_(ev) {
  var sh = ss_().getSheetByName(SETTINGS.INTERVIEWS_TAB_NAME);
  if (!sh) sh = ss_().insertSheet(SETTINGS.INTERVIEWS_TAB_NAME);
  // ensure a header exists
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, 13).setValues([[
      "Calendar Event ID","Candidate","Role","Date","Time","Duration (min)",
      "Interviewer Name","Interviewer Email","Meet Link","Status","Notes","Participants","Candidate Email"
    ]]);
  } else if (sh.getLastColumn() < 13) {
    // legacy sheet without the later columns: backfill Participants (12) and
    // Candidate Email (13) headers without touching the first 11.
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var full = ["Calendar Event ID","Candidate","Role","Date","Time","Duration (min)",
      "Interviewer Name","Interviewer Email","Meet Link","Status","Notes","Participants","Candidate Email"];
    var colsToWrite = {};
    for (var ci = 0; ci < full.length; ci++) {
      if (!norm_(hdr[ci])) colsToWrite[ci] = full[ci];
    }
    Object.keys(colsToWrite).forEach(function (k) {
      try { sh.getRange(1, parseInt(k, 10) + 1, 1, 1).setValues([[colsToWrite[k]]]); } catch (e5) {}
    });
  }
  var C = SETTINGS.INTERVIEWS_COLS;
  var row = ["", "", "", "", "", "", "", "", "", "", "", "", ""];
  row[C.eventId] = ev.eventId;
  row[C.candidate] = ev.candidate;
  row[C.role] = ev.role;
  row[C.date] = ev.date;
  row[C.time] = ev.time;
  row[C.duration] = ev.duration;
  row[C.interviewer] = ev.interviewer;
  row[C.interviewerEmail] = ev.interviewerEmail;
  row[C.meet] = ev.meet;
  row[C.status] = ev.status;
  row[C.notes] = ev.notes;
  row[C.participants] = JSON.stringify(ev.participants || []);
  row[C.candidateEmail] = ev.candidateEmail;
  if (ev.row) {
    sh.getRange(ev.row, 1, 1, 13).setValues([row]);
  } else {
    sh.getRange(sh.getLastRow() + 1, 1, 1, 13).setValues([row]);
  }
  return ev;
}

function toIso_(dt) {
  var p = function (n) { return ("0" + n).slice(-2); };
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()) + " " + p(dt.getHours()) + ":" + p(dt.getMinutes());
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
    notes: norm_(p.notes)
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
      // Interview tracker listings. Classification is by DATE only: any record
      // whose selected date is before today -> "past" (completed); today and
      // future dates -> "upcoming". Nothing is pushed to Google Calendar.
      var evs = allInterviews_().filter(function (x) { return x.status !== "cancelled"; });
      evs.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
      var p2 = function (n) { return ("0" + n).slice(-2); };
      var today = new Date();
      var todayStr = today.getFullYear() + "-" + p2(today.getMonth() + 1) + "-" + p2(today.getDate());
      var upcoming = evs.filter(function (x) { return x.date >= todayStr; });
      var past = evs.filter(function (x) { return x.date < todayStr; });
      return json_({ events: evs, upcoming: upcoming, past: past });

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

    } else if (action === "interviewers") {
      return json_({ interviewers: readInterviewers_() });

    } else if (action === "intervieweradd") {
      cacheClear_();
      var iv = addInterviewer_(p.name, p.email);
      return json_({ ok: true, interviewer: iv, interviewers: readInterviewers_() });

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
 * (a Blob) plus text params. Uploaded resumes are stored in a Google Drive
 * folder ("Vyomic Resumes"), shared "anyone with the link can view", and the
 * resulting shareable link is stored in the applicant's Resume column (F).
 * ============================================================ */

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || "";

    if (action !== "uploadresume") {
      throw new Error("unknown action: " + action);
    }

    var fparam = (e && e.parameter) ? e.parameter.file : null;
    var blob = (fparam && typeof fparam.getBytes === "function") ? fparam : null;
    if (!blob) {
      // Fall back to the raw POST body if the browser didn't send a named blob.
      blob = (e && e.postData && e.postData.contents) ? Utilities.newBlob(e.postData.contents) : null;
    }
    if (!blob) throw new Error("no file received");

    var folder = getOrCreateFolder_("Vyomic Resumes");
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

// Find (or create) the Drive folder used to store uploaded resumes.
function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

