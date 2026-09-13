/**
 * ip_pool.js — 上游边缘IP池自动管理
 *
 * 工作流程（符合"扫CF边缘 + 域名验证 + 延迟优选"）：
 *  1. 收集候选：解析 opencode.ai 拿到当前IP → 扫其所在/24 + 相邻N个/24（CF边缘）
 *  2. 域名验证：每个候选IP都带 SNI=opencode.ai + Host=opencode.ai 发请求，返回200才算可用
 *  3. 延迟优选：200的入库，按响应ms升序，保留最低延迟的 POOL_MAX 个
 *  4. 自动更新：定时对池中IP轻量探活，过薄时触发全量重扫
 */
import https from "https";
import dns from "dns/promises";
import net from "net";

const DOMAIN = process.env.UPSTREAM_DOMAIN || "opencode.ai";
const POOL_MAX = parseInt(process.env.IP_POOL_MAX || "30", 10);          // 池子保留的最优IP数
const POOL_MIN = parseInt(process.env.IP_POOL_MIN || "10", 10);          // 低于此值触发全量重扫
const PROBE_INTERVAL = parseInt(process.env.IP_PROBE_INTERVAL || "600", 10); // 探活间隔秒(默认10分钟)
const SCAN_NEIGHBORS = parseInt(process.env.IP_SCAN_NEIGHBORS || "4", 10);   // 相邻/24数
const PROBE_TIMEOUT = parseInt(process.env.IP_PROBE_TIMEOUT || "3000", 10);   // 单IP探测超时ms
const INCLUDE_IPV6 = process.env.IP_INCLUDE_IPV6 !== "false";

let pool = [];          // [{ip, ms, ok, status, ts}]
let poolIndex = 0;
let scanning = false;

// ── 单IP探测：SNI+Host 都用上游域名，200即可用 ────────────────
function probeIP(ip) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request({
      hostname: ip, port: 443, path: "/zen/v1/models", method: "GET",
      headers: {
        "Host": DOMAIN,
        "Authorization": "Bearer public",
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "User-Agent": "opencode/1.15.0",
      },
      servername: DOMAIN,
      timeout: PROBE_TIMEOUT,
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ ip, ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - t0, size: d.length }));
    });
    req.on("error", () => resolve({ ip, ok: false, status: -1, ms: Date.now() - t0 }));
    req.setTimeout(PROBE_TIMEOUT + 500, () => { req.destroy(); resolve({ ip, ok: false, status: -2, ms: Date.now() - t0 }); });
    req.end();
  });
}

// ── 收集候选：解析域名 + 扫其所在/24及相邻/24（CF边缘） ───────
async function collectCandidates() {
  const set = new Set();

  // 1. 域名解析（动态，可能漂移）
  try {
    const res = await dns.lookup(DOMAIN, { all: true, verbatim: true });
    res.forEach(r => { if (net.isIP(r.address)) set.add(r.address); });
  } catch (e) { console.log(`[IPPOOL] DNS解析失败: ${e.message}`); }

  // 2. 扫解析IP所在/24 + 相邻 SCAN_NEIGHBORS 个/24 → 这是CF承载 opencode.ai 的边缘
  for (const ip of [...set]) {
    const p = ip.split(".");
    if (p.length !== 4) continue;
    const a = p[0], b = p[1], c = parseInt(p[2], 10);
    for (let d = -SCAN_NEIGHBORS; d <= SCAN_NEIGHBORS; d++) {
      const third = c + d;              // 第三段偏移 → 相邻/24
      if (third < 0 || third > 255) continue;
      for (let i = 0; i < 256; i++) {   // 第四段 0-255 全扫
        set.add(`${a}.${b}.${third}.${i}`);
      }
    }
  }

  // 3. 保留池中已有健康IP（避免每次全丢）
  pool.forEach(p => { if (p.ok) set.add(p.ip); });

  // 4. IPv6（解析到的）
  if (INCLUDE_IPV6) {
    try {
      const res6 = await dns.lookup(DOMAIN, { all: true, verbatim: true });
      res6.forEach(r => { if (net.isIP(r.address) === 6) set.add(r.address); });
    } catch (e) {}
  }

  return [...set];
}

// ── 全量扫描重建池子 ─────────────────────────────────────────
export async function refreshPool() {
  if (scanning) return pool;
  scanning = true;
  const t0 = Date.now();
  try {
    const candidates = await collectCandidates();
    console.log(`[IPPOOL] 候选 ${candidates.length} 个，开始探测(${DOMAIN})...`);
    const results = [];
    const BATCH = 100;
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

// ── 取下一个最优IP（前5低延迟轮询） ─────────────────────────
export function nextIp() {
  if (pool.length === 0) return null;
  const n = Math.min(pool.length, 5);
  const ip = pool[poolIndex % n];
  poolIndex = (poolIndex + 1) % n;
  return ip.ip;
}

// ── 启动 ────────────────────────────────────────────────────
export async function initPool() {
  await refreshPool();
  setInterval(() => {
    healthCheck().catch(e => console.log(`[IPPOOL] 探活失败: ${e.message}`));
  }, PROBE_INTERVAL * 1000);
  console.log(`[IPPOOL] 已启动: 每${PROBE_INTERVAL}s探活, POOL_MAX=${POOL_MAX}, 相邻/24=${SCAN_NEIGHBORS}`);
}
