#!/usr/bin/env node
// ОТЛАДОЧНЫЙ инструмент (решение заказчика 08.11, модуль «mcp-подключение» W6):
// штатный интерфейс памяти — MCP-инструменты memory_* (POST /mcp на шлюзе);
// CLI используется для отладки и обслуживания веб-интерфейса TDAM.
// Командный интерфейс к коллективной памяти отдела (MemoryCore Gateway).
// Работает в любом диалоге через Bash: node C:/TDAM/memory.mjs <команда> [аргументы]
// Команды:
//   search <запрос> [limit]      — поиск по памяткам L1 (факты, правила, события)
//   conv <запрос> [limit]        — поиск по исходным диалогам L0 (дословно)
//   capture "<реплика пользователя>" ["ответ ассистента"] — записать обмен в память
//   recall <запрос>              — сводка контекста памяти по запросу
//   end                          — завершить сессию памяти (форс-экстракция)
//   health                       — живость шлюза
// Сессия генерируется на процесс.
// 08.11.2026: канал переведён на v3-пространство команды «Отдел поддержки 1С»
// (решение заказчика — одно пространство памяти, дефолтного нет). Запись —
// /v3/conversation/add (штампует team/agent, запускает дистилляцию L1/L2/L3
// в пространство отдела); поиск — /v3/atomic/search и /v3/conversation/search
// с фильтром по команде. Пространство задаётся в ~/.zcode/tdai-memory.json.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const FILE = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".zcode", "tdai-memory.json"), "utf8")); } catch { return {}; } })();
const GW = (process.env.TDAI_GATEWAY_URL || FILE.gatewayUrl || "http://127.0.0.1:8420").replace(/\/$/, "");
const USER = process.env.TDAI_USER_ID || FILE.userId || process.env.USERNAME || "user";
const TEAM = process.env.TDAI_TEAM_ID || FILE.teamId || "default";
const AGENT = process.env.TDAI_AGENT_ID || FILE.agentId || "default";
const SERVICE = process.env.TDAI_SERVICE_ID || FILE.serviceId || "default";
const SESSION = `cli-${USER}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const KEY = process.env.TDAI_GATEWAY_API_KEY || FILE.gatewayApiKey || "";
// v3-доступ: непустой Bearer + service-id. Изоляция (team/agent/user) — ТОЛЬКО
// при явной настройке (env TDAI_* или поля tdai-memory.json): если заголовки не
// заданы, шлюз применяет свои дефолты (TDAI_MCP_* / "default") — там живут
// записи хуков и CLI. Произвольный user-id (имя пользователя Windows) уводит
// запрос в пустой скоуп — проверено 2026-11-05.
const HEAD = {
  "Content-Type": "application/json; charset=utf-8",
  ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
  "x-tdai-service-id": SERVICE,
};
const EXPLICIT_USER = process.env.TDAI_USER_ID || FILE.userId || "";
if (TEAM !== "default") HEAD["x-tdai-team-id"] = TEAM;
if (AGENT !== "default") HEAD["x-tdai-agent-id"] = AGENT;
if (EXPLICIT_USER && EXPLICIT_USER !== "default") HEAD["x-tdai-user-id"] = EXPLICIT_USER;

async function gw(pathName, body) {
  const res = await fetch(GW + pathName, {
    method: "POST",
    headers: HEAD,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`ошибка ${pathName}: HTTP ${res.status}: ${text.slice(0, 300)}`); process.exit(1); }
  return JSON.parse(text);
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "search": {
    const j = await gw("/v3/atomic/search", { query: rest[0] || "", limit: Number(rest[1]) || 5 });
    const items = j.data?.items || [];
    if (!items.length) { console.log("(пусто)"); break; }
    console.log(items.map(i => `- [${i.type}] ${i.content}`).join("\n"));
    break;
  }
  case "conv": {
    const j = await gw("/v3/conversation/search", { query: rest[0] || "", limit: Number(rest[1]) || 5 });
    const msgs = j.data?.messages || [];
    if (!msgs.length) { console.log("(пусто)"); break; }
    console.log(msgs.map(m => `- [${m.role}] ${m.content}`).join("\n"));
    break;
  }
  case "capture": {
    const j = await gw("/v3/conversation/add", {
      session_id: SESSION,
      messages: [
        { role: "user", content: rest[0] || "" },
        { role: "assistant", content: rest[1] || "(без ответа ассистента)" },
      ],
    });
    const n = (j.data?.accepted_ids || []).length;
    console.log(`записано (l0=${n}, пространство отдела, сессия ${SESSION})`);
    break;
  }
  case "recall": {
    const j = await gw("/recall", { query: rest[0] || "", session_key: SESSION, team_id: TEAM, agent_id: AGENT, user_id: USER });
    console.log(j.context || "(память пуста)");
    break;
  }
  case "end": {
    const j = await gw("/session/end", { session_key: SESSION, team_id: TEAM, agent_id: AGENT });
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
