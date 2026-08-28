/* ============================================================
   API client - talks to Google Apps Script Web App via GET.
   Apps Script does not answer OPTIONS preflight, so all reads
   AND writes use GET + query params to avoid CORS.
   No credentials/sheet ids live in the frontend - only the
   public /exec Web App URL (stored in localStorage).
   ============================================================ */

var API = (function () {
  var STORAGE_KEY = "hiring_app_url";
  var USER_KEY = "hiring_user";   // logged-in user id (or name), persisted
  // Default Apps Script Web App URL. Overridable via Settings (stored in
  // localStorage). No sheet IDs / credentials are exposed - just the public
  // /exec endpoint.
  var DEFAULT_APP_URL = "https://script.google.com/macros/s/AKfycbyOBB4_DDkwKwZpfifnhXWIimpswt62hh-zT4FgG8o0IXEwa2kIYXzMuKf5TWkNF1HF/exec";

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

  // ---- auth / session ----
  var currentUser = null; // {id,name,role,access,...} as returned by login
  function loadUser() {
    try { return localStorage.getItem(USER_KEY) || ""; } catch (e) { return ""; }
  }
  function setUserParam(p) {
    var u = currentUser && currentUser.id ? currentUser.id : loadUser();
    if (u) p.user = u;
    return p;
  }

  // Read-only actions are cached in-memory for a short TTL so navigation,
  // role-detail opens and view switches don't re-hit the network each time.
  // Writes always go to the server and clear the cache.
  var CACHE_TTL = 24000; // 24s (shorter than the 45s auto-refresh so data stays fresh)
  var cache = {};
  var CACHE_ACTIONS = {
    dashboard: true, roles: true, roleapplicants: true,
    applicants: true, interviews: true, candidate: true
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
      setUserParam(params); // attach logged-in user to every request
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
    getSessionUser: function () { return currentUser; },
    setSessionUser: function (u) {
      currentUser = u || null;
      try { if (u && u.id) localStorage.setItem(USER_KEY, u.id); else localStorage.removeItem(USER_KEY); } catch (e) {}
    },
    users: function () { return call({ action: "users" }); },
    login: function (userId) { return call({ action: "login", user: userId }); },
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
    }
  };
})();
