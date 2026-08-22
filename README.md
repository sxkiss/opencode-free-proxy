# opencode-free-proxy

Free AI models from [OpenCode](https://opencode.ai) exposed as standard OpenAI and Anthropic APIs.

One server — works with any tool that speaks OpenAI or Anthropic format: Cursor, Continue, Cline, Claude Code, aider, opencode CLI, raw `curl`, whatever.

支持单实例和集群模式，集群模式下可配置多个worker进程进行负载均衡。

## 30-second setup

```bash
git clone https://github.com/sxkiss/opencode-free-proxy.git
cd opencode-free-proxy
npm install
node server.mjs
```

Done. Server is at `http://localhost:6446`. API keys are in `api-keys.json` (auto-generated on first run).

## What you get

| Model | What it is | Reliability |
|-------|-----------|-------------|
| `x-preview-f-free` | X Preview F | Solid |
| `big-pickle` | Big Pickle (reasoning) | Solid |
| `mimo-v2.5-free` | MiMo V2.5 | Hit or miss |
| `hy3-free` | Hunyuan 3 | Solid |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra | Solid |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning | Solid |
| `laguna-s-2.1-free` | Laguna S 2.1 | Hit or miss |

All models support streaming, tool calls, and system messages.

## API

### OpenAI format — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "x-preview-f-free",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Anthropic format — `POST /v1/messages`

```bash
curl http://localhost:6446/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "x-preview-f-free",
    "system": "You are helpful.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

### Other endpoints

| Method | Path | What |
|--------|------|------|
| `GET` | `/v1/models` | List models |
| `GET` | `/health` | Health + version |

### Auth

Both `Authorization: Bearer KEY` and `x-api-key: KEY` work on all endpoints.

支持任意格式正确的API Key访问，无需记住真实Key。

## Use with tools

### opencode CLI

Add to `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "free": {
      "name": "free",
      "type": "openai",
      "apiKey": "YOUR_KEY",
      "baseURL": "http://localhost:6446/v1",
      "models": {
        "free/x-preview-f-free": {
          "id": "x-preview-f-free",
          "name": "free/x-preview-f-free",
          "attachment": true,
          "reasoning": true
        }
      }
    }
  }
}
```

### Cursor / Continue / Cline

- Base URL: `http://YOUR_HOST:6446/v1`
- API Key: your key from `api-keys.json`
- Model: `x-preview-f-free`

### Claude Code (Anthropic format)

- Base URL: `http://YOUR_HOST:6446`
- API Key: your key from `api-keys.json`
- Works with `/v1/messages` endpoint

## Deploy on a VPS

```bash
# On your VPS
git clone https://github.com/sxkiss/opencode-free-proxy.git
cd opencode-free-proxy
npm install
node server.mjs          # foreground
# or
nohup node server.mjs > proxy.log 2>&1 &   # background
```

If your VPS doesn't expose port 6446, use an SSH tunnel:

```bash
ssh -L 6446:127.0.0.1:6446 user@your-vps
# Now http://localhost:6446 works locally
```

### systemd service (optional)

```ini
# /etc/systemd/system/opencode-proxy.service
[Unit]
Description=OpenCode Free Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=PROXY_PORT=6446

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opencode-proxy
```

## Docker 部署

### 构建镜像

```bash
git clone https://github.com/sxkiss/opencode-free-proxy.git
cd opencode-free-proxy
docker build -t opencode-free-proxy .
```

### 配置 .env 文件

```bash
# 创建 .env 文件
cat > .env << EOF
CLUSTER_MODE=true
WORKERS=10
SESSION_POOL_SIZE=50
HTTP_PROXY=http://127.0.0.1:7890
PROXY_PORT=6446
EOF
```

### 启动容器（推荐 host 网络模式）

```bash
docker run -d --name opencode-proxy --network host \
  --env-file .env \
  -v $(pwd)/data/api-keys.json:/app/api-keys.json \
  opencode-free-proxy
```

### 任意Key访问

支持使用任意格式正确的API Key访问，无需记住真实Key：

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer any-key-you-want" \
  -H "Content-Type: application/json" \
  -d '{"model": "x-preview-f-free", "messages": [{"role": "user", "content": "Hello"}]}'
```

### 常用命令

```bash
# 查看日志
docker logs -f opencode-proxy

# 停止容器
docker stop opencode-proxy

# 重启容器
docker restart opencode-proxy

# 进入容器
docker exec -it opencode-proxy sh
```

## 集群模式

支持在单个容器内运行多个worker进程，由负载均衡器进行轮询分发。

### 启动集群

```bash
docker run -d --name opencode-proxy --network host \
  --env-file .env \
  -v $(pwd)/data/api-keys.json:/app/api-keys.json \
  opencode-free-proxy
```

### 环境变量（.env 文件）

| Variable | Default | What |
|----------|---------|------|
| `CLUSTER_MODE` | `false` | 启用集群模式 |
| `WORKERS` | `5` | worker进程数量 |
| `SESSION_POOL_SIZE` | `10` | 会话池大小（轮换获取更多额度） |
| `PROXY_PORT` | `6446` | 负载均衡器端口 |
| `KEYS_FILE` | `./api-keys.json` | API密钥文件路径 |
| `HTTP_PROXY` | 无 | HTTP代理地址（用于突破IP限制） |

### 架构说明

```
客户端请求
    │
    ▼
负载均衡器 (端口 6446)
    │
    ├─→ Worker 0 (端口 6546)
    ├─→ Worker 1 (端口 6547)
    ├─→ Worker 2 (端口 6548)
    ├─→ Worker 3 (端口 6549)
    └─→ Worker 4 (端口 6550)
```

- 负载均衡器：接收客户端请求，轮询分发到各个worker
- Worker进程：独立的代理服务器，处理实际请求
- 健康检查：自动检测worker状态，故障时自动重启

### 单实例模式（默认）

```bash
docker run -d --name opencode-proxy -p 6446:6446 \
  -v /path/to/api-keys.json:/app/api-keys.json \
  opencode-free-proxy
```

## How it works

```
Your tool (Cursor, CLI, curl, etc.)
        │
        ▼
  opencode-free-proxy        ← this server, translates formats
        │
        ▼  HTTPS
  opencode.ai/zen/v1/       ← free tier API
```

The proxy adds `x-opencode-*` authentication headers that the Zen API requires. These were discovered by reverse engineering the opencode binary — without them, even `Authorization: Bearer public` gets rejected with `AuthError`.

### Zen API auth headers (for the curious)

```
Authorization: Bearer public
User-Agent: opencode/1.15.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13
x-opencode-client: cli
x-opencode-project: global
x-opencode-request: msg_<unique_id>
x-opencode-session: ses_<unique_id>
```

## License

MIT