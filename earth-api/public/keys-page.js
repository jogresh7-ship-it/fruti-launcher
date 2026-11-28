// The "Get an API key" page (keys.html).
(() => {
  const $ = (id) => document.getElementById(id);
  const served = location.protocol.startsWith("http");
  const base = served ? location.origin : "https://earth-api.pages.dev";
  let currentKey = "YOUR_KEY";

  async function api(path, init) {
    if (!served) throw new Error("Open this page from the website (or run node server.js) to create keys.");
    const res = await fetch(path, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    return body;
  }

  // ---------- examples ----------
  const EXAMPLES = {
    js: (k) => `const res = await fetch("${base}/api/weather?lat=48.85&lon=2.35&key=${k}");
const data = await res.json();
console.log(data.current.temperatureC, data.current.description);`,
    html: (k) => `<div id="quakes">Loading…</div>
<script>
  fetch("${base}/api/earthquakes?minmag=5&days=7&limit=5", { headers: { "x-api-key": "${k}" } })
    .then((r) => r.json())
    .then((d) => {
      document.getElementById("quakes").innerHTML = d.earthquakes
        .map((q) => "M" + q.magnitude + " · " + q.place).join("<br>");
    });
<\/script>`,
    curl: (k) => `curl -H "x-api-key: ${k}" "${base}/api/place?q=Tokyo"`,
    python: (k) => `import requests

r = requests.get("${base}/api/iss", headers={"x-api-key": "${k}"})
print(r.json())`,
  };
  let tab = "js";
  function showExample() { $("example").textContent = EXAMPLES[tab](currentKey); }
  document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    showExample();
  });
  showExample();

  // ---------- endpoint list ----------
  if (window.EarthAPI) {
    for (const ep of EarthAPI.docs) {
      const tr = document.createElement("tr");
      const a = document.createElement("a");
      a.href = ep.example; a.target = "_blank"; a.rel = "noopener";
      const code = document.createElement("code"); code.textContent = ep.path; a.append(code);
      const td1 = document.createElement("td"); td1.append(a);
      const td2 = document.createElement("td"); td2.textContent = ep.description;
      tr.append(td1, td2);
      $("endpoints").append(tr);
    }
  }

  // ---------- create ----------
  $("createForm").onsubmit = async (e) => {
    e.preventDefault();
    const msg = $("createMsg");
    msg.className = "msg"; msg.textContent = "Creating…";
    try {
      const made = await api("/api/keys", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: $("name").value, site: $("site").value }),
      });
      currentKey = made.key;
      $("keyText").textContent = made.key;
      $("result").hidden = false;
      $("checkKey").value = made.key;
      msg.textContent = `Key for "${made.name}" created. It allows ${made.dailyLimit.toLocaleString()} requests a day.`;
      showExample();
    } catch (err) {
      msg.className = "msg err"; msg.textContent = err.message;
    }
  };
  $("copyKey").onclick = async () => {
    try { await navigator.clipboard.writeText(currentKey); $("copyKey").textContent = "Copied ✓"; }
    catch { getSelection().selectAllChildren($("keyText")); $("copyKey").textContent = "Press Ctrl+C"; }
    setTimeout(() => ($("copyKey").textContent = "Copy"), 2000);
  };

  // ---------- check / revoke ----------
  const keyHeader = () => ({ "x-api-key": $("checkKey").value.trim() });
  $("checkForm").onsubmit = async (e) => {
    e.preventDefault();
    const msg = $("checkMsg");
    $("usage").hidden = true;
    msg.className = "msg"; msg.textContent = "Checking…";
    try {
      const me = await api("/api/keys/me", { headers: keyHeader() });
      msg.textContent = "";
      const hours = Math.floor(me.resetsInSeconds / 3600), mins = Math.floor((me.resetsInSeconds % 3600) / 60);
      const stats = [
        ["Project", me.name], ["Key", me.prefix + "…"],
        ["Used today", me.usedToday.toLocaleString()], ["Left today", me.remainingToday.toLocaleString()],
        ["Resets in", `${hours} h ${mins} min`], ["Created", new Date(me.created).toLocaleDateString()],
      ];
      if (me.site) stats.splice(1, 0, ["Website", me.site]);
      $("usageStats").innerHTML = "";
      for (const [label, value] of stats) {
        const d = document.createElement("div"); d.className = "stat";
        const s = document.createElement("span"); s.textContent = label;
        const b = document.createElement("b"); b.textContent = value;
        d.append(s, b); $("usageStats").append(d);
      }
      $("usage").hidden = false;
    } catch (err) {
      msg.className = "msg err"; msg.textContent = err.message;
    }
  };
  $("revoke").onclick = async () => {
    if (!confirm("Revoke this key? Anything using it will stop working.")) return;
    try {
      await api("/api/keys/me", { method: "DELETE", headers: keyHeader() });
      $("usage").hidden = true;
      $("checkMsg").className = "msg"; $("checkMsg").textContent = "Key revoked.";
    } catch (err) {
      $("checkMsg").className = "msg err"; $("checkMsg").textContent = err.message;
    }
  };
})();
