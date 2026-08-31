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
 *   A Role ID | B Role Title | C Department | D Status (Open/Closed)
 *   E Approval Stage | F Interview Kit | G Approval Owner
 *
 * APPLICANT TAB COLUMNS (single "Applicants" tab)
 *   A Applicant ID | B Full Name | C Email ID | D Phone Number
 *   E Position Applied For | F Resume/CV | G Total Years of Experience
 *   H CTC | I Priority | J Status | K Time we can go for
 *   L Review (Anisha) | M Interviewer Review 1 | N Interviewer Review 2
 *   O Interviewer Review 3 | P Interviewer Review 4
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
 *   ?action=calendarcreate/update/cancel -> create/reschedule/cancel an event
 *   ?action=addapplicant              -> append a new applicant row
 *   ?action=deletecandidate           -> delete an applicant row
 *
 * Note: there is no login / user / permission model. Everyone who can reach the
 * Web App sees everything and can edit everything. Nothing in this file exposes
 * credentials; the client only sees the /exec URL.
 */

var SETTINGS = {
  ROLES_TAB_NAME: "Roles",
  // All applicants live in ONE tab. The role an applicant applied for is read
  // from the "Position Applied For" column (E) - Role column (index 16) may
  // exist but is ignored/no longer required. Matching is fuzzy/insensitive.
  APP_TAB_NAME: "Applicants",
  ROLES_COLS: { id:0, title:1, department:2, status:3, approvalStage:4, interviewKit:5, approvalOwner:6 },
  APP_COLS: {
    applicantId:0, name:1, email:2, phone:3, position:4, resume:5,
    experience:6, ctc:7, priority:8, status:9, time:10,
    reviewAnisha:11, review1:12, review2:13, review3:14, review4:15
  },
  // Google Calendar / interview scheduling. CALENDAR_ID empty -> the Apps
  // Script account's default calendar is used. Events are referenced from a
  // dedicated "Interviews" tab (source of truth for scheduled interviews).
  INTERVIEWS_TAB_NAME: "Interviews",
  CALENDAR_ID: "",
  // Events tab: A Calendar Event ID | B Candidate | C Role | D Date | E Time
  //             F Duration (min) | G Interviewer Name | H Interviewer Email
  //             I Meet Link | J Status (active/cancelled) | K Notes
  INTERVIEWS_COLS: {
    eventId:0, candidate:1, role:2, date:3, time:4, duration:5,
    interviewer:6, interviewerEmail:7, meet:8, status:9, notes:10
  }
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
  var lastCol = Math.min(sh.getLastColumn(), 7);
  var data = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var C = SETTINGS.ROLES_COLS;
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var title = norm_(r[C.title]);
    if (!title) continue;
    out.push({
      id: norm_(r[C.id]),
      title: title,
      department: norm_(r[C.department]),
      status: norm_(r[C.status]).toLowerCase() === "closed" ? "closed" : "open",
      approvalStage: norm_(r[C.approvalStage]) || "(none)",
      interviewKit: isYes_(r[C.interviewKit]) ? "Complete" : "Incomplete",
      approvalOwner: norm_(r[C.approvalOwner])
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
    time: norm_(row[C.time]),
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
 * Interview parsing
 * ============================================================ */

// Decide if a "time we can go for" string represents a CONFIRMED interview
// date/time, vs open/relative scheduling info.
function parseInterview_(applicant) {
  var raw = applicant.time;
  var s = norm_(raw).toLowerCase();

  var CONFIRMED = /(20\d{2}-\d{1,2}-\d{1,2})|(\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\s+\d{4})|(\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\b)|((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\s+\d{1,2}(st|nd|rd|th)?\b)/i;
  // relative/ambiguous scheduling cues
  var RELATIVE = /(tues|wed|thur|fri|sat|sun|mon)|(\d+\s*(days?|weeks?|months?))|(1\s*month)|(next\s+(week|month))|(\btomorrow\b)|(\bnext\s+round\b)/i;

  if (s && CONFIRMED.test(s)) {
    return { kind: "confirmed", raw: raw, date: extractDate_(s), time: extractTime_(s) };
  }
  if (s && RELATIVE.test(s)) {
    return { kind: "pending", raw: raw, date: "", time: "" };
  }
  if (s) {
    // some text but not clearly a date -> treat as scheduling info
    return { kind: "pending", raw: raw, date: "", time: "" };
  }
  return { kind: "none", raw: "", date: "", time: "" };
}

function extractTime_(s) {
  var m = s.match(/(\d{1,2})(:\d{2})?\s*(am|pm)/);
  if (!m) return "";
  var h = parseInt(m[1], 10), min = m[2] ? m[2].slice(1) : "00";
  var ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return pad2_(h) + ":" + min + (ap ? " " + m[3] : "");
}

var MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
function extractDate_(s) {
  var m;
  m = s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + "-" + pad2_(m[2]) + "-" + pad2_(m[3]);
  m = s.match(/(\d{1,2})\s+([a-z]+)\w*\s+(\d{4})/);
  if (m && MONTHS[m[2]] != null) return m[3] + "-" + pad2_(MONTHS[m[2]]) + "-" + pad2_(m[1]);
  // "28 aug ..." (day + month anywhere in the string, current year)
  m = s.match(/(\d{1,2})(st|nd|rd|th)?\s+([a-z]+)\w*/);
  if (m && MONTHS[m[3]] != null) return new Date().getFullYear() + "-" + pad2_(MONTHS[m[3]]) + "-" + pad2_(m[1]);
  // "aug 28" form
  m = s.match(/([a-z]+)\w*\s+(\d{1,2})(st|nd|rd|th)?/);
  if (m && MONTHS[m[1]] != null) return new Date().getFullYear() + "-" + pad2_(MONTHS[m[1]]) + "-" + pad2_(m[2]);
  return "";
}

/* ============================================================
 * Aggregation
 * ============================================================ */

// Attach applicantCount to each role from the single Applicants tab
// (count rows whose Role column matches the role title).
function withCounts_(roles) {
  var all = readApplicants_();
  roles.forEach(function (r) {
    var n = 0;
    for (var j = 0; j < all.length; j++) {
      var a = all[j];
      if ((normTitle_(a.roleTitle) === normTitle_(r.title)) ||
          (r.id && norm_(a.roleTitle).toLowerCase() === norm_(r.id).toLowerCase())) n++;
    }
    r.applicantCount = n;
    r.tab = r.title;
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

  all.forEach(function (a) {
    var iv = parseInterview_(a);
    a._iv = iv;
    if (iv.kind === "confirmed") upcoming.push(interviewRow_(a, iv));
    else if (iv.kind === "pending") pending.push(interviewRow_(a, iv));
  });
  // completed = anyone with a status that signals done/hired/rejected already
  completed = all.filter(function (a) {
    return isCompleted_(a.status);
  }).map(function (a) { return interviewRow_(a, a._iv || { kind: "none", raw: "", date: "", time: "" }); });

  upcoming.sort(byDate_);
  // Order completed by interview/scheduling date, newest first (dated ones
  // first, then undated). recentCompleted = latest 5.
  completed.sort(byDateDesc_);

  return {
    stats: { openRoles: openRoles, closedRoles: closedRoles, totalApplicants: totalApplicants },
    roles: roles,
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

function byDate_(x, y) {
  var d = (x.date || "9999") + " " + (x.time || "");
  var e = (y.date || "9999") + " " + (y.time || "");
  return d.localeCompare(e);
}

function isCompleted_(status) {
  var s = norm_(status).toLowerCase();
  return s.indexOf("reject") !== -1 || s.indexOf("selected") !== -1 || s === "done" || s === "hired";
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
  status: "J", priority: "I", time: "K", ctc: "H", experience: "G",
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
 * Google Calendar + Interview scheduling
 * ============================================================
 * Uses the built-in CalendarApp service (no passwords stored; the Apps Script
 * runs as its own account). Interview events live on a Google Calendar and are
 * referenced from an "Interviews" tab in the sheet (Event ID, candidate, role,
 * date, time, interviewer, Meet link, status). CalendarApp must be authorized
 * on re-deploy.
 * ============================================================ */

function cal_() {
  var id = norm_(SETTINGS.CALENDAR_ID);
  return id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar();
}

function readInterviews_() {
  var sh = ss_().getSheetByName(SETTINGS.INTERVIEWS_TAB_NAME);
  var out = [];
  if (!sh) return out;
  var lastRow = sh.getLastRow();
  if (lastRow < 1) return out;
  var lastCol = Math.min(sh.getLastColumn(), 11);
  var data = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var C = SETTINGS.INTERVIEWS_COLS;
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!norm_(r[C.eventId]) && !norm_(r[C.candidate])) continue;
    out.push({
      eventId: norm_(r[C.eventId]),
      candidate: norm_(r[C.candidate]),
      role: norm_(r[C.role]),
      date: norm_(r[C.date]),
      time: norm_(r[C.time]),
      duration: parseInt(r[C.duration], 10) || 60,
      interviewer: norm_(r[C.interviewer]),
      interviewerEmail: norm_(r[C.interviewerEmail]),
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
    sh.getRange(1, 1, 1, 11).setValues([[
      "Calendar Event ID","Candidate","Role","Date","Time","Duration (min)",
      "Interviewer Name","Interviewer Email","Meet Link","Status","Notes"
    ]]);
  }
  var C = SETTINGS.INTERVIEWS_COLS;
  var row = ["", "", "", "", "", "", "", "", "", "", ""];
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
  if (ev.row) {
    sh.getRange(ev.row, 1, 1, 11).setValues([row]);
  } else {
    sh.getRange(sh.getLastRow() + 1, 1, 1, 11).setValues([row]);
  }
  return ev;
}

// Build a JS Date from "YYYY-MM-DD" + "HH:MM" (server-local time).
function eventDate_(date, time) {
  var d = String(date || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!d) return null;
  var t = String(time || "").match(/(\d{1,2})(:(\d{2}))?/);
  var h = t ? parseInt(t[1], 10) : 0, m = t && t[3] ? parseInt(t[3], 10) : 0;
  return new Date(parseInt(d[1], 10), parseInt(d[2], 10) - 1, parseInt(d[3], 10), h, m);
}

function toIso_(dt) {
  var p = function (n) { return ("0" + n).slice(-2); };
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate()) + " " + p(dt.getHours()) + ":" + p(dt.getMinutes());
}

function createCalendarEvent_(p) {
  var title = norm_(p.candidate) + (norm_(p.role) ? " - " + norm_(p.role) : "");
  if (!norm_(p.candidate)) throw new Error("candidate name required");
  if (!norm_(p.date)) throw new Error("interview date required");
  var start = eventDate_(p.date, p.time || "09:00");
  if (!start) throw new Error("invalid date: " + p.date);
  var dur = parseInt(p.duration, 10) || 60;
  var end = new Date(start.getTime() + dur * 60000);
  var cal = cal_();
  var opts = {};
  var guest = norm_(p.interviewerEmail || p.interviewer);
  if (guest) {
    try { opts.guests = guest; opts.sendInvites = false; } catch (e2) {}
  }
  var event = cal.createEvent(title, start, end, opts);
  var meet = meetLink_(event);
  var ev = {
    eventId: event.getId(),
    candidate: norm_(p.candidate),
    role: norm_(p.role),
    date: norm_(p.date),
    time: norm_(p.time || "09:00"),
    duration: dur,
    interviewer: norm_(p.interviewer),
    interviewerEmail: norm_(p.interviewerEmail),
    meet: meet,
    status: "active",
    notes: norm_(p.notes)
  };
  return saveInterviewRow_(ev);
}

function updateCalendarEvent_(p) {
  var id = p.id || p.eventId || "";
  if (!id) throw new Error("event id required");
  var ev = readInterviews_().filter(function (x) { return x.eventId === id; })[0];
  if (!ev) throw new Error("interview not found");
  var event;
  try { event = cal_().getEventById(id); } catch (e) { event = null; }
  if (event) {
    if (norm_(p.date) && norm_(p.time)) {
      var start = eventDate_(p.date, p.time);
      if (start) event.setTime(start, new Date(start.getTime() + (parseInt(p.duration, 10) || ev.duration) * 60000));
    }
    if (norm_(p.candidate) || norm_(p.role)) event.setTitle(norm_(p.candidate || ev.candidate) + (norm_(p.role || ev.role) ? " - " + norm_(p.role || ev.role) : ""));
  }
  // update the sheet reference row
  var merged = {
    eventId: id,
    candidate: norm_(p.candidate || ev.candidate),
    role: norm_(p.role || ev.role),
    date: norm_(p.date || ev.date),
    time: norm_(p.time || ev.time),
    duration: parseInt(p.duration, 10) || ev.duration,
    interviewer: norm_(p.interviewer === undefined ? ev.interviewer : p.interviewer),
    interviewerEmail: norm_(p.interviewerEmail === undefined ? ev.interviewerEmail : p.interviewerEmail),
    meet: ev.meet,
    status: ev.status,
    notes: norm_(p.notes === undefined ? ev.notes : p.notes),
    row: ev.row
  };
  return saveInterviewRow_(merged);
}

function cancelCalendarEvent_(p) {
  var id = p.id || p.eventId || "";
  if (!id) throw new Error("event id required");
  var ev = readInterviews_().filter(function (x) { return x.eventId === id; })[0];
  if (!ev) throw new Error("interview not found");
  var event;
  try { event = cal_().getEventById(id); } catch (e) { event = null; }
  if (event) event.deleteEvent();
  ev.status = "cancelled";
  ev.row = ev.row;
  saveInterviewRow_(ev);
  return { ok: true, eventId: id, status: "cancelled" };
}

function meetLink_(event) {
  try {
    var cd = event.getConferenceData();
    if (cd) {
      var eps = cd.getEntryPoints();
      for (var i = 0; i < eps.length; i++) {
        var u = eps[i].getUri();
        if (u && norm_(u).indexOf("meet.google.com") !== -1) return u;
      }
      if (eps.length) return eps[0].getUri();
    }
  } catch (e) {}
  return "";
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
      return json_({ applicants: allApplicants_(readRoles_()) });

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

    } else if (action === "calendar") {
      // Interviews scheduled in Google Calendar (source = Interviews tab).
      var evs = allInterviews_().filter(function (x) { return x.status !== "cancelled"; });
      evs.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
      var now = new Date();
      var upcoming = evs.filter(function (x) { return (x.date + " " + x.time) >= toIso_(now); });
      var past = evs.filter(function (x) { return (x.date + " " + x.time) < toIso_(now); });
      return json_({ events: evs, upcoming: upcoming, past: past });

    } else if (action === "calendarcreate") {
      cacheClear_();
      var ce = createCalendarEvent_(p);
      return json_({ ok: true, eventId: ce.eventId, event: ce });

    } else if (action === "calendarupdate") {
      cacheClear_();
      var ue = updateCalendarEvent_(p);
      return json_({ ok: true, eventId: ue.eventId, event: ue });

    } else if (action === "calendarcancel") {
      cacheClear_();
      return json_(cancelCalendarEvent_(p));

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
  row[C.time] = norm_(p.time);
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
