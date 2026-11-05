#!/usr/bin/env node
// UserPromptSubmit hook: на каждую реплику пользователя — recall из командной
// памяти по тексту реплики, впрыск релевантного контекста в текущий тур.
// Вход: JSON на stdin (поле prompt — текст реплики). Выход: строгий JSON хука.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const FILE = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".zcode", "tdai-memory.json"), "utf8")); } catch { return {}; } })();
const GW = (process.env.TDAI_GATEWAY_URL || FILE.gatewayUrl || "http://127.0.0.1:8420").replace(/\/$/, "");
const USER = process.env.TDAI_USER_ID || FILE.userId || process.env.USERNAME || "user";
const SESSION = `turn-${USER}-${new Date().toISOString().slice(0, 10)}`;
const AUTH = (() => { const k = process.env.TDAI_GATEWAY_API_KEY || FILE.gatewayApiKey || ""; return k ? { Authorization: `Bearer ${k}` } : {}; })();

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

async function searchMemories(body, signal) {
  const res = await fetch(GW + "/search/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...AUTH },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) return null;
  return res.json();
}

try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const query = prompt.slice(0, 500);

  // Два запроса параллельно:
  //  1) общие L1-памятки по тексту реплики (как раньше);
  //  2) УРОКИ ОБ ОШИБКАХ ИНСТРУМЕНТОВ — отдельным запросом с фильтром по типу.
  // Зачем раздельно: уроки (type=work_method) тонут среди проектных записей
  // и не попадают в топ-3 общего поиска. Отдельный запрос по типу изолирует
  // их, чтобы канал ошибок доходил до агента наравне с прочим контекстом.
  const [jGeneral, jLessons] = await Promise.all([
    searchMemories({ query, limit: 3 }, controller.signal).catch(() => null),
    searchMemories({ query, limit: 3, type: "work_method" }, controller.signal).catch(() => null),
  ]);
  clearTimeout(timer);

  const general = (jGeneral && jGeneral.total) ? (jGeneral.results || "").trim() : "";
  const lessons = (jLessons && jLessons.total) ? (jLessons.results || "").trim() : "";
  if (!general && !lessons) fail("по реплике памяток нет — пустой вывод");

  const clip = (s, n) => s.length > n ? s.slice(0, n) + "\n…(усечено; полный поиск: node C:/TDAM/memory.mjs search \"<запрос>\")" : s;

  let ctx = "=== Командная память отдела — памятки, релевантные этой реплике ===\n" +
            "(найдено в общей памяти по тексту запроса; пользоваться или нет — решай по смыслу)\n\n" +
            clip(general, 2500);
  if (lessons) {
    ctx += "\n\n=== Уроки об ошибках инструментов (проверь перед похожими вызовами) ===\n" +
           "(правила предотвращения повторных ошибок; если собираешься вызывать такой инструмент — учти)\n\n" +
           clip(lessons, 1500);
  }
  emit("UserPromptSubmit", ctx);
} catch (e) {
  fail(`ошибка поиска: ${e.message}`);
}
