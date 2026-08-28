/* ============================================================
   Minimal no-dependency static server for the hiring dashboard.
   Serves this folder over the LAN so teammates can open it on
   their own machines.

   Usage (from this folder, on the machine hosting the sheet):
       node serve.js [port]
   Default port 8080.

   Then others open:  http://<YOUR-IP>:8080   (see your local IPv4)
   ============================================================ */
"use strict";
var http = require("http");
var fs = require("fs");
var path = require("path");
var os = require("os");

var PORT = parseInt(process.argv[2] || "8080", 10);
var ROOT = __dirname;

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8"
};

function localIPs() {
  var nets = os.networkInterfaces();
  var out = [];
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (net) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    });
  });
  return out;
}

http.createServer(function (req, res) {
  var urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  var safe = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, "");
  var isRoot = (safe === "/" || safe === "\\" || safe === ".");
  var filePath = path.join(ROOT, isRoot ? "index.html" : safe);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404); res.end("Not found"); return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}).listen(PORT, "0.0.0.0", function () {
  var ips = localIPs();
  console.log("Hiring dashboard server running.");
  console.log("  Local:    http://localhost:" + PORT);
  (ips.length ? ips : ["<your-lan-ip>"]).forEach(function (ip) {
    console.log("  Network:  http://" + ip + ":" + PORT);
  });
  console.log("Share the Network URL with teammates. Ctrl+C to stop.");
});
