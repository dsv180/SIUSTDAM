#!/usr/bin/env node
// MCP-сервер командной памяти над HTTP — на официальном SDK.
// Транспорт: StreamableHTTP (stateless, JSON-ответы), POST /mcp.
// Инструменты те же: search / conv / capture / recall / end.
// Клиент: ZCode «Настройки → MCP», тип http, URL http://<хост>:8900/mcp

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const FILE = (() => { try { return JSON.parse(readFileSync(path.join(homedir(), ".zcode", "tdai-memory.json"), "utf8")); } catch { return {}; } })();
const GW = (process.env.TDAI_GATEWAY_URL || FILE.gatewayUrl || "http://127.0.0.1:8420").replace(/\/$/, "");
const USER = process.env.TDAI_USER_ID || FILE.userId || process.env.USERNAME || "user";
const PORT = Number(process.env.TDAI_MCP_HTTP_PORT || 8900);

const AUTH = (() => { const k = process.env.TDAI_GATEWAY_API_KEY || FILE.gatewayApiKey || ""; return k ? { Authorization: `Bearer ${k}` } : {}; })();

const CANARY = "C:\\TDAM\\mcp-http-canary.log";
function canary(msg) {
  try { appendFileSync(CANARY, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

async function gw(pathName, body) {
  const res = await fetch(GW + pathName, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...AUTH },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gateway ${pathName} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

function sessionOf(headers) {
  return headers["x-tdai-session"] || `mcp-http-${USER}-${new Date().toISOString().slice(0, 10)}`;
}

const server = new McpServer({ name: "sius-memory-tdai", version: "0.2.0" });

server.tool(
  "memory_search",
  "Поиск по долговременной памяти команды (слой L1 — атомарные памятки: факты, правила, события). Запрос по-русски. Ищет во ВСЕЙ общей памяти.",
  { query: z.string().describe("Поисковый запрос (по-русски)"), limit: z.number().optional().describe("Сколько результатов (по умолчанию 5)") },
  async ({ query, limit }) => {
    const r = JSON.parse(await gw("/search/memories", { query, limit: limit || 5 }));
    return { content: [{ type: "text", text: `strategy=${r.strategy} total=${r.total}\n${r.results}` }] };
  },
);

server.tool(
  "conversation_search",
  "Поиск по исходным диалогам (слой L0) — дословные формулировки из прошлых разговоров.",
  { query: z.string().describe("Поисковый запрос"), limit: z.number().optional().describe("Сколько результатов (по умолчанию 5)") },
  async ({ query, limit }) => {
    const r = JSON.parse(await gw("/search/conversations", { query, limit: limit || 5 }));
    return { content: [{ type: "text", text: `total=${r.total}\n${r.results}` }] };
  },
);

server.tool(
  "memory_capture",
  "Записать реплику диалога в общую память команды (фоновая экстракция превратит факты в памятки). Вызывай после содержательного обмена.",
  {
    user_content: z.string().describe("Реплика пользователя"),
    assistant_content: z.string().optional().describe("Ответ ассистента (если был)"),
  },
  async ({ user_content, assistant_content }, extra) => {
    const session = extra?.sessionId || sessionOf({});
    const r = JSON.parse(await gw("/capture", {
      user_content,
      assistant_content: assistant_content || "(записано без ответа ассистента)",
      session_key: session,
      user_id: USER,
    }));
    return { content: [{ type: "text", text: `записано: l0_recorded=${r.l0_recorded}, сессия=${session}` }] };
  },
);

server.tool(
  "memory_recall",
  "Собрать контекст памяти по запросу перед ответом (перед вопросами «как мы делали X?», «что решили про Y?»).",
  { query: z.string().describe("О чём вспомнить") },
  async ({ query }, extra) => {
    const session = extra?.sessionId || sessionOf({});
    const r = JSON.parse(await gw("/recall", { query, session_key: session }));
    return { content: [{ type: "text", text: r.context || "(память пуста)" }] };
  },
);

server.tool(
  "memory_session_end",
  "Завершить сессию памяти: форсирует обработку накопленных реплик. Вызывай в конце содержательной работы.",
  {},
  async (args, extra) => {
    const session = extra?.sessionId || sessionOf({});
    const r = JSON.parse(await gw("/session/end", { session_key: session }));
    return { content: [{ type: "text", text: `flushed=${r.flushed}, сессия=${session}` }] };
  },
);

const httpServer = createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "GET" && (url === "/health" || url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "sius-memory-tdai", gateway: GW }));
    return;
  }
  if (req.method !== "POST" || url !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST /mcp only" }));
    return;
  }
  // Stateless-паттерн из документации SDK: новый транспорт на каждый запрос.
  try {
    let body = "";
    for await (const c of req) body += c;
    const parsed = body ? JSON.parse(body) : undefined;
    canary(`POST method=${parsed?.method} id=${parsed?.id} batch=${Array.isArray(parsed)}`);

    // Фирменный зонд ZCode: клиент до initialize спрашивает поддерживаемые
    // версии и возможности. Без ответа клиент считает сервер неподходящим.
    // ВАЖНО: с обновления 3.17+ клиент признаёт сервер «modern» только если
    // его собственная modern-версия ("2026-07-28", ZCode: o_o/Zkn) входит в
    // supportedVersions ответа. Иначе — ветка legacy, corrective-повторы и
    // ~30-секундный таймаут в UI (mcp-sync.listWorkspaceMcpServerStatuses),
    // хотя сам хендшейк и tools/call при этом работают. Держим modern-версию
    // первой строкой; дату брать из бандла клиента (grep -o 'o_o="[^"]*"').
    if (parsed && !Array.isArray(parsed) && parsed.method === "server/discover") {
      const wantsSSE = String(req.headers.accept || "").includes("text/event-stream");
      const result = {
        ttlMs: 300000,
        cacheScope: "private",
        supportedVersions: ["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"],
        capabilities: { tools: { listChanged: false } },
      };
      if (wantsSSE) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result })}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
      }
      canary("server/discover — версии и возможности отправлены");
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    canary(`ошибка запроса: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: e.message } }));
    }
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  canary(`SDK-сервер слушает http://127.0.0.1:${PORT}/mcp; gateway=${GW}; user=${USER}`);
  console.log(`[${new Date().toISOString()}] sius-memory-tdai (SDK) на :${PORT}`);
});
