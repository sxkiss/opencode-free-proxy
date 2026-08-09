import { fork } from "child_process";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKERS = parseInt(process.env.WORKERS || "5", 10);
const BASE_PORT = parseInt(process.env.PROXY_PORT || "6446", 10);
const WORKER_PORT_START = BASE_PORT + 100;

const workers = [];
let nextWorker = 0;
const skipUntil = {}; // workerId -> timestamp until which to skip

function startWorker(id) {
  const workerPort = WORKER_PORT_START + id;
  const worker = fork(path.join(__dirname, "server.mjs"), [], {
    env: { ...process.env, PROXY_PORT: workerPort, WORKER_ID: id },
    stdio: "inherit",
  });

  workers[id] = { id, process: worker, port: workerPort, healthy: false };

  worker.on("message", (msg) => {
    if (msg.type === "ready") {
      console.log(`[BALANCER] Worker ${id} ready on port ${workerPort}`);
      workers[id].healthy = true;
    } else if (msg.type === "rate_limited") {
      console.log(`[BALANCER] Worker ${id} rate limited, skipping for 5s`);
      skipUntil[id] = Date.now() + 5000;
    }
  });

  worker.on("exit", (code) => {
    console.log(`[BALANCER] Worker ${id} exited with code ${code}, restarting...`);
    workers[id].healthy = false;
    setTimeout(() => startWorker(id), 2000);
  });

  return worker;
}

for (let i = 0; i < WORKERS; i++) {
  startWorker(i);
}

const server = http.createServer((req, res) => {
  const now = Date.now();
  const healthyWorkers = workers.filter((w) => w.healthy && (!skipUntil[w.id] || skipUntil[w.id] <= now));
  if (healthyWorkers.length === 0) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No healthy workers", type: "service_unavailable" } }));
    return;
  }

  const worker = healthyWorkers[nextWorker % healthyWorkers.length];
  nextWorker = (nextWorker + 1) % healthyWorkers.length;

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: worker.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${worker.port}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (e) => {
    console.log(`[BALANCER] Proxy error to worker ${worker.port}:`, e.message);
    worker.healthy = false;
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Worker unavailable", type: "upstream_error" } }));
    }
  });

  req.pipe(proxyReq);
});

server.listen(BASE_PORT, "0.0.0.0", () => {
  console.log(`[BALANCER] Load balancer on http://0.0.0.0:${BASE_PORT}`);
  console.log(`[BALANCER] ${WORKERS} workers, round-robin`);
});