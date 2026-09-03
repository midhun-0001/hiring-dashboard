/* ============================================================
   API client - talks to Google Apps Script Web App via GET.
   Apps Script does not answer OPTIONS preflight, so all reads
   AND writes use GET + query params to avoid CORS.
   No credentials/sheet ids live in the frontend - only the
   public /exec Web App URL (stored in localStorage).
   ============================================================ */

var API = (function () {
  var STORAGE_KEY = "hiring_app_url";
  // Default Apps Script Web App URL. Overridable via Settings (stored in
  // localStorage). No sheet IDs / credentials are exposed - just the public
  // /exec endpoint.
  var DEFAULT_APP_URL = "https://script.google.com/macros/s/AKfycbzZCAImcEbvbNzmu4l4FjhTpXC7HN61Sz9JLufCsO4yr7M_6c1prqd21hCZIMADe6GB/exec";

  function getUrl() {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_APP_URL; } catch (e) { return DEFAULT_APP_URL; }
  }
  function setUrl(url) {
    try { localStorage.setItem(STORAGE_KEY, (url || "").trim()); } catch (e) {}
    return getUrl();
  }
  function isConfigured() {
    var u = getUrl();
    return !!u && u.indexOf("/exec") !== -1;
  }

  // Read-only actions are cached in-memory for a short TTL so navigation,
  // role-detail opens and view switches don't re-hit the network each time.
  // Writes always go to the server and clear the cache.
  var CACHE_TTL = 24000; // 24s (shorter than the 45s auto-refresh so data stays fresh)
  var cache = {};
  // `tracker`, `interviewers` and `resumefolder` were missing here, so `call()`
  // classified them as writes: every visit to the Interviews tab wiped the whole
  // client cache and forced the dashboard + applicants to refetch.
  var CACHE_ACTIONS = {
    dashboard: true, roles: true, roleapplicants: true,
    applicants: true, interviews: true, calendar: true, candidate: true,
    tracker: true, interviewers: true, resumefolder: true
  };

  function cacheKey(params) {
    var relevant = {};
    Object.keys(params).forEach(function (k) {
      if (k === "_") return;
      relevant[k] = params[k];
    });
    return JSON.stringify(relevant);
  }
  function cacheGet(params) {
    var k = cacheKey(params);
    var e = cache[k];
    if (e && Date.now() - e.t < CACHE_TTL) return e.data;
    if (e) delete cache[k];
    return null;
  }
  function cachePut(params, data) {
    cache[cacheKey(params)] = { t: Date.now(), data: data };
  }
  function cacheClear() { cache = {}; }

  function fetchRemote(params) {
    var qs = new URLSearchParams(params).toString();
    return fetch(getUrl() + "?" + qs)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.error) throw new Error(data.error);
        return data;
      });
  }

  function call(params) {
    return new Promise(function (resolve, reject) {
      if (!isConfigured()) {
        reject(new Error("Not configured: set your Apps Script Web App URL."));
        return;
      }
      var write = !CACHE_ACTIONS[params.action];
      if (write) cacheClear(); // new data going to the sheet -> drop stale cache
      var read = CACHE_ACTIONS[params.action];
      try {
        if (read) {
          var hit = cacheGet(params);
          if (hit !== null) { resolve(hit); return; }
        }
      } catch (e) { /* caching is best-effort */ }
      fetchRemote(params).then(function (data) {
        if (read) {
          try { cachePut(params, data); } catch (e) {}
        }
        resolve(data);
      }).catch(reject);
    });
  }

  return {
    getUrl: getUrl,
    setUrl: setUrl,
    isConfigured: isConfigured,
    refresh: function () { cacheClear(); },
    dashboard: function () { return call({ action: "dashboard" }); },
    roles: function () { return call({ action: "roles" }); },
    roleApplicants: function (role) { return call({ action: "roleapplicants", role: role }); },
    applicants: function () { return call({ action: "applicants" }); },
    interviews: function () { return call({ action: "interviews" }); },
    candidate: function (id) { return call({ action: "candidate", id: id }); },
    update: function (id, field, value) {
      return call({ action: "update", id: id, field: field, value: value });
    },
    addApplicant: function (fields) {
      var p = { action: "addapplicant" };
      Object.keys(fields || {}).forEach(function (k) {
        if (fields[k] !== undefined && fields[k] !== null && fields[k] !== "") p[k] = fields[k];
      });
      return call(p);
    },
    deleteCandidate: function (id) {
      return call({ action: "deletecandidate", id: id });
    },
    calendar: function () { return call({ action: "calendar" }); },
    tracker: function () { return call({ action: "tracker" }); },
    trackerCreate: function (f) {
      var p = { action: "trackercreate", candidate: f.candidate, role: f.role, date: f.date, time: f.time };
      if (f.duration) p.duration = f.duration;
      if (f.candidateEmail) p.candidateEmail = f.candidateEmail;
      if (f.interviewer) p.interviewer = f.interviewer;
      if (f.interviewerEmail) p.interviewerEmail = f.interviewerEmail;
      if (f.notes) p.notes = f.notes;
      return call(p);
    },
    trackerUpdate: function (id, f) {
      var p = { action: "trackerupdate", id: id };
      if (f.candidate) p.candidate = f.candidate;
      if (f.role) p.role = f.role;
      if (f.date) p.date = f.date;
      if (f.time) p.time = f.time;
      if (f.duration) p.duration = f.duration;
      if (f.candidateEmail !== undefined) p.candidateEmail = f.candidateEmail;
      if (f.interviewer !== undefined) p.interviewer = f.interviewer;
      if (f.interviewerEmail !== undefined) p.interviewerEmail = f.interviewerEmail;
      if (f.status !== undefined) p.status = f.status;
      if (f.notes !== undefined) p.notes = f.notes;
      return call(p);
    },
    trackerCancel: function (id) {
      return call({ action: "trackercancel", id: id });
    },
    // Outcome of a finished interview: Result (column N) + Note (column K).
    trackerResult: function (id, fields) {
      var p = { action: "trackerresult", id: id };
      if (fields.result !== undefined) p.result = fields.result;
      if (fields.note !== undefined) p.note = fields.note;
      return call(p);
    },
    interviewers: function () { return call({ action: "interviewers" }); },
    interviewerAdd: function (name, email) {
      return call({ action: "intervieweradd", name: name, email: email });
    },
    resumeFolder: function () { return call({ action: "resumefolder" }); },
    roleSetStatus: function (id, status, title) {
      return call({ action: "rolesetstatus", id: id || "", status: status, title: title || "" });
    },
    calendarCreate: function (f) { return this.trackerCreate(f); },
    calendarUpdate: function (id, f) { return this.trackerUpdate(id, f); },
    calendarCancel: function (id) { return this.trackerCancel(id); },
    /* Upload a resume to Drive.
       Apps Script CANNOT read a file out of a multipart/form-data body: with
       FormData every text field arrives in e.parameter but the file does not,
       so doPost always answered {"error":"no file received"}. The bytes now go
       as web-safe base64 in a form-urlencoded field instead. web-safe matters:
       its alphabet (A-Za-z0-9-_) survives URL encoding unexpanded, where
       standard base64's "+", "/" and "=" would each inflate to 3 characters. */
    MAX_RESUME_BYTES: 8 * 1024 * 1024,
    uploadResume: function (file, opts) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (!isConfigured()) {
          reject(new Error("Not configured: set your Apps Script Web App URL."));
          return;
        }
        if (!file) { reject(new Error("No file selected.")); return; }
        if (file.size > self.MAX_RESUME_BYTES) {
          reject(new Error("That file is " + (file.size / 1048576).toFixed(1) +
            " MB. The limit is " + (self.MAX_RESUME_BYTES / 1048576) + " MB."));
          return;
        }

        var reader = new FileReader();
        reader.onerror = function () { reject(new Error("Could not read that file.")); };
        reader.onload = function () {
          var raw = String(reader.result || "");
          var comma = raw.indexOf(",");                    // strip "data:...;base64,"
          var b64 = comma >= 0 ? raw.slice(comma + 1) : raw;
          if (!b64) { reject(new Error("That file appears to be empty.")); return; }
          var webSafe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

          var body = new URLSearchParams();
          body.set("action", "uploadresume");
          body.set("filename", file.name || "resume.pdf");
          body.set("mimeType", file.type || "application/octet-stream");
          body.set("dataWebSafe", webSafe);
          if (opts && opts.candidate) body.set("candidate", opts.candidate);
          if (opts && opts.id) body.set("id", opts.id);

          // urlencoded is a CORS-safelisted content type, so no preflight -
          // which Apps Script would not answer anyway.
          fetch(getUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: body.toString()
          }).then(function (res) {
            return res.text().then(function (t) {
              try { return JSON.parse(t); } catch (e) {
                throw new Error("Unexpected reply from Apps Script (HTTP " + res.status +
                  "). Re-deploy Code.gs as a new version and set access to \"Anyone\".");
              }
            });
          }).then(function (data) {
            if (data && data.error) throw new Error(data.error);
            if (!data || !data.url) throw new Error("Upload finished but no Drive link came back.");
            cacheClear();
            resolve(data);
          }).catch(reject);
        };
        reader.readAsDataURL(file);
      });
    }
  };
})();
