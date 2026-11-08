#!/usr/bin/env node
// UserPromptSubmit hook: на каждую реплику пользователя — recall из командной
// памяти по тексту реплики, впрыск релевантного контекста в текущий тур.
// Вход: JSON на stdin (поле prompt — текст реплики). Выход: строгий JSON хука.
// 08.11.2026 (модуль «mcp-подключение», W5): поиск через MCP-сервер шлюза
// (инструмент memory_search), не напрямую через его HTTP API.

import { randomUUID } from "node:crypto";
import { mcpCall } from "./mcp-client.mjs";

const USER = process.env.TDAI_USER_ID || "user";
const SESSION = `turn-${USER}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

function emit(eventName, ctx) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: ctx },
  }));
}

function fail(msg) {
  process.stderr.write(`[tdam-turn-hook] ${msg}\n`);
  process.exit(0); // тихий выход: пустой вывод валиден, тур не блокируем
}

// читаем stdin целиком (JSON события хука)
let raw = "";
for await (const c of process.stdin) raw += c;

let prompt = "";
try {
  const input = JSON.parse(raw || "{}");
  prompt = input.prompt || input.user_prompt || input.input || "";
  // некоторые сборки кладут текст в matcher/payload — последний шанс
  if (!prompt && typeof input === "string") prompt = input;
} catch {
  // stdin не JSON — пробуем считать весь ввод текстом реплики
  prompt = raw.trim();
}
prompt = String(prompt).trim();
if (!prompt) fail("нет текста реплики — пустой вывод");

try {
  const query = prompt.slice(0, 500);

  // Два запроса параллельно:
  //  1) общие L1-памятки по тексту реплики (как раньше);
  //  2) УРОКИ ОБ ОШИБКАХ ИНСТРУМЕНТОВ — отдельным запросом с фильтром по типу.
  // Зачем раздельно: уроки (type=work_method) тонут среди проектных записей
  // и не попадают в топ-3 общего поиска. Отдельный запрос по типу изолирует
  // их, чтобы канал ошибок доходил до агента наравне с прочим контекстом.
  const [general, lessons] = await Promise.all([
    mcpCall("memory_search", { query, limit: 3 }).catch(() => null),
    mcpCall("memory_search", { query, limit: 3, type: "work_method" }).catch(() => null),
  ]);
  const g = (general && general !== "(пусто)") ? general : "";
  const l = (lessons && lessons !== "(пусто)") ? lessons : "";
  if (!g && !l) fail("по реплике памяток нет — пустой вывод");

  const clip = (s, n) => s.length > n ? s.slice(0, n) + "\n…(усечено; полный поиск: MCP memory_search)" : s;

  let ctx = "=== Командная память отдела — памятки, релевантные этой реплике ===\n" +
            "(найдено в общей памяти по тексту запроса; пользоваться или нет — решай по смыслу)\n\n" +
            clip(g, 2500);
  if (l) {
    ctx += "\n\n=== Уроки об ошибках инструментов (проверь перед похожими вызовами) ===\n" +
           "(правила предотвращения повторных ошибок; если собираешься вызывать такой инструмент — учти)\n\n" +
           clip(l, 1500);
  }
  emit("UserPromptSubmit", ctx);
} catch (e) {
  fail(`ошибка поиска: ${e.message}`);
}
