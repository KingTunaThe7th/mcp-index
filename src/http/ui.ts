/**
 * Local dashboard.
 *
 * Deliberately dependency-free and DOM-safe: every value coming from the
 * catalog is written with `textContent` (or validated before becoming an
 * `href`), so a malicious registry entry cannot execute script in the page that
 * also holds your gateway token.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>mcp-index</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#ddd; --accent:#0a7; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --bg:#16181c; --muted:#9aa0a6; --line:#2c3138; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--fg); background:var(--bg); }
  header { display:flex; flex-wrap:wrap; gap:.75rem; align-items:center; padding:.75rem 1rem; border-bottom:1px solid var(--line); }
  h1 { font-size:1rem; margin:0; letter-spacing:.02em; }
  main { padding:1rem; max-width:70rem; margin:0 auto; }
  input, button { font:inherit; padding:.4rem .6rem; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; }
  input[type=search] { flex:1; min-width:14rem; }
  button { cursor:pointer; }
  button:hover { border-color:var(--accent); }
  .muted { color:var(--muted); }
  .row { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
  .card { border:1px solid var(--line); border-radius:8px; padding:.75rem; margin:.6rem 0; }
  .card h3 { margin:0 0 .25rem; font-size:.95rem; display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
  .badge { font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; border:1px solid var(--line); border-radius:999px; padding:.05rem .45rem; color:var(--muted); }
  .badge.ok { color:var(--accent); border-color:var(--accent); }
  .badge.bad { color:#c33; border-color:#c33; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em; }
  a { color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  td, th { text-align:left; padding:.3rem .4rem; border-bottom:1px solid var(--line); vertical-align:top; }
</style>
</head>
<body>
<header>
  <h1>mcp-index</h1>
  <span id="health" class="badge">checking</span>
  <input id="token" type="password" placeholder="gateway token" autocomplete="off" spellcheck="false" style="min-width:16rem">
  <button id="save">Use token</button>
  <span class="muted" id="tokenhint">stored in localStorage; sent as a bearer header</span>
</header>
<main>
  <section>
    <div class="row">
      <input id="q" type="search" placeholder="search the catalog (e.g. postgres, github, filesystem)">
      <button id="go">Search</button>
    </div>
    <p class="muted" id="statreport"></p>
    <div id="results"></div>
  </section>
  <section>
    <h2 style="font-size:.95rem;margin:1.5rem 0 .5rem">Mounted servers</h2>
    <div id="mounts"></div>
  </section>
</main>
<script>
(function () {
  "use strict";
  var state = { token: localStorage.getItem("mcp-index-token") || "" };

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === "text") node.textContent = props[key];
        else if (key === "className") node.className = props[key];
        else node.setAttribute(key, props[key]);
      });
    }
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function safeHref(value) {
    if (typeof value !== "string") return null;
    try {
      var parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
    } catch (error) {
      return null;
    }
  }

  function api(path) {
    return fetch(path, { headers: { authorization: "Bearer " + state.token } }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function panel(title, right) {
    var head = el("h3", null, [el("span", { text: title })]);
    if (right) head.appendChild(right);
    return head;
  }

  function renderStats(stats) {
    document.getElementById("statreport").textContent =
      stats.total + " servers indexed \\u00b7 " + stats.official + " official \\u00b7 last sync " +
      (stats.lastSync || "never") + " \\u00b7 " + JSON.stringify(stats.bySource);
  }

  function renderResults(hits) {
    var root = document.getElementById("results");
    root.textContent = "";
    if (!hits.length) {
      root.appendChild(el("p", { className: "muted", text: "no matches" }));
      return;
    }
    hits.forEach(function (hit) {
      var badges = [el("span", { className: "badge", text: hit.transportKind })];
      if (hit.isOfficial) badges.push(el("span", { className: "badge ok", text: "official" }));
      if (hit.language) badges.push(el("span", { className: "badge", text: hit.language }));

      var card = el("div", { className: "card" }, [
        panel(hit.name, el("span", null, badges)),
        el("p", { className: "muted", text: hit.description || "(no description)" }),
        el("div", { className: "row" }, [
          el("code", { text: hit.id }),
          el("span", { className: "muted", text: (hit.categories || []).join(", ") })
        ])
      ]);

      var href = safeHref(hit.repoUrl) || safeHref(hit.homepage);
      if (href) {
        card.appendChild(el("div", { className: "row" }, [
          el("a", { href: href, rel: "noreferrer noopener", target: "_blank", text: "source" })
        ]));
      }
      root.appendChild(card);
    });
  }

  function renderMounts(mounts) {
    var root = document.getElementById("mounts");
    root.textContent = "";
    if (!mounts.length) {
      root.appendChild(el("p", { className: "muted", text: "no servers mounted; add entries to mcp-index.json" }));
      return;
    }
    var body = el("tbody");
    mounts.forEach(function (mount) {
      var cls = mount.status === "ready"
        ? "badge ok"
        : (mount.status === "error" || mount.status === "blocked" ? "badge bad" : "badge");
      body.appendChild(el("tr", null, [
        el("td", null, [el("code", { text: mount.alias })]),
        el("td", null, [el("span", { className: cls, text: mount.status })]),
        el("td", { text: mount.driver || "-" }),
        el("td", { text: String(mount.toolCount) }),
        el("td", { className: "muted", text: mount.error || mount.containment || "" })
      ]));
    });

    var table = el("table", null, [
      el("thead", null, [el("tr", null, [
        el("th", { text: "alias" }), el("th", { text: "status" }), el("th", { text: "driver" }),
        el("th", { text: "tools" }), el("th", { text: "detail" })
      ])]),
      body
    ]);
    root.appendChild(table);
  }

  function search() {
    var q = document.getElementById("q").value.trim();
    var path = "/api/search?limit=20" + (q ? "&q=" + encodeURIComponent(q) : "");
    api(path).then(function (res) { renderResults(res.hits || []); }).catch(function () {});
  }

  function refresh() {
    var health = document.getElementById("health");
    if (!state.token) {
      health.textContent = "no token";
      health.className = "badge";
      return;
    }

    api("/api/health").then(function () {
      health.textContent = "connected";
      health.className = "badge ok";
    }).catch(function () {
      health.textContent = "unauthorised";
      health.className = "badge bad";
    });

    api("/api/stats").then(renderStats).catch(function () {});
    api("/api/servers").then(function (res) { renderMounts(res.servers || []); }).catch(function () {});
    search();
  }

  document.getElementById("save").addEventListener("click", function () {
    state.token = document.getElementById("token").value.trim();
    localStorage.setItem("mcp-index-token", state.token);
    refresh();
  });
  document.getElementById("go").addEventListener("click", search);
  document.getElementById("q").addEventListener("keydown", function (event) {
    if (event.key === "Enter") search();
  });

  document.getElementById("token").value = state.token;
  refresh();
})();
</script>
</body>
</html>`;
