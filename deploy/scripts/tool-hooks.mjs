#!/usr/bin/env node
// Хук инструментов: пишет вызовы инструментов (и особенно их ошибки) в
// командную память отдела. Регистрируется на PostToolUse и PostToolUseFailure.
// Режим задаётся аргументом: "fail" (отказ) или "ok" (успешный вызов).
// По умолчанию (решение заказчика 01.11.2026) пишутся ТОЛЬКО ошибки:
// цель контура — ошибки не должны повторяться, успешные вызовы — шум.
// Включить запись успешных: TDAI_TOOL_CAPTURE_SUCCESS=1
// 08.11.2026 (модуль «mcp-подключение», W5): запись через MCP-сервер шлюза
// (инструмент memory_capture), не напрямую через его HTTP API.

import { randomUUID } from "node:crypto";
import { mcpCall } from "./mcp-client.mjs";

const MODE = process.argv[2] === "fail" ? "fail" : "ok";
const USER = process.env.TDAI_USER_ID || "user";
const SESSION = `tool-${MODE}-${USER}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const CAPTURE_SUCCESS = process.env.TDAI_TOOL_CAPTURE_SUCCESS === "1";

function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function silent(msg) { process.stderr.write(`[tdam-tool-hook/${MODE}] ${msg}\n`); process.exit(0); }

// stdin: JSON события хука
let raw = "";
for await (const c of process.stdin) raw += c;
let ev = {};
try { ev = JSON.parse(raw || "{}"); } catch {}

const tool = ev.tool_name || ev.tool || "неизвестный_инструмент";
const input = ev.tool_input ?? ev.input ?? ev.tool_arguments ?? null;
const output = ev.tool_output ?? ev.output ?? ev.tool_response ?? ev.error ?? ev.error_message ?? null;

// компактная выдержка из произвольных значений
function excerpt(v, max = 400) {
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s || "(пусто)";
}

if (MODE === "ok" && !CAPTURE_SUCCESS) silent("фиксация успешных вызовов выключена (TDAI_TOOL_CAPTURE_SUCCESS=0)");
if (MODE === "fail" && !output && !input) silent("нет данных об отказе — пустой вывод");

const isError = MODE === "fail";
const userContent = isError
  ? `ОШИБКА инструмента «${tool}». Контекст вызова: ${excerpt(input, 600)}. Сообщение об ошибке: ${excerpt(output, 600)}`
  : `Вызов инструмента «${tool}»: ${excerpt(input, 250)} → ${excerpt(output, 250)}`;

try {
  const text = await mcpCall("memory_capture", {
    user_content: userContent,
    assistant_content: isError
      ? "(автофиксация отказа инструмента — в память, чтобы не повторять)"
      : "(автофиксация вызова инструмента)",
    session_id: SESSION,
  });
  if (text === null) silent(`MCP-сервер недоступен или вернул ошибку`);
  out({}); // пустой валидный вывод: тур не блокируем
  const m = /l0=(\d+)/.exec(text || "");
  process.stderr.write(`[tdam-tool-hook/${MODE}] записано (l0=${m ? m[1] : "?"}): ${tool}\n`);
  process.exit(0);
} catch (e) {
  silent(`ошибка: ${e.message}`);
}
