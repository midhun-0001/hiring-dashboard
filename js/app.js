/* ============================================================
   Hiring Management Dashboard - application logic
   Reads everything live from Google Sheets via Apps Script.
   ============================================================ */

(function () {
  "use strict";

  var state = {
    dashboard: null,     // { stats, roles, upcomingInterviews, interviews }
    calendar: null,      // { events, upcoming, past } from the Interviews/calendar source
    allApplicants: [],   // global aggregated applicants
    currentView: "dashboard",
    currentRole: null,   // { title, status, department, ... }
    currentCandidate: null,
    currentIvSeg: "upcoming",
    filters: { search: "", role: "", dept: "", status: "", priority: "" }
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- helpers ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Visual status category -> {cls,label} WITHOUT changing the sheet value.
  // Categorization is display-only; the original cell text is never modified.
  function statusBadge(status) {
    var s = String(status || "").trim().toLowerCase();
    if (!s) return { cls: "badge-gray", label: "—" };
    if (s.indexOf("reject") !== -1 || s.indexOf("backout") !== -1) return { cls: "badge-red", label: status };
    if (s === "done" || s === "hired" || s === "selected" || s.indexOf("selected") !== -1) return { cls: "badge-green", label: status };
    if (s.indexOf("call done") !== -1 || s === "details" || s.indexOf("screen") !== -1) return { cls: "badge-blue", label: status };
    if (s.indexOf("final") !== -1) return { cls: "badge-green", label: status };
    if (s === "next round" || s.indexOf("psr") !== -1) return { cls: "badge-green", label: status };
    if (s.indexOf("cultural") !== -1 || s.indexOf("tech") !== -1 || s.indexOf("psr") !== -1) return { cls: "badge-blue", label: status };
    if (s.indexOf("pending") !== -1 || s.indexOf("hold") !== -1) return { cls: "badge-amber", label: status };
    return { cls: "badge-gray", label: status };
  }

  function openClose(status) {
    var s = String(status || "").toLowerCase();
    return s === "closed" ? { cls: "badge-gray", label: "Closed" } : { cls: "badge-green", label: "Open" };
  }

  function fmtTime(t) {
    if (!t) return "";
    var m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return t;
    var h = parseInt(m[1], 10), min = m[2], ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + min + " " + ap;
  }

  function fmtDate(d) {
    if (!d) return "";
    var m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return d;
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return months[parseInt(m[2], 10) - 1] + " " + parseInt(m[3], 10) + ", " + m[1];
  }

  function deptForRole(title) {
    var roles = (state.dashboard && state.dashboard.roles) || [];
    for (var i = 0; i < roles.length; i++) if (roles[i].title === title) return roles[i].department;
    return "";
  }

  function priorityLabel(p) {
    var s = String(p || "").trim();
    return s || "—";
  }

  function toast(msg, ms) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.add("hidden"); }, ms || 2200);
  }

  function showError(err) {
    var b = $("error-banner");
    $("error-text").textContent = String(err && err.message ? err.message : err);
    b.classList.remove("hidden");
  }

  /* Small inline loading indicator for containers that fetch data. */
  function inlineLoading(el, msg) {
    if (!el) return;
    el.innerHTML = '<div class="inline-loader"><span class="inline-spinner"></span>' +
      (msg ? '<span class="inline-loader-msg">' + esc(msg) + '</span>' : '') + '</div>';
  }

  /* ---------------- skeleton loaders ----------------
     Content-shaped placeholders for the landing page, so the stats row,
     roles grid and rail lists animate while the dashboard fetch is in
     flight instead of sitting empty. Cleared by the normal render calls. */

  function rep(n, html) {
    var out = "";
    for (var i = 0; i < n; i++) out += html;
    return out;
  }

  function skelOn(el, html) {
    if (!el) return;
    el.classList.add("skel-stagger");
    el.innerHTML = html;
  }
  function skelOff(el) {
    if (el) el.classList.remove("skel-stagger");
  }

  function skeletonStats() {
    skelOn($("stats"), rep(3,
      '<div class="stat-card skel-stat">' +
        '<div class="skel skel-line short"></div>' +
        '<div class="skel skel-line tall mid"></div>' +
      '</div>'));
  }

  function skeletonRoles(id, n) {
    skelOn($(id), rep(n || 6,
      '<div class="skel-role">' +
        '<div class="skel-role-head">' +
          '<div class="skel skel-line long"></div>' +
          '<div class="skel skel-badge"></div>' +
        '</div>' +
        '<div class="skel skel-line short"></div>' +
        '<div class="skel-role-meta">' +
          '<div class="skel skel-tag w1"></div>' +
          '<div class="skel skel-tag w2"></div>' +
          '<div class="skel skel-tag w3"></div>' +
        '</div>' +
      '</div>'));
  }

  function skeletonList(id, n) {
    skelOn($(id), rep(n || 3,
      '<div class="skel-list-item">' +
        '<div class="li-left">' +
          '<div class="skel skel-line long"></div>' +
          '<div class="skel skel-line short"></div>' +
        '</div>' +
        '<div class="skel skel-badge"></div>' +
      '</div>'));
  }

  function skeletonChart() {
    skelOn($("roles-chart"), rep(6,
      '<div class="chart-row">' +
        '<div class="skel skel-line mid"></div>' +
        '<div class="skel" style="height:10px;border-radius:999px;flex:1"></div>' +
      '</div>'));
  }

  /* Candidate profile: mirrors the four groups renderCandidate builds
     (Candidate / Application / Reviews / Interview) plus the action row. */
  function skeletonCandidate() {
    var groups = [7, 3, 5, 1];
    var html = groups.map(function (n) {
      return '<div class="cand-group skel-cand-group">' +
        '<h3><span class="skel skel-grouptitle"></span></h3>' +
        '<div class="cand-grid skel-stagger">' + rep(n,
          '<div class="skel-detail-item">' +
            '<div class="skel skel-line"></div>' +
            '<div class="skel skel-line long"></div>' +
          '</div>') +
        '</div></div>';
    }).join("");
    skelOn($("cand-sections"), html);

    skelOn($("cand-actions"),
      '<div class="skel skel-btn w1"></div>' +
      '<div class="skel skel-btn w2"></div>' +
      '<div class="skel skel-btn w1"></div>' +
      '<div class="skel skel-btn w3"></div>');

    $("cand-name").innerHTML = '<span class="skel skel-title"></span>';
    var badge = $("cand-role-badge");
    badge.textContent = "";
    badge.className = "badge skel";
  }

  /* Busy state for a modal while a write is in flight. Shows the orbiting
     satellite over the card and blocks the form so it can't be submitted twice. */
  function modalCard(modalId) {
    var m = $(modalId);
    return m ? m.querySelector(".modal-card") : null;
  }
  function modalBusy(modalId, msg) {
    var card = modalCard(modalId);
    if (!card || card.querySelector(".modal-busy-veil")) return;
    var veil = document.createElement("div");
    veil.className = "modal-busy-veil";
    veil.innerHTML = '<span class="mini-sat"><span class="orbit"><span class="sat"></span></span></span>' +
      '<div class="modal-busy-msg">' + esc(msg || "Saving…") + '</div>';
    card.appendChild(veil);
    card.querySelectorAll("button, input, select, textarea").forEach(function (el) { el.disabled = true; });
  }
  function modalIdle(modalId) {
    var card = modalCard(modalId);
    if (!card) return;
    var veil = card.querySelector(".modal-busy-veil");
    if (veil) veil.parentNode.removeChild(veil);
    card.querySelectorAll("button, input, select, textarea").forEach(function (el) { el.disabled = false; });
  }

  /* ---------------- config / banner ---------------- */

  function hideLoading() {
    var o = $("loading-overlay"); if (o) o.classList.add("hidden");
  }
  function showRoleLoader() {
    var o = $("role-loader"); if (o) o.classList.remove("hidden");
  }
  function hideRoleLoader() {
    var o = $("role-loader"); if (o) o.classList.add("hidden");
  }

  function applyConfigUI() {
    var ok = API.isConfigured();
    $("config-banner").classList.toggle("hidden", ok);
    if (ok) loadDashboard();
    else hideLoading(); // nothing to load yet -> show the connect banner
  }

  function openConfigModal() { $("config-input").value = API.getUrl(); $("config-modal").classList.remove("hidden"); }
  function closeModals() {
    ["config-modal", "edit-modal", "add-modal", "calendar-modal"].forEach(function (id) {
      modalIdle(id); // never leave a veil / disabled form behind for the next open
      $(id).classList.add("hidden");
    });
  }

  /* ---------------- view switching ---------------- */

  var VIEW_MAP = {
    dashboard: "view-dashboard",
    roles: "view-roles",
    applicants: "view-applicants",
    interviews: "view-interviews",
    "role-detail": "view-role-detail",
    candidate: "view-candidate"
  };

  function goView(name) {
    state.currentView = name;
    Object.keys(VIEW_MAP).forEach(function (k) { $(VIEW_MAP[k]).classList.toggle("hidden", k !== name); });
    document.querySelectorAll(".nav-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.view === name);
    });
    if (name === "dashboard") showRoleLoader(); // show the satellite again when landing
  }

  /* ---------------- data loading ---------------- */

  function setUpdated() {
    $("last-updated").textContent = "Last updated: " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function loadDashboard() {
    showRoleLoader();
    skeletonStats();
    skeletonChart();
    skeletonRoles("roles-grid", 6);
    skeletonRoles("roles-grid-2", 6);
    skeletonList("dashboard-upcoming", 3);
    skeletonList("dashboard-completed", 3);
    // Let the branded overlay play briefly, then hand off to the skeletons
    // so a slow fetch shows the page taking shape instead of a blank screen.
    setTimeout(hideLoading, 900);
    API.dashboard().then(function (data) {
      state.dashboard = data;
      renderStats(data.stats);
      renderRoleChart(data.roles);
      renderRoles("roles-grid", data.roles);
      renderRoles("roles-grid-2", data.roles);
      $("roles-count").textContent = data.roles.length + " role" + (data.roles.length === 1 ? "" : "s");
      $("roles-count-2").textContent = data.roles.length + " role" + (data.roles.length === 1 ? "" : "s");
      renderDashboardInterviews(data);
      setUpdated();
      hideLoading();
      setTimeout(hideRoleLoader, 900); // keep the satellite visible briefly on the landing page
      // refresh global applicants if applicants view is active/loaded
      if (state.allApplicants.length === 0 && state.currentView === "applicants") loadApplicantsLazy();
    }).catch(function () {
      hideLoading();
      hideRoleLoader();
      renderStats({ openRoles: 0, closedRoles: 0, totalApplicants: 0 });
      ["roles-grid", "roles-grid-2", "roles-chart", "dashboard-upcoming", "dashboard-completed"].forEach(function (id) { skelOff($(id)); });
      $("roles-grid").innerHTML = '<div class="empty">Could not load roles.</div>';
      $("roles-grid-2").innerHTML = '<div class="empty">Could not load roles.</div>';
      $("roles-chart").innerHTML = '<div class="empty">Could not load chart.</div>';
      $("dashboard-upcoming").innerHTML = '<div class="empty">Could not load interviews.</div>';
      $("dashboard-completed").innerHTML = '';
      showError(arguments[0]);
    });
  }

  // Horizontal bar chart: applicant count per role (top 10 by count), no libs.
  function renderRoleChart(roles) {
    var el = $("roles-chart");
    if (!el) return;
    skelOff(el);
    var countEl = $("chart-count");
    var list = (roles || []).slice();
    if (!list.length) { el.innerHTML = '<div class="empty">No roles yet.</div>'; return; }
    var top = list.slice().sort(function (a, b) { return (b.applicantCount || 0) - (a.applicantCount || 0); }).slice(0, 10);
    var max = 1;
    top.forEach(function (r) { var n = r.applicantCount || 0; if (n > max) max = n; });
    el.innerHTML = top.map(function (r) {
      var n = r.applicantCount || 0;
      var pct = Math.round(n / max * 100);
      var label = (r.title || "Unknown role");
      return '<div class="chart-row" title="' + esc(label) + '">' +
        '<div class="chart-label">' + esc(label) + '</div>' +
        '<div class="chart-track"><div class="chart-fill" style="width:' + (pct < 3 ? 3 : pct) + '%"></div></div>' +
        '<div class="chart-num">' + n + '</div>' +
      '</div>';
    }).join("");
    if (countEl && top.length < list.length) countEl.textContent = "Top " + top.length + " of " + list.length + " roles";
    else if (countEl) countEl.textContent = list.length + " role" + (list.length === 1 ? "" : "s");
  }

  function loadAllApplicants() {
    var body = $("applicants-body");
    var empty = $("applicants-empty");
    if (body) body.innerHTML = '<tr><td colspan="8"><div class="inline-loader"><span class="inline-spinner"></span><span class="inline-loader-msg">Loading applicants…</span></div></td></tr>';
    if (empty) empty.classList.add("hidden");
    API.applicants().then(function (data) {
      state.allApplicants = data.applicants || [];
      buildApplicantFilters();
      renderApplicants();
    }).catch(showError);
  }

  // load applicants lazily after dashboard (avoids two round-trips on load)
  var loadedApplicantsOnInit = false;
  function loadApplicantsLazy() {
    if (loadedApplicantsOnInit) return;
    loadedApplicantsOnInit = true;
    loadAllApplicants();
  }

  /* ---------------- stats ---------------- */

  function renderStats(s) {
    var cards = [
      { label: "Open Roles", value: s.openRoles || 0, color: "var(--green)" },
      { label: "Closed Roles", value: s.closedRoles || 0, color: "var(--muted)" },
      { label: "Total Applicants", value: s.totalApplicants || 0, color: "var(--brand)" }
    ];
    skelOff($("stats"));
    $("stats").innerHTML = cards.map(function (c) {
      return '<div class="stat-card"><div class="stat-label">' + c.label + '</div>' +
        '<div class="stat-value" style="color:' + c.color + '">' + c.value + '</div></div>';
    }).join("");
  }

  /* ---------------- roles grid ---------------- */

  function renderRoles(containerId, roles) {
    var el = $(containerId);
    skelOff(el);
    if (!roles || !roles.length) { el.innerHTML = '<div class="empty">No roles found in the Roles tab.</div>'; return; }
    el.innerHTML = roles.map(function (r) {
      var oc = openClose(r.status);
      return '<div class="role-card" data-title="' + esc(r.title) + '">' +
        '<div class="role-card-head"><div>' +
          '<div class="role-card-title">' + esc(r.title) + '</div>' +
          '<div class="dept">' + esc(r.department) + '</div>' +
        '</div><span class="badge ' + oc.cls + '">' + oc.label + '</span></div>' +
        '<div class="role-meta">' +
          '<span class="role-meta-tag"><strong>' + (r.applicantCount || 0) + '</strong> applicants</span>' +
          '<span class="role-meta-tag">Assigned to: ' + esc(r.assignedTo || r.approvalStage) + '</span>' +
        '</div></div>';
    }).join("");
    el.querySelectorAll(".role-card").forEach(function (card) {
      card.addEventListener("click", function () { openRoleDetail(card.dataset.title); });
    });
  }

  /* ---------------- role detail (pipeline) ---------------- */

  function openRoleDetail(title) {
    var roles = state.dashboard.roles;
    var role = null;
    roles.forEach(function (r) { if (!role && r.title === title) role = r; });
    if (!role) return;
    state.currentRole = role;
    $("rd-title").textContent = role.title;
    var oc = openClose(role.status);
    $("rd-status").className = "badge " + oc.cls;
    $("rd-status").textContent = oc.label;
    $("rd-facts").innerHTML =
      '<span>Status: ' + oc.label + '</span>' +
      '<span>Department: ' + esc(role.department) + '</span>' +
      '<span>Applicants: ' + (role.applicantCount || 0) + '</span>' +
      '<span>Assigned to: ' + esc(role.assignedTo || role.approvalStage) + '</span>';
    goView("role-detail");
    inlineLoading($("pipeline"), "Loading applicants…");
    API.roleApplicants(title).then(function (data) {
      renderPipeline(data.applicants || []);
    }).catch(showError);
  }

  function renderPipeline(applicants) {
    var el = $("pipeline");
    if (!applicants.length) { el.innerHTML = '<div class="empty">No applicants for this role yet.</div>'; return; }
    var rows = applicants.map(function (a) {
      var b = statusBadge(a.status);
      return '<tr class="clickable" data-id="' + esc(a.id) + '">' +
        '<td class="cell-primary">' + esc(a.name) + '</td>' +
        '<td>' + belle(a) + '</td>' +
        '<td>' + esc(a.experience || "—") + '</td>' +
        '<td>' + esc(a.ctc || "—") + '</td>' +
        '<td>' + esc(a.phone || "—") + '</td>' +
        '<td>' + (a.resume ? '<a href="' + esc(a.resume) + '" target="_blank" rel="noopener" class="resume-link" title="Open resume">View</a>' : "—") + '</td>' +
        '<td><input class="input pipe-review" data-id="' + esc(a.id) + '" value="' + esc(a.reviewAnisha || "") + '" placeholder="Short review…" title="Type a short review, then press Enter / click away to save" /></td>' +
      '</tr>';
    }).join("");
    el.innerHTML = '<div class="table-wrap"><table class="table">' +
      '<thead><tr><th>Candidate</th><th>Status</th><th>Experience</th><th>CTC</th><th>Mobile</th><th>Resume</th><th>Short Review</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
    el.querySelectorAll("tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function (e) {
        if (e.target && e.target.closest && (e.target.closest(".pipe-review") || e.target.closest(".resume-link"))) return;
        openCandidate(tr.dataset.id);
      });
    });
    el.querySelectorAll(".pipe-review").forEach(function (inp) {
      inp.addEventListener("click", function (e) { e.stopPropagation(); });
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
      inp.addEventListener("change", function () {
        var id = inp.dataset.id;
        API.update(id, "reviewAnisha", inp.value).then(function () {
          toast("Short review saved");
          loadDashboard();
          if (state.allApplicants.length) loadAllApplicants();
        }).catch(showError);
      });
    });
  }
  // small helper: status badge cell
  function belle(a) {
    var b = statusBadge(a.status);
    return '<span class="badge ' + b.cls + '">' + esc(b.label) + '</span>';
  }

  /* ---------------- dashboard interviews ---------------- */

  function renderDashboardInterviews(data) {
    var iv = (data && data.interviews) || {};
    var upcoming = iv.upcoming || (data.upcomingInterviews) || [];
    var completed = iv.recentCompleted || [];

    // Upcoming in the right rail
    var upEl = $("dashboard-upcoming");
    skelOff(upEl);
    if (!upcoming.length) {
      upEl.innerHTML = '<div class="empty">No confirmed upcoming interviews.</div>';
    } else {
      upEl.innerHTML = upcoming.map(function (i) {
        return '<div class="list-item" data-id="' + esc(i.id) + '">' +
          '<div class="li-left"><div class="li-name">' + esc(i.candidate) + '</div>' +
          '<div class="li-sub">' + esc(fmtDate(i.date)) + (i.time ? " · " + esc(fmtTime(i.time)) : "") + ' · ' + esc(i.role) + '</div></div>' +
          '<div class="li-right"><span class="badge badge-blue">' + (i.time ? esc(fmtTime(i.time)) : "Scheduled") + '</span></div>' +
        '</div>';
      }).join("");
      upEl.querySelectorAll(".list-item").forEach(function (it) {
        it.addEventListener("click", function () { openCandidate(it.dataset.id); });
      });
    }

    // Latest completed (past 5) below it
    var coEl = $("dashboard-completed");
    skelOff(coEl);
    if (!completed.length) {
      coEl.innerHTML = '<div class="empty">No completed applicants yet.</div>';
    } else {
      coEl.innerHTML = completed.map(function (i) {
        return '<div class="list-item" data-id="' + esc(i.id) + '">' +
          '<div class="li-left"><div class="li-name">' + esc(i.candidate) + '</div>' +
          '<div class="li-sub">' + esc(i.role) + (i.date ? " · " + esc(fmtDate(i.date)) : "") + '</div></div>' +
          '<div class="li-right"><span class="badge badge-green">' + esc(i.status || "Completed") + '</span></div>' +
        '</div>';
      }).join("");
      coEl.querySelectorAll(".list-item").forEach(function (it) {
        it.addEventListener("click", function () { openCandidate(it.dataset.id); });
      });
    }
  }

  /* ---------------- global applicants ---------------- */

  function buildApplicantFilters() {
    var roles = {}, depts = {}, statuses = {}, priorities = {};
    state.allApplicants.forEach(function (a) {
      if (a.roleTitle) roles[a.roleTitle] = true;
      var d = deptForRole(a.roleTitle);
      if (d) depts[d] = true;
      if (a.status) statuses[a.status] = true;
      if (a.priority) priorities[a.priority] = true;
    });
    $("filter-role").innerHTML = '<option value="">All roles</option>' + sortKeys(roles).map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join("");
    $("filter-dept").innerHTML = '<option value="">All departments</option>' + sortKeys(depts).map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join("");
    $("filter-status").innerHTML = '<option value="">All statuses</option>' + sortKeys(statuses).map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join("");
    $("filter-priority").innerHTML = '<option value="">All priorities</option>' + sortKeys(priorities).map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join("");
  }
  function sortKeys(map) { return Object.keys(map).sort(function (a, b) { return a.localeCompare(b); }); }

  function filteredApplicants() {
    var f = state.filters;
    var q = f.search.trim().toLowerCase();
    return state.allApplicants.filter(function (a) {
      if (q) {
        var hay = (a.name + " " + a.email + " " + a.phone + " " + a.id + " " + a.roleTitle + " " + a.position).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      if (f.role && a.roleTitle !== f.role) return false;
      if (f.dept) { var d = deptForRole(a.roleTitle); if (d !== f.dept) return false; }
      if (f.status && (a.status || "") !== f.status) return false;
      if (f.priority && (a.priority || "") !== f.priority) return false;
      return true;
    });
  }

  function renderApplicants() {
    var body = $("applicants-body");
    var empty = $("applicants-empty");
    var list = filteredApplicants();
    empty.classList.toggle("hidden", list.length !== 0);
    if (!list.length) { body.innerHTML = ""; return; }
    body.innerHTML = list.map(function (a) {
      var b = statusBadge(a.status);
      return '<tr class="clickable" data-id="' + esc(a.id) + '">' +
        '<td><div class="cell-primary">' + esc(a.name) + '</div><div class="cell-sub">' + esc(a.id || "") + '</div></td>' +
        '<td>' + esc(a.roleTitle) + '</td>' +
        '<td>' + esc(a.experience || "—") + '</td>' +
        '<td>' + esc(a.ctc || "—") + '</td>' +
        '<td>' + esc(priorityLabel(a.priority)) + '</td>' +
        '<td><span class="badge ' + b.cls + '">' + esc(b.label) + '</span></td>' +
        '<td>' + esc(a.time || "—") + '</td>' +
      '</tr>';
    }).join("");
    body.querySelectorAll("tr").forEach(function (tr) {
      tr.addEventListener("click", function () { openCandidate(tr.dataset.id); });
    });
  }

  /* ---------------- candidates ---------------- */

  function openCandidate(id) {
    skeletonCandidate();
    goView("candidate"); // switch immediately so the skeleton is what the click shows
    API.candidate(id).then(function (c) {
      state.currentCandidate = c;
      renderCandidate(c);
    }).catch(function (err) {
      skelOff($("cand-sections"));
      skelOff($("cand-actions"));
      $("cand-sections").innerHTML = '<div class="empty">Could not load this candidate.</div>';
      $("cand-actions").innerHTML = "";
      $("cand-name").textContent = "Candidate";
      $("cand-role-badge").className = "badge badge-blue";
      showError(err);
    });
  }

  function renderCandidate(c) {
    skelOff($("cand-sections"));
    skelOff($("cand-actions"));
    $("cand-name").textContent = c.name || "Candidate";
    $("cand-role-badge").className = "badge badge-blue";
    $("cand-role-badge").textContent = c.roleTitle || c.tab || "";
    $("cand-back-label").textContent = state.prevView === "role-detail" && state.currentRole ? state.currentRole.title : "Back";

    var sections = [];

    var contact = [
      edit("Full Name", "name", c.name),
      edit("Email", "email", c.email),
      edit("Phone", "phone", c.phone),
      edit("Resume / CV", "resume", c.resume),
      edit("Experience", "experience", c.experience),
      edit("CTC", "ctc", c.ctc),
      edit("Priority", "priority", c.priority)
    ];
    sections.push(group("Candidate", grid(contact)));

    var app = [
      item("Position Applied For", esc(c.roleTitle || c.position || "—")),
      edit("Current Status", "status", c.status),
      edit("Time we can go for", "time", c.time)
    ];
    sections.push(group("Application", grid(app)));

    var reviews = [
      edit("Review (Anisha)", "reviewAnisha", c.reviewAnisha, { rows: 3 }, "review"),
      edit("Interviewer Review 1", "review1", c.review1, { rows: 3 }, "review"),
      edit("Interviewer Review 2", "review2", c.review2, { rows: 3 }, "review"),
      edit("Interviewer Review 3", "review3", c.review3, { rows: 3 }, "review"),
      edit("Interviewer Review 4", "review4", c.review4, { rows: 3 }, "review")
    ];
    sections.push(group("Reviews", '<div class="cand-grid">' + reviews.join("") + '</div>'));

    // Interview info (derived from time/scheduling) - show sorted date if present
    var time = String(c.time || "").trim();
    var ivBadge;
    if (/20\d{2}-\d{1,2}-\d{1,2}/.test(time) || /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(time)) {
      ivBadge = '<span class="badge badge-blue">Scheduled</span>';
    } else if (time) {
      ivBadge = '<span class="badge badge-amber">Scheduling pending</span>';
    } else {
      ivBadge = '<span class="badge badge-gray">—</span>';
    }
    var intv = [ item("Interview / Scheduling", ivBadge + ' <span class="cell-sub">' + esc(time || "Not set") + '</span>') ];
    sections.push(group("Interview", grid(intv)));

    $("cand-sections").innerHTML = sections.join("");

    $("cand-actions").innerHTML = '<button class="btn btn-danger" id="cand-delete-btn">Delete Candidate</button>';
    var del = $("cand-delete-btn");
    if (del) del.addEventListener("click", function () {
      var name = (c.name || "").trim() || c.id;
      if (!window.confirm('Delete "' + name + '" permanently from the sheet?')) return;
      API.deleteCandidate(c.id).then(function () {
        toast("Deleted " + name);
        goBack();
        loadDashboard();
        if (state.allApplicants.length) loadAllApplicants();
      }).catch(showError);
    });

    goView("candidate");
  }

  function item(k, v) { return '<div class="detail-item"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
  // Editable text box inline in the detail card. On change the value is saved
  // straight to the sheet (no separate edit button / modal).
  function edit(k, key, val, opts, kind) {
    opts = opts || {};
    val = val || "";
    var box = opts.rows
      ? '<textarea class="input cedit" data-key="' + esc(key) + '" rows="' + opts.rows + '">' + esc(val) + '</textarea>'
      : '<input class="input cedit" data-key="' + esc(key) + '" type="text" value="' + esc(val) + '" />';
    var cls = kind === "review" ? "review-item" : "detail-item";
    return '<div class="' + cls + '"><div class="k">' + k + '</div><div class="v">' + box + '</div></div>';
  }
  function grid(items) { return '<div class="cand-grid">' + items.join("") + '</div>'; }
  function group(title, inner) { return '<div class="cand-group"><h3>' + title + '</h3>' + inner + '</div>'; }

  /* ---------------- interviews page ---------------- */

  function goInterviews(seg) {
    state.currentIvSeg = seg;
    document.querySelectorAll("#iv-seg .seg-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.iv === seg);
    });
    renderInterviewsPage();
  }

  // Scheduled interviews come from the Google Calendar-backed Interviews source.
  function loadInterviews() {
    API.calendar().then(function (data) {
      state.calendar = data;
      if (state.currentView === "interviews") renderInterviewsPage();
    }).catch(showError);
  }

  function renderInterviewsPage() {
    var el = $("interviews-body");
    if (!state.calendar) { inlineLoading(el, "Loading interviews…"); loadInterviews(); return; }

    var cal = state.calendar;
    var seg = state.currentIvSeg;
    var list, emptyMsg;
    if (seg === "pending") {
      list = (state.dashboard && state.dashboard.interviews && state.dashboard.interviews.pending) || [];
      emptyMsg = "No candidates awaiting scheduling.";
    } else if (seg === "completed") {
      list = cal.past || [];
      emptyMsg = "No completed interviews yet.";
    } else {
      list = cal.upcoming || cal.events || [];
      emptyMsg = "No upcoming interviews scheduled yet.";
    }

    if (!list.length) { el.innerHTML = '<div class="empty">' + esc(emptyMsg) + '</div>'; return; }

    var rows = list.map(function (i) {
      var canEdit = !!i.eventId;
      var statusBadgeCls = "badge-blue", statusLabel = "Scheduled";
      if (seg === "completed") { statusBadgeCls = "badge-green"; statusLabel = "Completed"; }
      if (seg === "pending") { statusBadgeCls = "badge-amber"; statusLabel = "Scheduling pending"; }

      var meet = "";
      if (i.meet) {
        meet = '<a href="' + esc(i.meet) + '" target="_blank" rel="noopener" class="meet-link" title="Open Google Meet">Meet</a>';
      }

      var action;
      if (i.eventId) {
        action = canEdit
          ? '<button class="btn btn-sm btn-ghost" data-edit-evt="' + esc(i.eventId) + '">Edit</button>'
          : '<span class="cell-sub">View</span>';
      } else if (seg === "pending") {
        action = '<button class="btn btn-sm btn-ghost" data-create-evt="' + esc(i.id || "") + '">Schedule</button>';
      } else {
        action = "";
      }

      return '<tr data-id="' + esc(i.id || "") + '">' +
        '<td class="cell-primary">' + esc(i.candidate) + '</td>' +
        '<td>' + esc(i.role || i.roleTitle || "—") + '</td>' +
        '<td>' + esc(fmtDate(i.date)) + '</td>' +
        '<td>' + esc(fmtTime(i.time)) + '</td>' +
        '<td>' + esc(i.interviewer || "—") + '</td>' +
        '<td>' + meet + '</td>' +
        '<td><span class="badge ' + statusBadgeCls + '">' + esc(statusLabel) + '</span></td>' +
        '<td>' + action + '</td>' +
      '</tr>';
    }).join("");

    el.innerHTML = '<table class="table"><thead><tr>' +
      '<th>Candidate</th><th>Role</th><th>Date</th><th>Time</th><th>Interviewer</th><th>Meet</th><th>Status</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    el.querySelectorAll("tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest("button")) return; // let action buttons handle it
        var evtId = tr.querySelector("[data-edit-evt]");
        if (evtId) { openCalendarModal(evtId.dataset.editEvt); return; }
        var create = tr.querySelector("[data-create-evt]");
        if (create) openCalendarModal(null, create.dataset.createEvt);
      });
    });
    el.querySelectorAll("[data-edit-evt]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); openCalendarModal(b.dataset.editEvt); });
    });
    el.querySelectorAll("[data-create-evt]").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); openCalendarModal(null, b.dataset.createEvt); });
    });
  }

  /* ---------------- calendar scheduling modal ---------------- */

  var calEditingId = null; // null = create mode, else an Interview tab row id (eventId)

  function findCalEvent(id) {
    var all = ((state.calendar && state.calendar.events) || []);
    for (var i = 0; i < all.length; i++) if (all[i].eventId === id) return all[i];
    return null;
  }

  function calendarSubmit() {
    var candidate = $("cal-candidate").value.trim();
    var role = $("cal-role").value;
    var date = $("cal-date").value;
    var time = $("cal-time").value;
    if (!candidate) { toast("Please enter the candidate name"); return; }
    if (!role) { toast("Please select a role"); return; }
    if (!date || !time) { toast("Please set the date and time"); return; }

    var fields = {
      candidate: candidate, role: role, date: date, time: time,
      duration: $("cal-duration").value,
      interviewer: $("cal-interviewer").value.trim(),
      interviewerEmail: $("cal-interviewer-email").value.trim(),
      notes: $("cal-notes").value.trim()
    };
    if (calEditingId) {
      API.calendarUpdate(calEditingId, fields).then(function () {
        closeModals(); toast("Interview updated on Google Calendar");
        API.refresh(); loadDashboard(); loadInterviews();
      }).catch(showError);
    } else {
      API.calendarCreate(fields).then(function () {
        closeModals(); toast("Interview scheduled on Google Calendar");
        API.refresh(); loadDashboard(); loadInterviews();
        if (state.currentView === "interviews") goInterviews("upcoming");
      }).catch(showError);
    }
  }

  function openCalendarModal(id, pendingId) {
    // populate role select
    var roles = (state.dashboard && state.dashboard.roles) || [];
    var sel = $("cal-role");
    sel.innerHTML = '<option value="">Select role…</option>' + roles.map(function (r) {
      return '<option value="' + esc(r.title) + '">' + esc(r.title) + '</option>';
    }).join("");

    $("cal-title").textContent = id ? "Edit Interview" : "Schedule Interview";
    $("cal-cancel").classList.toggle("hidden", !id);
    calEditingId = id || null;

    var ev = id ? findCalEvent(id) : null;
    var candidate = "", role = "", date = "", time = "", duration = "60", interviewer = "", email = "", meet = "", notes = "";
    if (ev) { candidate = ev.candidate; role = ev.role || ""; date = ev.date || ""; time = ev.time || ""; duration = ev.duration || "60"; interviewer = ev.interviewer || ""; email = ev.interviewerEmail || ""; meet = ev.meet || ""; notes = ev.notes || ""; }

    if (pendingId) {
      var cand = (state.allApplicants || []).filter(function (a) { return a.id === pendingId; })[0];
      if (cand) { candidate = cand.name; role = cand.roleTitle || ""; }
    }

    $("cal-candidate").value = candidate;
    $("cal-candidate").readOnly = !!ev;
    if (role) sel.value = role;
    $("cal-date").value = date;
    $("cal-time").value = time;
    $("cal-duration").value = duration;
    $("cal-interviewer").value = interviewer;
    $("cal-interviewer-email").value = email;
    $("cal-meet").value = meet;
    $("cal-meet").readOnly = !!ev;
    $("cal-notes").value = notes;

    $("calendar-modal").classList.remove("hidden");
  }

  function cancelInterview() {
    if (!calEditingId) return;
    var ev = findCalEvent(calEditingId) || {};
    if (!window.confirm('Cancel the interview with "' + (ev.candidate || "this candidate") + '"? This removes it from Google Calendar.')) return;
    API.calendarCancel(calEditingId).then(function () {
      closeModals(); toast("Interview cancelled");
      API.refresh(); loadDashboard(); loadInterviews();
    }).catch(showError);
  }

  /* ---------------- editing / sync ---------------- */

  var FIELD_MAP = {
    status: "J", priority: "I", time: "K", ctc: "H", experience: "G",
    reviewAnisha: "L", review1: "M", review2: "N", review3: "O", review4: "P",
    name: "B", email: "C", phone: "D", position: "E", resume: "F"
  };
  // friendly field name -> {label, schema for edit}
  function field(val) { return { value: val || "" }; }

  var EDIT_SCHEMAS = {
    status: {
      title: "Edit Status",
      hint: "You can type any value — it is written to the sheet as-is.",
      fields: [
        { key: "status", label: "Status", type: "text" }
      ]
    },
    priority: {
      title: "Edit Priority",
      fields: [ { key: "priority", label: "Priority", type: "text" } ]
    },
    time: {
      title: "Edit Time / Scheduling",
      hint: "e.g. 2026-08-29 11:00 AM (confirmed) or 'next week' (scheduling pending).",
      fields: [ { key: "time", label: "Time we can go for", type: "text" } ]
    },
    ctc: {
      title: "Edit CTC",
      fields: [ { key: "ctc", label: "CTC", type: "text" } ]
    },
    reviews: {
      title: "Edit Reviews",
      fields: [
        { key: "reviewAnisha", label: "Review (Anisha)", type: "textarea", rows: 3 },
        { key: "review1", label: "Interviewer Review 1", type: "textarea", rows: 3 },
        { key: "review2", label: "Interviewer Review 2", type: "textarea", rows: 3 },
        { key: "review3", label: "Interviewer Review 3", type: "textarea", rows: 3 },
        { key: "review4", label: "Interviewer Review 4", type: "textarea", rows: 3 }
      ]
    },
    contact: {
      title: "Edit Contact",
      fields: [
        { key: "name", label: "Full Name", type: "text" },
        { key: "email", label: "Email", type: "text" },
        { key: "phone", label: "Phone", type: "text" },
        { key: "resume", label: "Resume / CV", type: "text" }
      ]
    }
  };

  var editState = null;

  function openEdit(which) {
    var allowed = ["status", "priority", "time", "ctc", "reviews", "contact"];
    if (allowed.indexOf(which) === -1) return;
    var schema = EDIT_SCHEMAS[which];
    if (!schema || !state.currentCandidate) return;
    var c = state.currentCandidate;
    var fields = schema.fields.filter(function (f) {
      return true;
    });
    if (!fields.length) { toast("You have no editable fields here."); return; }
    editState = { used: fields.map(function (f) { return f.key; }) };
    $("edit-title").textContent = schema.title;
    $("edit-fields").innerHTML = (schema.hint ? '<p class="muted" style="font-size:12px;margin-bottom:12px">' + esc(schema.hint) + '</p>' : "") +
      fields.map(function (f) {
        var val = c[f.key] || "";
        var input;
        if (f.type === "textarea") {
          input = '<textarea class="input" id="ef-' + f.key + '" rows="' + (f.rows || 3) + '">' + esc(val) + '</textarea>';
        } else {
          input = '<input class="input" id="ef-' + f.key + '" type="text" value="' + esc(val) + '" />';
        }
        return '<label class="field"><span>' + f.label + '</span>' + input + '</label>';
      }).join("");
    $("edit-modal").classList.remove("hidden");
  }

  $("edit-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!editState || !state.currentCandidate) return;
    var c = state.currentCandidate;
    var jobs = editState.used.map(function (key) {
      var el = $("ef-" + key);
      var val = el ? el.value : "";
      return API.update(c.id, key, val).then(function () {
        c[key] = val;
      });
    });
    Promise.all(jobs).then(function () {
      closeModals();
      toast("Saved to Google Sheet");
      loadDashboard();
      if (state.allApplicants.length) loadAllApplicants();
      if (state.currentCandidate) renderCandidate(state.currentCandidate);
    }).catch(function (err) { closeModals(); showError(err); });
  });

  /* ---------------- refresh ---------------- */

  function refreshCurrent() {
    API.refresh(); // bypass cache so the manual refresh always pulls fresh data
    if (state.currentView === "candidate" && state.currentCandidate) { openCandidate(state.currentCandidate.id); return; }
    if (state.currentView === "role-detail" && state.currentRole) { openRoleDetail(state.currentRole.title); return; }
    loadDashboard();
    if (state.currentView === "applicants") loadAllApplicants();
    toast("Refreshing…");
  }

  /* ---------------- theme (dark mode) ---------------- */

  var THEME_KEY = "hiring_theme";
  function applyTheme(theme) {
    if (!theme) theme = "light";
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }
  function toggleTheme() {
    var cur = (document.documentElement.getAttribute("data-theme") === "dark") ? "light" : "dark";
    applyTheme(cur);
  }
  function initTheme() {
    var saved = "light";
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
    applyTheme(saved === "dark" ? "dark" : "light");
  }

  /* ---------------- events ---------------- */

  document.querySelectorAll(".nav-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      goView(b.dataset.view);
      if (b.dataset.view === "applicants" && !state.allApplicants.length) loadAllApplicants();
      if (b.dataset.view === "interviews") renderInterviewsPage();
      if (b.dataset.view === "roles") renderRoles("roles-grid-2", (state.dashboard && state.dashboard.roles) || []);
    });
  });

  $("refresh-btn").addEventListener("click", refreshCurrent);
  $("theme-toggle").addEventListener("click", toggleTheme);
  $("config-btn").addEventListener("click", openConfigModal);
  $("config-modal-close").addEventListener("click", closeModals);

  $("config-form").addEventListener("submit", function (e) { e.preventDefault(); API.setUrl($("config-input").value.trim()); closeModals(); applyConfigUI(); });
  $("config-clear-btn").addEventListener("click", function () { API.setUrl(""); closeModals(); applyConfigUI(); });
  $("config-save-btn").addEventListener("click", function () { API.setUrl($("config-url-input").value.trim()); applyConfigUI(); });
  $("error-dismiss").addEventListener("click", function () { $("error-banner").classList.add("hidden"); });

  $("role-back-btn").addEventListener("click", goBack);
  $("cand-back-btn").addEventListener("click", goBack);

  function goBack() {
    if (state.currentView === "candidate") {
      goView(state.prevView || "dashboard");
      return;
    }
    goView("dashboard");
  }

  // remember previous view when opening candidate
  var _openCandidate = openCandidate;
  openCandidate = function (id) {
    state.prevView = state.currentView;
    _openCandidate(id);
  };

  $("edit-close").addEventListener("click", closeModals);
  $("edit-cancel").addEventListener("click", closeModals);

  $("schedule-btn").addEventListener("click", function () { openCalendarModal(null); });
  $("cal-close").addEventListener("click", closeModals);
  $("cal-close-btn").addEventListener("click", closeModals);
  $("cal-cancel").addEventListener("click", cancelInterview);
  $("cal-form").addEventListener("submit", function (e) { e.preventDefault(); calendarSubmit(); });

  /* ---------------- add candidate ---------------- */

  function openAddModal() {
    var roles = (state.dashboard && state.dashboard.roles) || [];
    var sel = $("add-role");
    sel.innerHTML = '<option value="">Select role…</option>' + roles.map(function (r) {
      return '<option value="' + esc(r.title) + '">' + esc(r.title) + '</option>';
    }).join("");
    // reset form
    ["name","email","phone","experience","ctc","priority","status","resume","time"].forEach(function (k) {
      var el = $("add-" + k); if (el) el.value = "";
    });
    sel.value = "";
    $("add-modal").classList.remove("hidden");
  }

  $("add-candidate-btn").addEventListener("click", openAddModal);
  $("add-candidate-btn-2").addEventListener("click", openAddModal);
  $("add-close").addEventListener("click", closeModals);
  $("add-cancel").addEventListener("click", closeModals);

  $("add-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var role = $("add-role").value;
    var name = $("add-name").value.trim();
    if (!role) { toast("Please select a role"); return; }
    if (!name) { toast("Please enter a name"); return; }
    var fields = {
      role: role,
      name: name,
      email: $("add-email").value.trim(),
      phone: $("add-phone").value.trim(),
      experience: $("add-experience").value.trim(),
      ctc: $("add-ctc").value.trim(),
      priority: $("add-priority").value.trim(),
      status: $("add-status").value.trim(),
      resume: $("add-resume").value.trim(),
      time: $("add-time").value.trim(),
      position: role
    };
    modalBusy("add-modal", "Adding " + name + " to the sheet…");
    API.addApplicant(fields).then(function (res) {
      closeModals();
      toast("Added " + name + " to " + role + " tab");
      loadDashboard();
      if (state.allApplicants.length) loadAllApplicants();
    }).catch(function (err) { closeModals(); showError(err); });
  });

  $("app-search").addEventListener("input", function (e) { state.filters.search = e.target.value; renderApplicants(); });
  $("filter-role").addEventListener("change", function (e) { state.filters.role = e.target.value; renderApplicants(); });
  $("filter-dept").addEventListener("change", function (e) { state.filters.dept = e.target.value; renderApplicants(); });
  $("filter-status").addEventListener("change", function (e) { state.filters.status = e.target.value; renderApplicants(); });
  $("filter-priority").addEventListener("change", function (e) { state.filters.priority = e.target.value; renderApplicants(); });

  // Inline candidate edits: any .cedit box writes straight to the sheet on change.
  $("cand-sections").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains("cedit")) return;
    if (t.tagName === "TEXTAREA") return; // Enter = newline in textareas
    e.preventDefault();
    t.blur(); // blur fires change -> save
  });
  $("cand-sections").addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains("cedit")) return;
    var c = state.currentCandidate;
    var key = t.dataset && t.dataset.key;
    if (!c || !key) return;
    var val = t.value;
    if (String(val).trim() === String(c[key] || "").trim()) return;
    API.update(c.id, key, val).then(function () {
      c[key] = val;
      toast("Saved " + key);
      loadDashboard();
      if (state.allApplicants.length) loadAllApplicants();
    }).catch(showError);
  });

  document.querySelectorAll("#iv-seg .seg-btn").forEach(function (b) {
    b.addEventListener("click", function () { goInterviews(b.dataset.iv); });
  });

  document.addEventListener("click", function (e) {
    if (e.target.classList && e.target.classList.contains("modal")) closeModals();
  });

  /* ---------------- init ---------------- */

  initTheme();
  applyConfigUI();
})();
