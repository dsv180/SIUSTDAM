#!/usr/bin/env node
// Хук инструментов: пишет вызовы инструментов (и особенно их ошибки) в
// командную память отдела. Регистрируется на PostToolUse и PostToolUseFailure.
// Режим задаётся аргументом: "fail" (отказ) или "ok" (успешный вызов).
// По умолчанию (решение заказчика 01.11.2026) пишутся ТОЛЬКО ошибки:
// цель контура — ошибки не должны повторяться, успешные вызовы — шум.
// Включить запись успешных: TDAI_TOOL_CAPTURE_SUCCESS=1

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MODE = process.argv[2] === "fail" ? "fail" : "ok";
const FILE = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".zcode", "tdai-memory.json"), "utf8")); } catch { return {}; } })();
const GW = (process.env.TDAI_GATEWAY_URL || FILE.gatewayUrl || "http://127.0.0.1:8420").replace(/\/$/, "");
const USER = process.env.TDAI_USER_ID || FILE.userId || process.env.USERNAME || "user";
// 08.11.2026: запись переведена на v3 /conversation/add — реплики штампуются
// team/agent/user пространства «Отдел поддержки 1С» и видны в панели сразу.
const TEAM = process.env.TDAI_TEAM_ID || FILE.teamId || "";
const AGENT = process.env.TDAI_AGENT_ID || FILE.agentId || "";
const SERVICE = process.env.TDAI_SERVICE_ID || FILE.serviceId || "default";
const SESSION = `tool-${MODE}-${USER}-${new Date().toISOString().slice(0, 10)}`;
const CAPTURE_SUCCESS = process.env.TDAI_TOOL_CAPTURE_SUCCESS === "1";
const KEY = process.env.TDAI_GATEWAY_API_KEY || FILE.gatewayApiKey || "";
const HEAD = {
  "Content-Type": "application/json; charset=utf-8",
  ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
  "x-tdai-service-id": SERVICE,
  ...(TEAM && AGENT ? { "x-tdai-team-id": TEAM, "x-tdai-agent-id": AGENT, "x-tdai-user-id": USER } : {}),
};

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const res = await fetch(GW + "/v3/conversation/add", {
    method: "POST",
    headers: HEAD,
    body: JSON.stringify({
      session_id: SESSION,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: isError
          ? "(автофиксация отказа инструмента — в память, чтобы не повторять)"
          : "(автофиксация вызова инструмента)" },
      ],
    }),
    signal: controller.signal,
  });
  clearTimeout(timer);
  if (!res.ok) silent(`gateway HTTP ${res.status}`);
  const j = await res.json();
  out({}); // пустой валидный вывод: тур не блокируем
  process.stderr.write(`[tdam-tool-hook/${MODE}] записано (l0=${(j.data?.accepted_ids || []).length}): ${tool}\n`);
  process.exit(0);
} catch (e) {
  silent(`gateway недоступен: ${e.message}`);
}
