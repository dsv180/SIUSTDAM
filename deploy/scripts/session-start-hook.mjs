#!/usr/bin/env node
// SessionStart hook: впрыскивает сводку командной памяти в начало диалога.
// Конфиг: ~/.zcode/cli/config.json → hooks.events.SessionStart (type: process).
// Выход: строгий JSON {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}.
// 08.11.2026 (модуль «mcp-подключение», W5): память дергается через MCP-сервер
// шлюза (инструмент memory_recall), не напрямую через его HTTP API.

import { randomUUID } from "node:crypto";
import { mcpCall } from "./mcp-client.mjs";

const USER = process.env.TDAI_USER_ID || "user";
const QUERY = process.env.TDAI_STARTUP_QUERY || "регламент решения проекты отдел";
const SESSION = `hook-${USER}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

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
  const ctx = (await mcpCall("memory_recall", { query: QUERY, session_id: SESSION }))?.trim();
  if (!ctx) fail("память пуста");
  const trimmed = ctx.length > 4000 ? ctx.slice(0, 4000) + "\n…(усечено; полный поиск: MCP memory_search)" : ctx;
  emit(
    "=== Командная память отдела (TDAM) — сводка на старте сессии ===\n" +
    "Память общая для всех сотрудников; поиск и запись: MCP-инструменты memory_search/memory_capture\n\n" +
    trimmed
  );
} catch (e) {
  fail(`ошибка: ${e.message} (${Date.now() - t0}мс)`);
}
