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

try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  // L1-памятки по тексту реплики (персона и сцены уже впрыснуты на SessionStart)
  const res = await fetch(GW + "/search/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...AUTH },
    body: JSON.stringify({ query: prompt.slice(0, 500), limit: 3 }),
    signal: controller.signal,
  });
  clearTimeout(timer);
  if (!res.ok) fail(`gateway HTTP ${res.status}`);
  const j = await res.json();
  if (!j.total || j.total === 0) fail("по реплике памяток нет — пустой вывод");
  const trimmed = (j.results || "").length > 3000 ? (j.results || "").slice(0, 3000) + "\n…(усечено; полный поиск: node C:/TDAM/memory.mjs search \"<запрос>\")" : (j.results || "");
  emit(
    "UserPromptSubmit",
    "=== Командная память отдела — памятки, релевантные этой реплике ===\n" +
    "(найдено в общей памяти по тексту запроса; пользоваться или нет — решай по смыслу)\n\n" +
    trimmed
  );
} catch (e) {
  fail(`ошибка поиска: ${e.message}`);
}
