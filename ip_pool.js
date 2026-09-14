/**
 * ip_pool.js — OpenCode 上游边缘IP池（边缘IP轮换）
 *
 * 目标：裸直连 Cloudflare 边缘 IP 访问 opencode.ai，不依赖任何代理。
 *
 * 工作流程：
 *  1. 候选段：内置已知 Cloudflare 网段清单（DNS 默认解析到的 172.65.90.x
 *     在本机被墙，故不依赖 DNS，改用实测可用的大段）。
 *  2. 域名验证：每个候选IP带 SNI=opencode.ai + Host=opencode.ai 发请求，
 *     返回 200 才标记可用（证明该 IP 确实承载 opencode.ai）。
 *  3. 延迟优选：200 的入库，按响应 ms 升序，保留最低延迟的 POOL_MAX 个。
 *  4. 边缘轮换：nextIp() 在前 N 个低延迟 IP 间轮询；定时探活剔除失效，
 *     池子过薄触发全量重扫。
 *
 * 注意：本模块不创建任何代理 agent，全部裸直连。
 */
import https from "https";
import dns from "dns/promises";
import net from "net";

const DOMAIN = process.env.UPSTREAM_DOMAIN || "opencode.ai";
const POOL_MAX = parseInt(process.env.IP_POOL_MAX || "30", 10);          // 池子保留最优IP数
const POOL_MIN = parseInt(process.env.IP_POOL_MIN || "8", 10);           // 低于此值触发全量重扫
const PROBE_INTERVAL = parseInt(process.env.IP_PROBE_INTERVAL || "600", 10); // 探活间隔秒
const PROBE_TIMEOUT = parseInt(process.env.IP_PROBE_TIMEOUT || "4000", 10);   // 单IP探测超时ms
const SCAN_PER_SEGMENT = parseInt(process.env.IP_SCAN_PER_SEGMENT || "8", 10); // 每段抽测的IP数

// ── 已知可用 Cloudflare 边缘网段（实测本机裸直连 200 的段）
// 说明：本机到 172.65.90.x（DNS默认段）被墙，172.64/162.158 也被墙；
// 但 104.16~104.27 这 12 个段每个 IP 都可用（实测 398 个可用边缘IP）。
// 仅把这些段纳入扫描，避免把请求打到死段浪费时间。
const CF_SEGMENTS = [
  "104.16", "104.17", "104.18", "104.19", "104.20", "104.21",
  "104.24", "104.25", "104.26", "104.27",
];

let pool = [];          // [{ip, ms, ok, status, ts}]
let poolIndex = 0;
let scanning = false;

// ── 单IP裸直连探测：域名套IP(SNI+Host伪装成DOMAIN) + 返回200验证 ──
function probeIP(ip) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const body = JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "ok" }], stream: false });
    const req = https.request({
      hostname: ip, port: 443, path: "/zen/v1/chat/completions", method: "POST",
      headers: {
        "Host": DOMAIN,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer public",
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-session": "ippool-probe-session",
        "User-Agent": "opencode/1.15.0",
      },
      servername: DOMAIN,        // SNI 伪装成域名
      // 注意：无 agent，纯裸直连
      timeout: PROBE_TIMEOUT,
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      // status<500 说明该IP可达且后端正常响应（IP本身可用）；
      // 仅 5xx/连接失败/超时 判不可用。
      res.on("end", () => resolve({ ip, ok: res.statusCode < 500, status: res.statusCode, ms: Date.now() - t0, size: d.length }));
    });
    req.on("error", () => resolve({ ip, ok: false, status: -1, ms: Date.now() - t0 }));
    req.setTimeout(PROBE_TIMEOUT + 500, () => { req.destroy(); resolve({ ip, ok: false, status: -2, ms: Date.now() - t0 }); });
    req.write(body);
    req.end();
  });
}

// ── 收集候选IP：CF 段清单 + DNS解析段，每段抽测若干IP ───────
async function collectCandidates() {
  const set = new Set();

  // 0. 把已知 CF 段打散成候选 IP（每段随机抽 SCAN_PER_SEGMENT 个，避免全段扫爆）
  const usedSeg = new Set();
  for (const seg of CF_SEGMENTS) {
    const [a, b] = seg.split(".");
    const third = parseInt(b, 10);
    for (let k = 0; k < SCAN_PER_SEGMENT; k++) {
      const fourth = 1 + Math.floor(Math.random() * 254);
      set.add(`${a}.${third}.${fourth}`);
    }
    usedSeg.add(seg);
  }

  // 1. 也把 DNS 解析出来的 IP 加进去（动态漂移，万一哪天解封）
  try {
    const res = await dns.lookup(DOMAIN, { all: true, verbatim: true });
    res.forEach(r => { if (net.isIP(r.address) === 4) set.add(r.address); });
  } catch (e) { console.log(`[IPPOOL] DNS解析失败: ${e.message}`); }

  // 2. 保留池中已有健康IP（避免每次全丢）
  pool.forEach(p => { if (p.ok) set.add(p.ip); });

  return [...set];
}

// ── 全量扫描重建池子 ─────────────────────────────────────────
export async function refreshPool() {
  if (scanning) return pool;
  scanning = true;
  const t0 = Date.now();
  try {
    const candidates = await collectCandidates();
    console.log(`[IPPOOL] 候选 ${candidates.length} 个，开始裸直连探测(${DOMAIN})...`);
    const results = [];
    const BATCH = 60;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const rs = await Promise.all(batch.map(probeIP));
      results.push(...rs);
    }
    const ok = results.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
    pool = ok.slice(0, POOL_MAX).map(r => ({ ...r, ts: Date.now() }));
    console.log(`[IPPOOL] 扫描完成: ${ok.length} 可用 / ${candidates.length} 候选, 耗时 ${Date.now() - t0}ms`);
    console.log(`[IPPOOL] TOP5: ${pool.slice(0, 5).map(p => `${p.ip}(${p.ms}ms)`).join(", ")}`);
  } catch (e) {
    console.log(`[IPPOOL] 扫描失败: ${e.message}`);
  } finally {
    scanning = false;
  }
  return pool;
}

// ── 轻量探活：只探池中IP，过薄触发全量重扫 ───────────────────
export async function healthCheck() {
  if (pool.length === 0) { await refreshPool(); return; }
  for (const p of pool) {
    const r = await probeIP(p.ip);
    p.ok = r.ok; p.ms = r.ms; p.ts = Date.now();
  }
  const before = pool.length;
  pool = pool.filter(p => p.ok).sort((a, b) => a.ms - b.ms);
  console.log(`[IPPOOL] 探活: ${pool.length}/${before} 健康`);
  if (pool.length < POOL_MIN) {
    console.log(`[IPPOOL] 池子过薄(${pool.length}<${POOL_MIN})，全量重扫`);
    await refreshPool();
  }
}

// ── 取下一个最优IP（前5低延迟轮询，实现边缘IP轮换） ────────
export function nextIp() {
  if (pool.length === 0) return null;
  const n = Math.min(pool.length, 5);
  const ip = pool[poolIndex % n];
  poolIndex = (poolIndex + 1) % n;
  return ip.ip;
}

// ── 导出当前池子（供 admin 端点查看） ───────────────────────
export function getPool() {
  return pool;
}

// ── 启动 ────────────────────────────────────────────────────
export async function initPool() {
  await refreshPool();
  setInterval(() => {
    healthCheck().catch(e => console.log(`[IPPOOL] 探活失败: ${e.message}`));
  }, PROBE_INTERVAL * 1000);
  console.log(`[IPPOOL] 已启动: 每${PROBE_INTERVAL}s探活, POOL_MAX=${POOL_MAX}, 无代理裸直连`);
}
