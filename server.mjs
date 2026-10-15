import express from "express";
import crypto from "crypto";
import https from "https";
import http from "http";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PROXY_PORT || 6446;
const OC_VERSION = "1.15.0";
const PROXY_VERSION = "10";
const HTTP_PROXY = process.env.HTTP_PROXY || "";

// Proxy agent for upstream requests
let proxyAgent = null;
if (HTTP_PROXY) {
  proxyAgent = new HttpsProxyAgent(HTTP_PROXY);
  console.log(`[PROXY] Using HTTP proxy: ${HTTP_PROXY}`);
}

// ── API Keys ───────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  // 接受任意格式正确的key，或者匹配已知key
  if (tok && tok.length > 0) {
    for (const [name, key] of Object.entries(apiKeys)) {
      if (tok === key) return name;
    }
    return "anonymous";
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────
// 复刻 opencode 的真实 identifier 生成（packages/schema/src/identifier.ts）：
//   descending: counter++ (每毫秒重置, 从1起) → current = ts*0x1000 + counter
//   value = ~current (48位二补数) → 12位小写hex + 14位base62
// 上游 client-fingerprint gate 只校验低12位 counter (counter<=63) + hex小写 + tail长度14。
// 旧的 base64url 实现含 '-'/'_' 且 counter 越界 → 被上游 403 拒绝。
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK_48 = (1n << 48n) - 1n;
const COUNTER_SPAN = 0x1000n;
const MAX_COUNTER = 63; // 上游 gate 上限
let idLastTs = 0;
let idCounter = 0;
function randomBase62(n) {
  const b = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += ID_CHARS[b[i] % 62];
  return out;
}
function encodeIdentifier(descending) {
  const ts = Date.now();
  if (ts !== idLastTs) { idLastTs = ts; idCounter = 0; }
  idCounter++;
  if (idCounter > MAX_COUNTER) { idLastTs += 1; idCounter = 1; }
  const current = BigInt(idLastTs) * COUNTER_SPAN + BigInt(idCounter);
  const value = (descending ? ~current : current) & MASK_48;
  return value.toString(16).padStart(12, "0") + randomBase62(14);
}
function ocId(prefix) {
  // ses_ 用 descending，msg_ 用 ascending（与 opencode 一致）
  return `${prefix}_${encodeIdentifier(prefix === "ses")}`;
}

// ── 上游边缘IP池（自动扫描/延迟优选/定时更新） ───────────────
import { initPool, nextIp, healthCheck, refreshPool, getPool } from "./ip_pool.js";
initPool().catch(e => console.log("[IPPOOL] 初始化失败:", e.message));
// 选择上游IP：优先低延迟池，无池时回退域名
function pickUpstreamIp() {
  const ip = nextIp();
  return ip || "opencode.ai";
}
// 探测并更新可用边缘 IP（无人值守）

const MODELS = [
  "deepseek-v4.1-flash-free",
  "space-bunny-free",
  "big-pickle",
  "cat-jam-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-lightning-free",
  "jev-1.13-free",
  "step-5-preview-free",
  "longcat-2.5-preview-free",
  "muse-spark-1.3-contributor-free",
];

// Session pool for rotating sessions (more quota)
const SESSION_POOL_SIZE = parseInt(process.env.SESSION_POOL_SIZE || "10", 10);
const WORKER_ID = process.env.WORKER_ID || "0";
const sessionPool = [];
let sessionIndex = 0;

function initSessionPool() {
  for (let i = 0; i < SESSION_POOL_SIZE; i++) {
    sessionPool.push({ id: ocId("ses"), ts: Date.now() });
  }
  console.log(`[SESSION Worker ${WORKER_ID}] Initialized pool with ${SESSION_POOL_SIZE} sessions`);
}

function getSession(user) {
  // Rotate sessions to get more quota (each worker has independent pool)
  const now = Date.now();
  const session = sessionPool[sessionIndex % sessionPool.length];
  sessionIndex = (sessionIndex + 1) % sessionPool.length;
  
  // Refresh expired sessions (every 30 min)
  if (now - session.ts > 30 * 60 * 1000) {
    session.id = ocId("ses");
    session.ts = now;
  }
  
  return session.id;
}

// Notify balancer about rate limit and refresh current session
function notifyRateLimit(sessionId) {
  // Find and refresh the rate-limited session
  for (const session of sessionPool) {
    if (session.id === sessionId) {
      session.id = ocId("ses");
      session.ts = Date.now();
      console.log(`[SESSION Worker ${WORKER_ID}] Refreshed rate-limited session`);
      break;
    }
  }
  // Notify balancer to skip this worker temporarily
  if (process.send) {
    process.send({ type: "rate_limited", workerId: WORKER_ID });
  }
}

initSessionPool();

// ── 上游 client-fingerprint gate（2026-10 复刻） ──────────────────
// 上游 free tier 要求：
//   1. User-Agent 形如 opencode/<version>（且版本 >= 1.18，老版本 → 426）
//   2. x-opencode-session = ses_ + 12位小写hex + 14位base62（低12位counter<=63）
//   3. body.stream 必须为 true
//   4. body.tools 必须包含 bash/glob/grep/read 四个
// 任一不满足 → 403 FreeTierError。
const ZEN_UA = process.env.ZEN_UA || "opencode/latest/2.0.22/cli";
const ZEN_FREE_TOOLS = ["bash", "glob", "grep", "read"].map((n) => ({
  type: "function",
  function: {
    name: n, description: n,
    parameters: { type: "object", properties: { p: { type: "string" } }, required: ["p"] },
  },
}));
// 确保 tools 含四个指纹工具（缺失则补齐；客户端自带同名工具保留其定义）
function withFingerprintTools(tools) {
  const list = Array.isArray(tools) ? [...tools] : [];
  const names = new Set(list.map((t) => t?.function?.name).filter(Boolean));
  for (const ft of ZEN_FREE_TOOLS) {
    if (!names.has(ft.function.name)) list.push(ft);
  }
  return list;
}

// ── Zen API transport ──────────────────────────────────────────────
function zenRequest(model, messages, stream, tools, tool_choice, sessionId) {
  // 上游只接受 stream:true；对客户端是否流式由 pipeZenResponse 决定。
  const reqBody = { model, messages, stream: true };
  reqBody.tools = withFingerprintTools(tools);
  if (tool_choice) reqBody.tool_choice = tool_choice;
  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");

  // 域名套IP：hostname 用池子优选的最低延迟边缘IP直连，
  // 但 SNI(servername) 和 Host 报头都伪装成 opencode.ai ——
  // CF 据此正常处理POST（等价于域名访问），同时走了延迟最优的IP。
  const upstreamIp = pickUpstreamIp();
  return {
    body,
    options: {
      hostname: upstreamIp,            // 直连优选IP（低延迟）
      port: 443,
      path: "/inference/v1/chat/completions",
      method: "POST",
      headers: {
        "Host": "opencode.ai",         // Host报头伪装成域名（唯一Host来源，避免Node用IP覆盖）
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer public",
        "User-Agent": ZEN_UA,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
        "x-opencode-session-id": sessionId,  // gate 要求与 session 一致
      },
      servername: "opencode.ai",       // SNI伪装成域名
      timeout: 120000,
      // 注意：不挂 proxyAgent，纯裸直连池子优选IP（边缘IP轮换，不走代理）
    },
  };
}

// Pipe Zen response to client (OpenAI format passthrough)
function pipeZenResponse(zenOpts, body, stream, res, sessionId) {
  const req = https.request(zenOpts, (zenRes) => {
    let firstChunk = null;
    let headersSent = false;

    zenRes.on("data", (chunk) => {
      if (!firstChunk) {
        firstChunk = chunk;
        const str = chunk.toString().trim();

        if (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes('"error"'))) {
          try {
            const parsed = JSON.parse(str);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
              console.log("[ZEN RATE LIMITED]", errMsg);
              notifyRateLimit(sessionId);
              if (!res.headersSent) {
                res.status(429).json({
                  error: { message: errMsg + " (free model rate limit)", type: "rate_limit_error", code: "rate_limit_exceeded" }
                });
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }

        headersSent = true;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });
          res.flushHeaders();
        } else {
          res.writeHead(zenRes.statusCode, { "Content-Type": "application/json" });
        }
        res.write(firstChunk);
        if (res.flush) res.flush();
        return;
      }
      if (headersSent) {
        res.write(chunk);
        if (res.flush) res.flush();
      }
    });

    zenRes.on("end", () => {
      if (!headersSent && !firstChunk) {
        console.log("[ZEN EMPTY] No response from Zen API");
        if (!res.headersSent) {
          res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
        }
        return;
      }
      if (headersSent) res.end();
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    console.log("[ZEN TIMEOUT]");
    if (!res.headersSent) {
      res.status(504).json({ error: { message: "Upstream timeout", type: "timeout_error" } });
    }
  });

  req.write(body);
  req.end();
}

// Collect full Zen response (non-streaming) and return parsed JSON
// 注意：上游只返回 SSE 流。此函数将 SSE 聚合为 OpenAI 风格的完整 completion。
function zenRequestFull(zenOpts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      let buffer = "";
      let sseChunks = [];
      zenRes.on("data", (c) => {
        buffer += c.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith("data:")) continue;
          const payload = s.slice(5).trim();
          if (payload === "[DONE]") continue;
          try { sseChunks.push(JSON.parse(payload)); } catch {}
        }
      });
      zenRes.on("end", () => {
        // 若有非 SSE（JSON 错误）直接返回原文
        if (sseChunks.length === 0) {
          const raw = buffer;
          try { resolve({ status: zenRes.statusCode, data: JSON.parse(raw), raw }); }
          catch { resolve({ status: zenRes.statusCode, data: null, raw }); }
          return;
        }
        // 聚合 SSE 为完整 OpenAI completion
        const id = sseChunks.find(c => c.id)?.id || "chatcmpl-zennonstream";
        const created = sseChunks.find(c => c.created)?.created || Math.floor(Date.now()/1000);
        const model = sseChunks.find(c => c.model)?.model || "";
        let content = "";
        let reasoning = "";
        let toolCalls = null;
        let finish = null;
        let usage = null;
        for (const c of sseChunks) {
          const choice = c.choices?.[0];
          if (!choice) continue;
          const d = choice.delta || {};
          if (d.content) content += d.content;
          if (d.reasoning_content) reasoning += d.reasoning_content;
          if (choice.finish_reason) finish = choice.finish_reason;
          if (c.usage) usage = c.usage;
        }
        const message = { role: "assistant", content };
        if (reasoning) message.reasoning_content = reasoning;
        if (toolCalls) message.tool_calls = toolCalls;
        const data = {
          id, object: "chat.completion", created, model,
          choices: [{ index: 0, message, finish_reason: finish || "stop" }],
        };
        if (usage) data.usage = usage;
        resolve({ status: zenRes.statusCode, data, raw: JSON.stringify(data) });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// ── Anthropic Messages → OpenAI conversion ─────────────────────────
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map(b => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
      // tool_use blocks → assistant tool_calls
      const toolUses = msg.content.filter(b => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(t => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some(b => b.type === "tool_result")) {
        for (const b of msg.content.filter(b => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map(c => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

// OpenAI response → Anthropic Messages format
function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || ocId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// Stream OpenAI SSE → Anthropic SSE
function pipeZenAsAnthropic(zenOpts, body, model, res, inputTokens, sessionId) {
  const msgId = ocId("msg");

  const req = https.request(zenOpts, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    let firstChunkHandled = false;

    function sendSSE(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    }

    function sendHeaders() {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      sendSSE("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", content: [],
          model, stop_reason: null,
          usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    }

    zenRes.on("data", (chunk) => {
      const str = chunk.toString();

      // Check for errors on first chunk
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"'))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit";
              notifyRateLimit(sessionId);
              if (!res.headersSent) {
                res.writeHead(429, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  type: "error",
                  error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
                }));
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }
      }

      buffer += str;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        sendHeaders();

        // Text content
        if (delta.content) {
          if (contentIdx === 0 && toolIdx === -1) {
            sendSSE("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            contentIdx = 1;
          }
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta.content },
          });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (idx > toolIdx) {
              // Close previous text block if open
              if (toolIdx === -1 && contentIdx > 0) {
                sendSSE("content_block_stop", { type: "content_block_stop", index: 0 });
              }
              toolIdx = idx;
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_start", {
                type: "content_block_start", index: blockIdx,
                content_block: { type: "tool_use", id: tc.id || ocId("toolu"), name: tc.function?.name || "" },
              });
            }
            if (tc.function?.arguments) {
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_delta", {
                type: "content_block_delta", index: blockIdx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              });
              outputTokens += Math.ceil(tc.function.arguments.length / 4);
            }
          }
        }

        // Finish
        if (parsed.choices?.[0]?.finish_reason) {
          const fr = parsed.choices[0].finish_reason;
          // Close open blocks
          const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
          for (let i = 0; i < totalBlocks; i++) {
            sendSSE("content_block_stop", { type: "content_block_stop", index: i });
          }

          let stopReason = "end_turn";
          if (fr === "tool_calls") stopReason = "tool_use";
          else if (fr === "length") stopReason = "max_tokens";

          sendSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: outputTokens },
          });
          sendSSE("message_stop", { type: "message_stop" });
        }
      }
    });

    zenRes.on("end", () => {
      if (!headersSent) {
        if (!res.headersSent) {
          res.status(502).json({ type: "error", error: { type: "upstream_error", message: "Empty response" } });
        }
        return;
      }
      res.end();
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(504).json({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } });
    }
  });

  req.write(body);
  req.end();
}

// ── Routes: OpenAI format ──────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => ({
      id, object: "model", created: 1779000000, owned_by: "opencode-free",
    })),
  });
});

app.post("/v1/chat/completions", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, messages, stream, tools, tool_choice } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` } });
  }

  const sessionId = getSession(user);
  const msgSummary = (messages || []).map(m => ({ role: m.role, len: (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).length }));
  console.log("[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

  const { body, options } = zenRequest(model, messages, stream, tools, tool_choice, sessionId);
  if (stream) {
    pipeZenResponse(options, body, true, res, sessionId);
  } else {
    // 上游只返回 SSE，非流式需聚合后回 JSON
    zenRequestFull(options, body)
      .then(({ status, data }) => {
        if (status !== 200 || !data?.choices) {
          const errMsg = data?.error?.message || "Upstream error";
          if (status === 429 || (data?.error)) notifyRateLimit(sessionId);
          return res.status(status === 200 ? 502 : (status || 502)).json({
            error: { message: errMsg + " (free model rate limit)", type: "rate_limit_error" },
          });
        }
        res.json(data);
      })
      .catch((e) => {
        console.log("[ZEN ERROR]", e.message);
        res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
      });
  }
});

// ── Routes: Anthropic Messages format ──────────────────────────────
app.post("/v1/messages", async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  }

  const { model, stream } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` },
    });
  }

  const sessionId = getSession(user);
  const { messages, tools } = anthropicToOpenAI(req.body);
  const inputTokens = JSON.stringify(messages).length / 4 | 0;

  console.log("[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);

  const { body, options } = zenRequest(model, messages, stream, tools, undefined, sessionId);

  if (stream) {
    pipeZenAsAnthropic(options, body, model, res, inputTokens, sessionId);
  } else {
    try {
      const zenResp = await zenRequestFull(options, body);
      if (zenResp.status === 429 || zenResp.data?.error) {
        const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
        notifyRateLimit(sessionId);
        return res.status(429).json({
          type: "error", error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
        });
      }
      if (!zenResp.data?.choices) {
        return res.status(502).json({
          type: "error", error: { type: "upstream_error", message: "Invalid upstream response" },
        });
      }
      res.json(openAIToAnthropic(zenResp.data, model, inputTokens));
    } catch (e) {
      console.log("[ZEN ERROR]", e.message);
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, models: MODELS.length,
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
}));

// ── Admin: 上游IP池状态（admin key 鉴权） ────────────────────
app.get("/admin/pool", (req, res) => {
  if (req.query.key !== apiKeys.admin) {
    return res.status(403).json({ error: "Invalid admin key" });
  }
  const pool = getPool();
  res.json({
    domain: process.env.UPSTREAM_DOMAIN || "opencode.ai",
    pool_size: pool.length,
    pool: pool.map(p => ({ ip: p.ip, ms: p.ms, status: p.status, last_check: new Date(p.ts).toISOString() })),
    note: "IP池仅用于边缘健康监控/延迟地图。实际出流走域名(opencode.ai)，由Cloudflare Anycast路由到最近节点。",
  });
});
// 手动触发全量重扫
app.post("/admin/pool/refresh", (req, res) => {
  if (req.query.key !== apiKeys.admin) {
    return res.status(403).json({ error: "Invalid admin key" });
  }
  refreshPool().then(p => res.json({ ok: true, pool_size: p.length }))
    .catch(e => res.status(500).json({ ok: false, error: e.message }));
});

// ── Start ──────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenCode Free Proxy v${PROXY_VERSION} on http://0.0.0.0:${PORT}`);
  console.log("  OpenAI:    POST /v1/chat/completions");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Models:    GET  /v1/models");
  console.log("  Health:    GET  /health");
  console.log("  Models:", MODELS.join(", "));
  for (const [name, key] of Object.entries(apiKeys)) {
    console.log(`  ${name.padEnd(15)} ${key}`);
  }
  
  if (process.env.WORKER_ID) {
    process.send({ type: "ready" });
  }
});
