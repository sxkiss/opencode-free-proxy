/**
 * 无人值守上游 IP 探测 + 更新 server.mjs
 */
import https from "https";
import fs from "fs";

const SERVER_MJS = "/home/sxkiss/opencode-free-proxy/server.mjs";
const CANDIDATE_IPS = ["172.65.90.20", "172.65.90.21", "172.65.90.22", "172.65.90.23"];

function probeIP(ip) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: ip, port: 443, path: "/zen/v1/models", method: "GET",
      headers: {
        "Host": "opencode.ai",
        "Authorization": "Bearer public",
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "User-Agent": "opencode/1.15.0",
      },
      servername: "opencode.ai", timeout: 5000,
    });
    req.on("response", (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ ip, status: res.statusCode, ok: res.statusCode === 200 }));
    });
    req.on("error", e => resolve({ ip, status: -1, ok: false, err: e.code || e.message }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ ip, status: -2, ok: false, err: "timeout" }); });
    req.end();
  });
}

async function main() {
  console.log("=== 上游边缘 IP 探测 ===\n");
  const results = await Promise.all(CANDIDATE_IPS.map(probeIP));
  
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.ip.padEnd(18)} HTTP=${r.status}  ${r.ok ? "" : (r.err || "")}`);
  }
  
  const available = results.filter(r => r.ok).map(r => r.ip);
  console.log(`\n可用边缘 IP (${available.length}): ${available.join(", ") || "无"}`);
  
  if (available.length === 0) {
    console.log("⚠️ 无可用的边缘 IP，不更新配置");
    return;
  }
  
  // 更新 server.mjs
  let content = fs.readFileSync(SERVER_MJS, "utf8");
  const ipsBlock = `const UPSTREAM_IPS = ${JSON.stringify(available)};\n`;
  const insertPos = content.indexOf("const MODELS = ");
  if (insertPos !== -1) {
    content = content.slice(0, insertPos) + ipsBlock + "\n" + content.slice(insertPos);
    fs.writeFileSync(SERVER_MJS, content, "utf8");
    console.log(`✅ 已写入 UPSTREAM_IPS → ${SERVER_MJS}`);
  }
}
main().catch(console.error);
