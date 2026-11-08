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
  handleAtomicQuery,
  handleConversationSearch,
  handleConversationAdd,
  handleConversationQuery,
  handleConversationCount,
  handleAtomicCount,
  handleScenarioLs,
  handleScenarioRead,
  handleScenarioCount,
  handleCoreRead,
  handleCoreCount,
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
  /** [pilot-patch] MetadataService для инструментов подключения агентов (W2). */
  getMetadataService: (instanceId: string) => Promise<{
    createAgent(input: { team_id: string; owner_user_id: string; name: string; description?: string }): Promise<{ agent_id: string; name: string }>;
    getAgentById(agentId: string): Promise<{ agent_id: string; name: string; team_id: string } | null>;
    listAgentsByTeam(teamId: string): Promise<{ items: Array<{ agent_id: string; name: string }> }>;
  }>;
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
  // ── Группа 1: подключение нового агента (W2) ──
  {
    name: "memory_connect",
    description:
      "Подключение агента к памяти отдела: регистрирует агента в команде «Отдел поддержки 1С» (или находит существующего по имени) и возвращает его параметры (team_id/agent_id/user_id). Вызывай один раз при первом подключении.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Имя агента, например «DSH-аналитик»." },
        description: { type: "string", description: "Назначение агента (необязательно)." },
        user_id: { type: "string", description: "Владелец (необязательно; по умолчанию — владелец команды)." },
      },
      required: ["agent_name"],
    },
  },
  {
    name: "memory_whoami",
    description:
      "Кто я в памяти: текущее пространство (team/agent/user), имя агента, счётчики памяти. Для диагностики подключения.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_get_rules",
    description: "Правила и дисциплина работы с памятью отдела для подключённого агента.",
    inputSchema: { type: "object", properties: {} },
  },
  // ── Группа 3: обзорные (W4) ──
  {
    name: "memory_persona",
    description: "Персона отдела (ядро памяти L3): нарратив о пользователях и принципах работы.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_scenes",
    description: "Список сцен памяти (L2): имена и краткие описания накопленных сцен.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_scene_read",
    description: "Прочитать сцену памяти (L2) целиком по имени файла.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Имя файла сцены (из memory_scenes)." } },
      required: ["path"],
    },
  },
  {
    name: "memory_stats",
    description: "Счётчики памяти: записи диалогов (L0), памятки (L1), сцены (L2), персона (L3).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_recent",
    description: "Последние записи диалогов (L0) — что недавно попадало в память.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Сколько записей (по умолчанию 10)." } },
    },
  },
  {
    name: "error_lessons",
    description:
      "Канал инструментальных ошибок: уроки (правила предотвращения повторных ошибок). Без query — все уроки; с query — релевантные.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Поисковый запрос (необязательно)." },
        limit: { type: "number", description: "Сколько результатов (по умолчанию 20)." },
      },
    },
  },
  {
    name: "error_recent",
    description: "Канал инструментальных ошибок: последние зафиксированные ошибки инструментов.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Сколько ошибок (по умолчанию 10)." } },
    },
  },
];

// Правила работы с памятью для подключённых агентов (get_rules).
const RULES_TEXT = `Правила работы с памятью отдела (TDAM):
1. ПЕРЕД ответом по рабочим темам (проекты отдела, 1С, инфраструктура, память, «как мы делали X?», «что решили про Y?») — вызывай memory_search сам, без команды пользователя.
2. ПОСЛЕ содержательного обмена с устойчивым фактом (решение, причина сбоя, регламент, устойчивый факт) — вызывай memory_capture сам. НЕ писать: пересказ диалога, разовые мелочи, промежуточные рассуждения, успешные вызовы инструментов.
3. В конце содержательной работы — memory_session_end.
4. При обращении к памяти пиши пользователю одну строку: [память: искал «<запрос>» → N записей] или [память: записал «<суть>»].
5. Работай только в пространстве своей команды; ошибки инструментов — в канал ошибок (memory_capture, они фиксируются хуками автоматически).`;

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

// Карта v3-обработчиков, доступных MCP-инструментам (данные L0–L3).
const V3_HANDLERS: Record<string, (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<unknown>> = {
  "/v3/atomic/search": handleAtomicSearch,
  "/v3/atomic/query": handleAtomicQuery,
  "/v3/atomic/count": handleAtomicCount,
  "/v3/conversation/search": handleConversationSearch,
  "/v3/conversation/add": handleConversationAdd,
  "/v3/conversation/query": handleConversationQuery,
  "/v3/conversation/count": handleConversationCount,
  "/v3/scenario/ls": handleScenarioLs,
  "/v3/scenario/read": handleScenarioRead,
  "/v3/scenario/count": handleScenarioCount,
  "/v3/core/read": handleCoreRead,
  "/v3/core/count": handleCoreCount,
};

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
  const handler = V3_HANDLERS[pathname];
  if (!handler) return { code: -32601, message: `no v3 handler for ${pathname}` };
  // Трио идёт и в тело (v3-обработчики читают idFields из body, как панель),
  // и в deps.requestIsolation (поисковые фильтры). Аргументы перекрывают.
  const fullBody = {
    team_id: iso.teamId,
    agent_id: iso.agentId,
    user_id: iso.userId,
    ...body,
  };
  return await handler(fullBody, auth, requestId, perCallDeps) as unknown as V3Envelope;
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
      case "memory_connect": {
        const agentName = String(args.agent_name ?? "").trim();
        if (!agentName) return text("agent_name обязателен", true);
        const metaSvc = await ctx.getMetadataService("default");
        const page = await metaSvc.listAgentsByTeam(iso.teamId);
        const found = (page.items ?? []).find(a => a.name === agentName);
        let agentId: string;
        let created = false;
        if (found) {
          agentId = found.agent_id;
        } else {
          const createdAgent = await metaSvc.createAgent({
            team_id: iso.teamId,
            owner_user_id: String(args.user_id || iso.userId),
            name: agentName,
            ...(args.description ? { description: String(args.description) } : {}),
          });
          agentId = createdAgent.agent_id;
          created = true;
        }
        return text(JSON.stringify({
          connected: true,
          created,
          team_id: iso.teamId,
          agent_id: agentId,
          agent_name: agentName,
          user_id: iso.userId,
          note: "Передавайте agent_id/user_id аргументами team_id/agent_id/user_id или заголовками x-tdai-*; без них вы в пространстве по умолчанию шлюза. Правила: инструмент memory_get_rules.",
        }, null, 2));
      }
      case "memory_whoami": {
        const metaSvc = await ctx.getMetadataService("default");
        const agent = await metaSvc.getAgentById(iso.agentId).catch(() => null);
        const cL0 = await callV3(ctx, iso, "/v3/conversation/count", {});
        const cL1 = await callV3(ctx, iso, "/v3/atomic/count", {});
        const dL0 = cL0.data as { total?: number } | undefined;
        const dL1 = cL1.data as { total?: number } | undefined;
        return text(JSON.stringify({
          team_id: iso.teamId, agent_id: iso.agentId, user_id: iso.userId,
          agent_name: agent?.name ?? "(агент не найден в этой команде)",
          counts: { l0: dL0?.total ?? "?", l1: dL1?.total ?? "?" },
        }, null, 2));
      }
      case "memory_get_rules":
        return text(RULES_TEXT);
      case "memory_persona": {
        const r = await callV3(ctx, iso, "/v3/core/read", {});
        if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
        const d = r.data as { content?: string } | undefined;
        return text((d?.content ?? "").trim() || "(персона пуста)");
      }
      case "memory_scenes": {
        const r = await callV3(ctx, iso, "/v3/scenario/ls", {});
        if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
        const d = r.data as { entries?: Array<{ path?: string }> } | undefined;
        const entries = d?.entries ?? [];
        return text(entries.length
          ? entries.map(e => `- ${e.path ?? "?"}`).join("\n")
          : "(сцен нет)");
      }
      case "memory_scene_read": {
        const r = await callV3(ctx, iso, "/v3/scenario/read", { path: String(args.path ?? "") });
        if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
        const d = r.data as { content?: string } | undefined;
        return text((d?.content ?? "").trim() || "(сцена пуста)");
      }
      case "memory_stats": {
        const c = async (ep: string) => {
          const r = await callV3(ctx, iso, ep, {});
          const d = r.data as { total?: number } | undefined;
          return d?.total ?? "?";
        };
        const [l0, l1, l2, l3] = await Promise.all([
          c("/v3/conversation/count"), c("/v3/atomic/count"), c("/v3/scenario/count"), c("/v3/core/count"),
        ]);
        return text(JSON.stringify({ l0_диалоги: l0, l1_памятки: l1, l2_сцены: l2, l3_персона: l3 }, null, 2));
      }
      case "memory_recent": {
        const r = await callV3(ctx, iso, "/v3/conversation/query", { limit: Number(args.limit) || 10 });
        if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
        const d = r.data as { messages?: Array<{ role?: string; content?: string; recorded_at?: string }> } | undefined;
        const msgs = d?.messages ?? [];
        return text(msgs.length
          ? msgs.map(m => `- [${m.recorded_at ?? ""}] [${m.role}] ${(m.content ?? "").slice(0, 160)}`).join("\n")
          : "(записей нет)");
      }
      case "error_lessons": {
        const limit = Number(args.limit) || 20;
        if (args.query) {
          const r = await callV3(ctx, iso, "/v3/atomic/search", { query: String(args.query), limit, type: "work_method" });
          if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
          const d = r.data as { items?: Array<{ content?: string; background?: string }> } | undefined;
          return text((d?.items ?? []).length
            ? (d?.items ?? []).map(i => `- ${i.content}${i.background ? ` [сцена: ${i.background}]` : ""}`).join("\n")
            : "(уроков по запросу нет)");
        }
        const r = await callV3(ctx, iso, "/v3/atomic/query", { type: "work_method", limit });
        if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
        const d = r.data as { items?: Array<{ content?: string }> } | undefined;
        return text((d?.items ?? []).length
          ? (d?.items ?? []).map(i => `- ${i.content}`).join("\n")
          : "(уроков нет)");
      }
      case "error_recent": {
        const r = await callV3(ctx, iso, "/v3/conversation/search", {
          query: "ОШИБКА инструмента", limit: Number(args.limit) || 10,
        });
        if (r.code !== 0) return text(`ошибка шлюза: ${r.message ?? r.code}`, true);
        const d = r.data as { messages?: Array<{ role?: string; content?: string }> } | undefined;
        const msgs = d?.messages ?? [];
        return text(msgs.length ? msgs.map(m => `- ${(m.content ?? "").slice(0, 200)}`).join("\n") : "(ошибок не найдено)");
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
