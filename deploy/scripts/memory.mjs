#!/usr/bin/env node
// Командный интерфейс к коллективной памяти отдела (MemoryCore Gateway).
// Работает в любом диалоге через Bash: node C:/TDAM/memory.mjs <команда> [аргументы]
// Команды:
//   search <запрос> [limit]      — поиск по памяткам L1 (факты, правила, события)
//   conv <запрос> [limit]        — поиск по исходным диалогам L0 (дословно)
//   capture "<реплика пользователя>" ["ответ ассистента"] — записать обмен в память
//   recall <запрос>              — сводка контекста памяти по запросу
//   end                          — завершить сессию памяти (форс-экстракция)
//   health                       — живость шлюза
// Сессия генерируется на процесс; user_id берётся из env TDAI_USER_ID или имени пользователя.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const FILE = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".zcode", "tdai-memory.json"), "utf8")); } catch { return {}; } })();
const GW = (process.env.TDAI_GATEWAY_URL || FILE.gatewayUrl || "http://127.0.0.1:8420").replace(/\/$/, "");
const USER = process.env.TDAI_USER_ID || FILE.userId || process.env.USERNAME || "user";
const SESSION = `cli-${USER}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const AUTH = (() => { const k = process.env.TDAI_GATEWAY_API_KEY || FILE.gatewayApiKey || ""; return k ? { Authorization: `Bearer ${k}` } : {}; })();

async function gw(pathName, body) {
  const res = await fetch(GW + pathName, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...AUTH },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`ошибка ${pathName}: HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(1); }
  return text;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "search": {
    const j = JSON.parse(await gw("/search/memories", { query: rest[0] || "", limit: Number(rest[1]) || 5 }));
    console.log(j.results || "(пусто)");
    break;
  }
  case "conv": {
    const j = JSON.parse(await gw("/search/conversations", { query: rest[0] || "", limit: Number(rest[1]) || 5 }));
    console.log(j.results || "(пусто)");
    break;
  }
  case "capture": {
    const j = JSON.parse(await gw("/capture", {
      user_content: rest[0] || "",
      assistant_content: rest[1] || "(без ответа ассистента)",
      session_key: SESSION,
      user_id: USER,
    }));
    console.log(`записано (l0=${j.l0_recorded}, сессия ${SESSION})`);
    break;
  }
  case "recall": {
    const j = JSON.parse(await gw("/recall", { query: rest[0] || "", session_key: SESSION }));
    console.log(j.context || "(память пуста)");
    break;
  }
  case "end": {
    const j = JSON.parse(await gw("/session/end", { session_key: SESSION }));
    console.log(`сессия завершена (flushed=${j.flushed})`);
    break;
  }
  case "health": {
    const res = await fetch(GW + "/health");
    const j = await res.json();
    console.log(`gateway ${j.status}, fts=${j.stores?.ftsAvailable}, uptime=${Math.round(j.uptime)}с`);
    break;
  }
  default:
    console.log("команды: search | conv | capture | recall | end | health — node C:/TDAM/memory.mjs <команда> ...");
}
