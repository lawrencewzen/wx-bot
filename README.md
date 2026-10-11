<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" width="96" height="96" alt="wx-bot">
  </picture>
</p>

<h1 align="center">wx-bot</h1>

<p align="center">
  <strong>把微信接入到 Personal Agent（Grok、Muse 等）。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-Bun-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript + Bun">
  <img src="https://img.shields.io/badge/Linux-supported-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux">
  <img src="https://img.shields.io/badge/macOS-supported-8E8E93?style=flat-square&logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/WeChat-ClawBot%20%2F%20iLink-07C160?style=flat-square&logo=wechat&logoColor=white" alt="WeChat ClawBot / iLink">
  <img src="https://img.shields.io/badge/network-outbound%20only-2EA44F?style=flat-square" alt="outbound only">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  微信消息经腾讯官方 <a href="https://ilinkai.weixin.qq.com">ClawBot / iLink</a> 进入本机 <code>wx-bot</code>，
  落盘后推送给你的 Agent（webhook）或由 Agent 拉取（pull）；Agent 再用 <code>wx-bot send</code> 发回微信。
</p>

---

> [!IMPORTANT]
> **🤖 Agent 请先读 [`AGENTS.md`](https://github.com/lawrencewzen/wx-bot/blob/main/AGENTS.md)，找到你对应的一节（Grok Bot / Muse / Pi Durable），按里面的步骤安装。**
> Grok Bot 最重要的一条：创建 routine 后，**必须在聊天回复里直接发出「Webhook URL」和「Webhook key」两个可点击的字段链接**。用户在侧栏点不开 routine 详情，不要让用户自己去找。

## 功能

- **双向收发**：收文本、图片、语音、文件、视频；回发文本、图片、文件、视频。语音优先附带微信转写文本。
- **不丢消息**：每条消息先写入本地 SQLite 收件箱，再推进 iLink 游标；投递失败自动退避重投，重启后继续。
- **两种投递**：`webhook` 由 wx-bot 推送给 Agent；`pull` 由 Agent 自己来取（适合 Muse 这类只能轮询的 Agent）。
- **只出站**：走 iLink 长轮询，本地 API 只监听 loopback，不对外开端口。
- **默认白名单**：只放行扫码登录的微信号；其他人的消息不转发、不回复。
- **多绑定**：一个微信号对应一个 Agent，会话过期只停该绑定。

平台：Linux / macOS（amd64、arm64），不支持 Windows。通常和 Agent 装在同一台机器上，例如 Grok Bot、Muse 的云电脑。

```
+--------+  iLink getupdates   +-------------------+  webhook (push)     +---------+
|        | ------------------> | wx-bot            | ------------------> |         |
| WeChat |                     |   inbox (SQLite)  | <-- inbox (pull) -- |  Agent  |
|        | <------------------ |                   | <------------------ |         |
+--------+  iLink sendmessage  +-------------------+  wx-bot send / API  +---------+
```

对接标准见 [`docs/protocol.md`](docs/protocol.md)：入站事件格式、两种投递方式、送达语义、回复接口与状态码。

## 快速开始

### 交给 Grok Bot（推荐）

把下面这句话发给你的 Grok Bot：

```
帮我用 wx-bot 把微信接入你：https://github.com/lawrencewzen/wx-bot
```

它会按 [`AGENTS.md`](AGENTS.md) 装好，中间只需要你做三件事：点它发来的 Webhook URL 链接复制贴回聊天、点 Webhook key 链接复制填进加密输入框、用微信扫码。

### 交给 Muse

把同一句话发给 Muse。它会在自己的运行环境里装好 wx-bot（pull 模式），把登录二维码以图片发给你；你扫码后，它用一个每隔几秒检测的 hook 接收微信消息。

### 接入 Pi Durable

用官方 Docker 镜像 `ghcr.io/lawrencewzen/wx-bot`，见 [`docs/integrations/pi-durable.md`](docs/integrations/pi-durable.md)。



### 手动安装

从 [Releases](https://github.com/lawrencewzen/wx-bot/releases) 下载对应平台的单文件可执行程序，或用源码安装（需要 [Bun](https://bun.sh)；没有 Bun 时 `install.sh` 会自动下载发布版）：

```bash
git clone https://github.com/lawrencewzen/wx-bot
cd wx-bot
./install.sh              # 装到 ~/.local/bin；加 --service 同时装 systemd / launchd 自启
```

编辑 `~/.config/wx-bot/config.json`：webhook 模式把 `webhook.url` 改成你的 Agent 地址，密钥写进 `~/.config/wx-bot/env`，配置里用 `env:VAR` 引用；pull 模式见 [`examples/config.pull.example.json`](examples/config.pull.example.json)。

```bash
wx-bot login xiaox        # 终端出二维码，微信扫码
wx-bot run                # 启动
```

然后**先用你的微信给 ClawBot 发一条消息**，之后 Agent 才能回复你。

### 升级

配置、登录状态、收件箱都兼容，不需要重新扫码；正在运行的服务会自动重启。

```bash
wx-bot update                 # v0.4.0 及以后
wx-bot update --check         # 只检查有没有新版本

# 任何版本都适用（包括 Go 版 v0.3.x），也可用于首次安装：
curl -fsSL https://raw.githubusercontent.com/lawrencewzen/wx-bot/main/install.sh | bash
```

让 Agent 升级：对它说「帮我把 wx-bot 升级到最新版」。Docker 部署改镜像标签后 `docker compose up -d`。回滚：`wx-bot update --version <旧版本>`。

### 其他部署方式（可选）

Agent 本身部署在 Cloudflare 上，或者没有可以常驻进程的机器时，可以把 wx-bot 部署到 Cloudflare Workers：每个微信号一个 Durable Object，用 Alarm 拉消息。见 [`docs/integrations/cloudflare.md`](docs/integrations/cloudflare.md)。

## 配置

```json
{
  "local_api": { "listen": "127.0.0.1:18790", "token": "" },
  "bindings": [
    {
      "name": "xiaox",
      "delivery": "webhook",
      "webhook": {
        "url": "https://example.com/webhook/wx-bot",
        "key": "env:WXBOT_WEBHOOK_KEY",
        "secret": "env:WXBOT_WEBHOOK_SECRET"
      },
      "allow_wxids": []
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `local_api.listen` | 本地 API 地址，必须是 loopback。 |
| `local_api.token` | 非空时 `/v1/*` 需 `Authorization: Bearer <token>`。 |
| `delivery` | `webhook`（默认）或 `pull`。pull 模式不需要 `webhook`。 |
| `webhook.key` | 默认以 `Authorization: Bearer <key>` 发送，可用 `key_header` / `key_prefix` 调整。 |
| `webhook.secret` | 非空时附加 `X-WxBot-Signature: sha256=<HMAC>` 与 `X-WxBot-Timestamp`。 |
| `allow_wxids` | 为空时只放行扫码登录的微信号。 |
| `forward_unallowed` | `true` 时非白名单消息也转发，但不回复。 |

完整示例：[`examples/config.example.json`](examples/config.example.json)（webhook）、[`examples/config.pull.example.json`](examples/config.pull.example.json)（pull）。

收件箱在 `state_dir/inbox.db`。已送达的消息保留 7 天；7 天内一直未送达的消息会被放弃。

## 入站事件

```json
{
  "schema": "wxbot.event.v1",
  "event_id": "xiaox:1001",
  "binding": "xiaox",
  "message_id": "1001",
  "from_wxid": "wxid_xxx",
  "create_time": 1760000000,
  "text": "文本",
  "voice_text": "语音转写",
  "media": [{ "type": "image", "path": "/abs/path", "file_name": "image.jpg", "size": 123 }],
  "reply_hint": "wx-bot send --binding xiaox --to wxid_xxx --text - <<'EOF'\n<reply>\nEOF"
}
```

`media.type` 为 `image` / `voice` / `file` / `video`，`path` 是本机绝对路径。同一事件可能送达多次，Agent 按 `event_id` 去重。

**webhook**：POST 到 `webhook.url`，返回 2xx 即送达；超时 15s。5xx、超时、网络错误退避重投（最长 5 分钟一次）；400、413、422 放弃该条。

**pull**：

```bash
wx-bot inbox count                    # 可领取的消息数（不领取）
wx-bot inbox pull --lease 5m          # 领取，输出 {"events": [...]}
wx-bot inbox ack <event_id>...        # 处理完后确认；未确认的在租约到期后可再次领取
```

`wx-bot run` 期间也可用 `GET /v1/events`、`POST /v1/events/ack`，详见 [`docs/protocol.md`](docs/protocol.md)。

## 回微信

```bash
wx-bot send --binding xiaox --to <wxid> --text '你好'
wx-bot send --binding xiaox --to <wxid> --text - <<'EOF'    # 从 stdin 读，内容里的引号和 $ 不用转义
大模型生成的回复原样放这里
EOF
wx-bot send --binding xiaox --to <wxid> --image ./a.jpg --caption '见图'
wx-bot send --binding xiaox --to <wxid> --file ./a.pdf
wx-bot send --binding xiaox --to <wxid> --video ./a.mp4
wx-bot status    # 登录、轮询（poll: ok / failing / not running）、投递、收件箱状态
wx-bot health    # 收不到消息时先跑这个：退出码 0 表示正常，否则输出原因和处理办法
```

或在 `wx-bot run` 期间调用本地 API：

```bash
curl -X POST http://127.0.0.1:18790/v1/send \
  -d '{"binding":"xiaox","to":"wxid_xxx","text":"你好"}'

# 图片、文件、视频也可以直接上传，不要求文件在 wx-bot 所在机器上
curl -X POST http://127.0.0.1:18790/v1/send \
  -F binding=xiaox -F to=wxid_xxx -F caption='见图' -F image=@./a.jpg
```

只发纯文本，Markdown 请在 Agent 侧去掉。单文件上限 100 MB。

## FAQ

**wx-bot 出问题会通知谁？** 连不上微信超过 2 分钟、登录过期、恢复时，wx-bot 往 Agent 投一条 `kind: "alert"` 事件，由 Agent 在它自己的聊天里告诉你；反过来，Agent 超过 10 分钟没处理排队的消息时，wx-bot 直接用微信提醒你。详见 [协议 2.1](docs/protocol.md#21-异常通知kind-alert)。

**微信发了消息，Agent 一直没收到？** 先跑 `wx-bot health --grace 0`，它会说明是服务没在运行、登录过期，还是连不上微信。云电脑只能通过代理出网时，systemd 服务默认不带 shell 里的 `https_proxy` 等变量，要写进 `~/.config/wx-bot/env` 后重启服务（Linux 上 `install.sh` 会自动写入）。

**poller 停了，日志提示 `-14`？** 会话过期，重新 `wx-bot login <binding>`。

**`send` 报 `no context_token`？** 该用户还没给 bot 发过消息，先发一条再回。

**Alpine 上跑不起来？** 发布版依赖 glibc，Alpine 等 musl 系统请用 `wx-bot_linux_<arch>_musl`；`install.sh` 会自动选择。

**二维码过期？** 每张码约 2 分钟有效，过期自动换新码；10 分钟内没扫就退出（`--timeout` 可调），重跑 `login` 即可。用 `--qr-png` 时，登录结束后图片会被删除，避免误发过期的旧图。

**要把二维码发给别人扫？** `wx-bot login <binding> --qr-png ./qr.png` 会同时写出 PNG 图片。

**消息没送到 Agent？** `wx-bot status` 看 `inbox: N pending, M dead`：pending 是还在重投的，dead 是被 Agent 拒绝（400/413/422）或超过 7 天放弃的。日志里有每次失败的原因。

## 开发

TypeScript monorepo（Bun workspaces）：

| 包 | 内容 |
| --- | --- |
| `packages/core` | 微信 iLink 协议、收件箱、webhook 投递、HTTP API；只用 `fetch` / WebCrypto，任何运行时都能用 |
| `packages/cli` | 命令行版（`wx-bot login/run/send/inbox/status`），编译成单文件可执行程序 |
| `packages/cloudflare` | 可选的 Cloudflare Workers 部署（Durable Object + Alarm） |

```bash
bun install
bun run typecheck && bun test
cd packages/cli && bun run scripts/cross.ts      # dist/wx-bot_{linux,darwin}_{amd64,arm64}
```

---

本项目使用腾讯官方 [ClawBot / iLink](https://ilinkai.weixin.qq.com) 接口，与腾讯无关，非腾讯官方产品。
