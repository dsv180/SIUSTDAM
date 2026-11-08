#!/usr/bin/env node
// SessionStart hook: впрыскивает сводку командной памяти в начало диалога.
// Конфиг: ~/.zcode/cli/config.json → hooks.events.SessionStart (type: process).
// Выход: строгий JSON {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const FILE = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".zcode", "tdai-memory.json"), "utf8")); } catch { return {}; } })();
const GW = (process.env.TDAI_GATEWAY_URL || FILE.gatewayUrl || "http://127.0.0.1:8420").replace(/\/$/, "");
const USER = process.env.TDAI_USER_ID || FILE.userId || process.env.USERNAME || "user";
// 08.11.2026: recall скоупится на пространство команды «Отдел поддержки 1С»
// (персона и сцены читаются из профиля команды, не из дефолтного).
const TEAM = process.env.TDAI_TEAM_ID || FILE.teamId || "";
const AGENT = process.env.TDAI_AGENT_ID || FILE.agentId || "";
const QUERY = process.env.TDAI_STARTUP_QUERY || "регламент решения проекты отдел";

const SESSION = `hook-${USER}-${new Date().toISOString().slice(0, 10)}`;
const AUTH = (() => { const k = process.env.TDAI_GATEWAY_API_KEY || FILE.gatewayApiKey || ""; return k ? { Authorization: `Bearer ${k}` } : {}; })();

function emit(ctx) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx },
  }));
}

function fail(msg) {
  // Пустой вывод тоже валиден: тихо выходим, не ломая сессию.
  process.stderr.write(`[tdam-hook] ${msg}\n`);
  process.exit(0);
}

const t0 = Date.now();
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const res = await fetch(GW + "/recall", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...AUTH },
    body: JSON.stringify({ query: QUERY, session_key: SESSION, ...(TEAM && AGENT ? { team_id: TEAM, agent_id: AGENT, user_id: USER } : {}) }),
    signal: controller.signal,
  });
  clearTimeout(timer);
  if (!res.ok) fail(`gateway HTTP ${res.status}`);
  const j = await res.json();
  const ctx = (j.context || "").trim();
  if (!ctx) fail("память пуста");
  const trimmed = ctx.length > 4000 ? ctx.slice(0, 4000) + "\n…(усечено; полный поиск: node C:/TDAM/memory.mjs search \"<запрос>\")" : ctx;
  emit(
    "=== Командная память отдела (TDAM) — сводка на старте сессии ===\n" +
    "Память общая для всех сотрудников; поиск и запись: node C:/TDAM/memory.mjs search|conv|capture \"…\"\n\n" +
    trimmed
  );
} catch (e) {
  fail(`ошибка: ${e.message} (${Date.now() - t0}мс)`);
}
