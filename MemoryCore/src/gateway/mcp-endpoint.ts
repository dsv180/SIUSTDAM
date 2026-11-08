/**
 * [pilot-patch] MCP-эндпоинт, вшитый в шлюз.
 *
 * Модуль «mcp-подключение» (решение заказчика 08.11): MCP — единственный
 * штатный интерфейс работы с памятью. Streamable-HTTP, stateless, JSON-ответы.
 * Минимальная поверхность протокола: initialize / notifications/initialized /
 * tools/list / tools/call / ping + проприетарный зонд ZCode `server/discover`.
 *
 * Инструменты переиспользуют собственные v3-обработчики шлюза (route table),
 * поэтому семантика (изоляция, регистрация chat_memory-актива, запуск
 * конвейера дистилляции) идентична /v3/*. Изоляция: заголовки x-tdai-* запроса,
 * иначе дефолты шлюза (TDAI_MCP_TEAM_ID / TDAI_MCP_AGENT_ID / TDAI_MCP_USER_ID),
 * иначе "default". Трио в аргументах инструмента перекрывает заголовки.
 *
 * Откат: удалить этот файл и блок вызова в server.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  handleAtomicSearch,
  handleConversationSearch,
  handleConversationAdd,
} from "./v2-router.js";
import type { V2RouterDeps } from "./v2-router.js";
import type { V2AuthContext } from "./v2-schemas.js";

const TAG = "[mcp-endpoint]";
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpIsolation {
  teamId: string;
  agentId: string;
  userId: string;
}

export interface McpEndpointCtx {
  v2Deps: V2RouterDeps;
  serviceId: string;
  core: {
    handleBeforeRecall: (
      userText: string,
      sessionKey: string,
      isolation?: { teamId?: string; agentId?: string; userId?: string },
    ) => Promise<{ appendSystemContext?: string }>;
    handleSessionEnd: (
      sessionKey: string,
      teamId?: string,
      agentId?: string,
    ) => Promise<void>;
  };
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  defaultIsolation: McpIsolation;
}

// ── Инструменты (контракт синхронизирован с 02-заданием модуля, W3) ──

const TOOLS = [
  {
    name: "memory_search",
    description:
      "Поиск по долговременной памяти команды (слой L1 — атомарные памятки: факты, правила, события). Запрос по-русски. Ищет в пространстве команды.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Поисковый запрос (по-русски)." },
        limit: { type: "number", description: "Сколько результатов (по умолчанию 5)." },
        type: { type: "string", description: "Фильтр типа: instruction|episodic|work_method|..." },
      },
      required: ["query"],
    },
  },
  {
    name: "conversation_search",
    description:
      "Поиск по исходным диалогам (слой L0) — дословные формулировки из прошлых разговоров.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Поисковый запрос." },
        limit: { type: "number", description: "Сколько результатов (по умолчанию 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_capture",
    description:
      "Записать реплику диалога в общую память команды (фоновая экстракция превратит факты в памятки). Вызывай после содержательного обмена.",
    inputSchema: {
      type: "object",
      properties: {
        user_content: { type: "string", description: "Реплика пользователя." },
        assistant_content: { type: "string", description: "Ответ ассистента (если был)." },
        session_id: { type: "string", description: "Идентификатор сессии (необязательно; генерируется на процесс)." },
      },
      required: ["user_content"],
    },
  },
  {
    name: "memory_recall",
    description:
      "Собрать контекст памяти по запросу перед ответом (перед вопросами «как мы делали X?», «что решили про Y?»). Персона + сцены + памятки.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "О чём вспомнить." } },
      required: ["query"],
    },
  },
  {
    name: "memory_session_end",
    description:
      "Завершить сессию памяти: форсирует обработку накопленных реплик. Вызывай в конце содержательной работы.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Вспомогательное ──

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function headerStr(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function isoFromRequest(req: IncomingMessage, ctx: McpEndpointCtx): McpIsolation {
  return {
    teamId: headerStr(req, "x-tdai-team-id") || ctx.defaultIsolation.teamId,
    agentId: headerStr(req, "x-tdai-agent-id") || ctx.defaultIsolation.agentId,
    userId: headerStr(req, "x-tdai-user-id") || ctx.defaultIsolation.userId,
  };
}

interface V3Envelope { code: number; message?: string; data?: unknown }

async function callV3(
  ctx: McpEndpointCtx,
  iso: McpIsolation,
  pathname: string,
  body: Record<string, unknown>,
): Promise<V3Envelope> {
  const auth: V2AuthContext = { apiKey: "standalone-mcp", serviceId: ctx.serviceId } as V2AuthContext;
  const requestId = `mcp-${randomUUID().slice(0, 12)}`;
  // Изоляция подставляется в deps на каждый вызов — тот же механизм, что
  // dispatchV2Request делает для HTTP-запросов /v3/*.
  const perCallDeps = {
    ...ctx.v2Deps,
    requestIsolation: { teamId: iso.teamId, userId: iso.userId, agentId: iso.agentId },
    requestIsolationMissing: [] as string[],
  } as V2RouterDeps;
  const handler =
    pathname === "/v3/atomic/search" ? handleAtomicSearch :
    pathname === "/v3/conversation/search" ? handleConversationSearch :
    pathname === "/v3/conversation/add" ? handleConversationAdd :
    undefined;
  if (!handler) return { code: -32601, message: `no v3 handler for ${pathname}` };
  return await handler(body, auth, requestId, perCallDeps) as unknown as V3Envelope;
}

function fmtItems(items: Array<{ type?: string; content?: string; score?: number; background?: string }>): string {
  if (!items.length) return "(пусто)";
  return items.map(i => {
    const score = typeof i.score === "number" ? ` (score ${i.score.toFixed(2)})` : "";
    const scene = i.background ? ` [сцена: ${i.background}]` : "";
    return `- [${i.type ?? "?"}${score}]${scene} ${i.content ?? ""}`;
  }).join("\n");
}

// ── Обработчики инструментов ──

async function callTool(
  ctx: McpEndpointCtx,
  req: IncomingMessage,
  iso: McpIsolation,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
  try {
    switch (name) {
      case "memory_search": {
        const body: Record<string, unknown> = { query: String(args.query ?? ""), limit: Number(args.limit) || 5 };
        if (args.type) body.type = args.type;
        const r = await callV3(ctx, iso, "/v3/atomic/search", body);
        if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
        const d = r.data as { items?: Array<{ type?: string; content?: string; score?: number; background?: string }> } | undefined;
        return text(fmtItems(d?.items ?? []));
      }
      case "conversation_search": {
        const r = await callV3(ctx, iso, "/v3/conversation/search", { query: String(args.query ?? ""), limit: Number(args.limit) || 5 });
        if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
        const d = r.data as { messages?: Array<{ role?: string; content?: string }> } | undefined;
        const msgs = d?.messages ?? [];
        return text(msgs.length ? msgs.map(m => `- [${m.role}] ${m.content}`).join("\n") : "(пусто)");
      }
      case "memory_capture": {
        const session = String(args.session_id || `mcp-${iso.userId}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);
        const r = await callV3(ctx, iso, "/v3/conversation/add", {
          session_id: session,
          messages: [
            { role: "user", content: String(args.user_content ?? "") },
            { role: "assistant", content: String(args.assistant_content || "(записано без ответа ассистента)") },
          ],
        });
        if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
        const d = r.data as { accepted_ids?: string[] } | undefined;
        return text(`записано: l0=${(d?.accepted_ids || []).length} (пространство отдела), сессия=${session}`);
      }
      case "memory_recall": {
        const session = String(args.session_id || `mcp-${iso.userId}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);
        const result = await ctx.core.handleBeforeRecall(String(args.query ?? ""), session, {
          teamId: iso.teamId, agentId: iso.agentId, userId: iso.userId,
        });
        return text((result.appendSystemContext ?? "").trim() || "(память пуста)");
      }
      case "memory_session_end": {
        const session = String(args.session_id || "");
        await ctx.core.handleSessionEnd(session, iso.teamId, iso.agentId);
        return text(`flushed=true, сессия=${session}`);
      }
      default:
        return text(`неизвестный инструмент: ${name}`, true);
    }
  } catch (e) {
    ctx.logger?.error?.(`${TAG} tools/call ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return text(`ошибка: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

// ── Точка входа ──

export async function handleMcpPost(req: IncomingMessage, res: ServerResponse, ctx: McpEndpointCtx): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(await readBody(req) || "{}");
  } catch {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const id = msg.id as number | string | null | undefined;
  const method = String(msg.method ?? "");
  const reply = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id: id ?? null, result });

  // Проприетарный зонд ZCode: клиент спрашивает версии/возможности до initialize.
  if (method === "server/discover") {
    reply({
      ttlMs: 300000,
      cacheScope: "private",
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
    });
    return;
  }

  switch (method) {
    case "initialize": {
      const requested = String((msg.params as { protocolVersion?: string } | undefined)?.protocolVersion || "");
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1];
      reply({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tdam-memory", version: "1.0.0" },
      });
      return;
    }
    case "notifications/initialized":
      sendJson(res, 202, {});
      return;
    case "tools/list":
      reply({ tools: TOOLS });
      return;
    case "ping":
      reply({});
      return;
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const iso = isoFromRequest(req, ctx);
      // трио из аргументов перекрывает заголовки/дефолты
      const isoArgs: McpIsolation = {
        teamId: String(params.arguments?.team_id || iso.teamId),
        agentId: String(params.arguments?.agent_id || iso.agentId),
        userId: String(params.arguments?.user_id || iso.userId),
      };
      ctx.logger?.info?.(`${TAG} tools/call ${params.name} (team=${isoArgs.teamId}, agent=${isoArgs.agentId})`);
      const result = await callTool(ctx, req, isoArgs, String(params.name ?? ""), params.arguments ?? {});
      reply(result);
      return;
    }
    default:
      if (id === undefined || id === null) { sendJson(res, 202, {}); return; } // прочие уведомления
      sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
