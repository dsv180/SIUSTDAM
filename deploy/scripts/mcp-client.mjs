#!/usr/bin/env node
// Минимальный MCP-клиент (streamable-http, stateless JSON) для хуков ZCode.
// Модуль «mcp-подключение», W5: хуки дергают память через MCP-сервер шлюза
// (вшитый POST /mcp на :8420), а не напрямую через его HTTP API.
// Пространство команды задаётся на стороне шлюза (TDAI_MCP_* в gateway.env) —
// хуку конфигурация пространства не нужна.
// Все ошибки — тихие: функция возвращает null, сессия не падает.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const FILE = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".zcode", "tdai-memory.json"), "utf8")); } catch { return {}; } })();
const MCP_URL = ((process.env.TDAI_GATEWAY_URL || FILE.gatewayUrl || "http://127.0.0.1:8420").replace(/\/$/, "")) + "/mcp";

export async function mcpCall(tool, args = {}, timeoutMs = 8000) {
  const post = async (body) => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 202) return null;
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };
  const init = await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "zcode-hook", version: "1.0" } },
  });
  if (!init?.result) return null;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  if (!call || call.error || call.result?.isError) return null;
  return call.result?.content?.[0]?.text ?? null;
}
