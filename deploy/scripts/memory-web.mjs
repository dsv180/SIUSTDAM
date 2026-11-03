#!/usr/bin/env node
// Веб-просмотрщик командной памяти (read-only) поверх Gateway API.
// URL: http://127.0.0.1:8901  — поиск, памятки, сцены, персона, диалоги.

import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const GW = (process.env.TDAI_GATEWAY_URL || "http://127.0.0.1:8420").replace(/\/$/, "");
const PORT = Number(process.env.TDAI_WEB_PORT || 8901);
const DATA = path.join(homedir(), ".memory-tencentdb", "memory-tdai");
const PROFILES = path.join(DATA, "profiles");
const FILE = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".zcode", "tdai-memory.json"), "utf8")); } catch { return {}; } })();
const AUTH = (() => { const k = process.env.TDAI_GATEWAY_API_KEY || FILE.gatewayApiKey || ""; return k ? { Authorization: `Bearer ${k}` } : {}; })();

function profileDir() {
  try {
    const first = readdirSync(PROFILES)[0];
    return first ? path.join(PROFILES, first) : null;
  } catch { return null; }
}

async function gw(pathName, body) {
  const res = await fetch(GW + pathName, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...AUTH },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Командная память отдела</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#14161a;color:#dde}
header{padding:12px 20px;background:#1d2026;border-bottom:1px solid #2a2e35}
h1{font-size:16px;margin:0}h1 small{color:#889;font-weight:400}
#bar{padding:10px 20px;display:flex;gap:8px}
#q{flex:1;padding:8px 12px;background:#22262c;border:1px solid #343941;border-radius:6px;color:#dde;font-size:14px}
button{padding:8px 16px;background:#3b5bdb;color:#fff;border:0;border-radius:6px;cursor:pointer}
button.sec{background:#2a2e35;color:#aac}
main{padding:0 20px 40px;max-width:900px}
.card{background:#1d2026;border:1px solid #2a2e35;border-radius:8px;padding:12px 16px;margin:10px 0;white-space:pre-wrap}
.card h3{margin:0 0 6px;font-size:13px;color:#8ab}
.hint{color:#667;padding:6px 0}
</style></head><body>
<header><h1>🧠 Командная память отдела <small id="gw"></small></h1></header>
<div id="bar">
  <input id="q" placeholder="поиск по памяти (по-русски)… Enter">
  <button onclick="go()">Искать памятки</button>
  <button class="sec" onclick="go('conv')">Искать диалоги</button>
  <button class="sec" onclick="show('persona')">Персона</button>
  <button class="sec" onclick="show('scenes')">Сцены</button>
</div>
<main><div class="hint">Поиск по всей общей памяти. Эnter или кнопка.</div><div id="out"></div></main>
<script>
const $ = id => document.getElementById(id);
fetch('/api/health').then(r=>r.json()).then(j=>{ $('gw').textContent = '· шлюз ' + j.gateway + ' · ' + j.status; }).catch(()=>{ $('gw').textContent='· шлюз недоступен'; });
function card(title, body){ return '<div class="card"><h3>'+title+'</h3>'+body.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>'; }
async function show(kind){
  $('out').innerHTML = '<div class="hint">загрузка…</div>';
  const r = await fetch('/api/'+kind); const j = await r.json();
  if(!j.ok){ $('out').innerHTML = '<div class="card">Ошибка: '+j.error+'</div>'; return; }
  $('out').innerHTML = kind==='persona'
    ? card('Персона (L3)', j.text)
    : (j.scenes.length ? j.scenes.map(s=>card('Сцена: '+s.name, s.text)).join('') : '<div class="hint">Сцен пока нет.</div>');
}
async function go(kind){
  const q = $('q').value.trim(); if(!q) return;
  $('out').innerHTML = '<div class="hint">поиск…</div>';
  const r = await fetch('/api/search?kind='+(kind||'mem')+'&q='+encodeURIComponent(q));
  const j = await r.json();
  $('out').innerHTML = j.ok ? j.cards.map(c=>'<div class="card"><h3>'+c.title+'</h3>'+c.body.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>').join('') : '<div class="card">Ошибка: '+j.error+'</div>';
  if(j.ok && !j.cards.length) $('out').innerHTML = '<div class="hint">Ничего не найдено.</div>';
}
$('q').addEventListener('keydown', e=>{ if(e.key==='Enter') go(); });
</script></body></html>`;

const httpServer = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (u.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ gateway: GW, status: "watcher" }));
      return;
    }
    if (u.pathname === "/api/search") {
      const q = u.searchParams.get("q") || "";
      const kind = u.searchParams.get("kind") || "mem";
      const cards = [];
      if (kind === "mem") {
        const j = await gw("/search/memories", { query: q, limit: 10 });
        const blocks = (j.results || "").split(/\n(?=- \*\*)/);
        for (const b of blocks) {
          const m = b.match(/\*\*\[(\w+)\]\*\*\s*\(priority:\s*(\d+)\)[^\[]*\[scene:\s*([^\]]+)\]/);
          const body = b.replace(/^Found \d+ matching.*\n*/, "").replace(/^- \*\*.*?\n/, "").trim();
          if (body) cards.push({ title: m ? `${m[1]} · приоритет ${m[2]}` : "памятка", body: (m ? `сцена: ${m[3].trim()}\n` : "") + body });
        }
      } else {
        const j = await gw("/search/conversations", { query: q, limit: 10 });
        const parts = (j.results || "").replace(/^Found \d+ matching.*\n*/, "").split(/\n---\n/);
        for (const p of parts) {
          const m = p.match(/\*\*\[(user|assistant)\]\*\* Session: (\S+)/);
          const body = p.replace(/^\*\*\[(user|assistant)\]\*\*[^\n]*\n/m, "").replace(/^---\n/m, "").trim();
          if (body && !/No matching/.test(p)) cards.push({ title: m ? `${m[1]} · сессия ${m[2]}` : "реплика", body });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cards }));
      return;
    }
    if (u.pathname === "/api/persona") {
      const pd = profileDir();
      const file = pd ? path.join(pd, "persona.md") : null;
      const text = file && existsSync(file) ? readFileSync(file, "utf8") : "(персона ещё не собрана)";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, text }));
      return;
    }
    if (u.pathname === "/api/scenes") {
      const pd = profileDir();
      const dir = pd ? path.join(pd, "scene_blocks") : null;
      const files = dir && existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")) : [];
      const scenes = files.map(f => ({ name: f, text: readFileSync(path.join(dir, f), "utf8").slice(0, 4000) }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, scenes }));
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[${new Date().toISOString()}] веб-просмотрщик памяти на http://127.0.0.1:${PORT}`);
});
