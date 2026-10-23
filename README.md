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
> **🤖 如果你是 Agent：先读 [`AGENTS.md`](https://github.com/lawrencewzen/wx-bot/blob/main/AGENTS.md)，找到你对应的文件，按步骤执行。**
> Grok Bot：创建 routine 后，**必须在聊天回复里直接发出「Webhook URL」和「Webhook key」两个字段链接**，用户自己找不到。

## 特点

- **不丢消息**：先落盘到本地 SQLite 收件箱，再确认；投递失败自动重投。
- **只出站**：不对外开端口，本地 API 只监听 loopback。
- **默认白名单**：只理会扫码登录的那个微信号。
- **两种投递**：`webhook` 推给 Agent，`pull` 由 Agent 来取。
- 收发文本、图片、语音（带转写）、文件、视频。支持 Linux / macOS。

```
WeChat ──iLink──▶ wx-bot (inbox) ──webhook / pull──▶ Agent
       ◀─────────────────────────── wx-bot send ────┘
```

## 快速开始

把这句话发给你的 Grok Bot 或 Muse：

```
帮我用 wx-bot 把微信接入你：https://github.com/lawrencewzen/wx-bot
```

它会自己装好，你只需要**用微信扫码**（Grok 还要你点两个链接，把 URL 贴回聊天、把 key 填进加密框）。

> [!NOTE]
> 装好后**先用微信给 ClawBot 发一条消息**，Agent 才能回复你。

其他接法：[Pi Durable（Docker）](docs/integrations/pi-durable.md) · [Cloudflare Workers](docs/integrations/cloudflare.md) · 手动安装 ↓

### 手动安装

```bash
curl -fsSL https://raw.githubusercontent.com/lawrencewzen/wx-bot/main/install.sh | bash
# 源码安装：git clone 后运行 ./install.sh --service（--service 同时装开机自启）
```

编辑 `~/.config/wx-bot/config.json`，参考 [webhook 示例](examples/config.example.json) 或 [pull 示例](examples/config.pull.example.json)；密钥写进 `~/.config/wx-bot/env`，配置里用 `env:VAR` 引用。要放行别的微信号，见[白名单](docs/protocol.md#7-白名单)。

```bash
wx-bot login xiaox          # 微信扫码
wx-bot run                  # 启动
wx-bot health --grace 0     # 退出码 0 才算装好
```

## 对接

**收**：每条消息是一个 JSON 事件，含 `event_id`、`from_wxid`、`text`、`voice_text`、`media[]`（本机文件路径）。**同一事件可能送达多次，按 `event_id` 去重。**

- webhook：POST 到你的地址，返回 2xx 即送达。
- pull：`wx-bot inbox pull --lease 5m` 领取，处理完 `wx-bot inbox ack <event_id>`。

**回**：

```bash
wx-bot send --binding xiaox --to <wxid> --text - <<'EOF'
回复内容（引号、$ 都不用转义）
EOF
wx-bot send --binding xiaox --to <wxid> --image ./a.jpg   # 还有 --file / --video
```

**只发纯文本**，微信不渲染 Markdown。事件格式、签名、本地 HTTP API、`alert` 异常通知等细节见 [`docs/protocol.md`](docs/protocol.md)。

## 运维

| 做什么 | 命令 |
| --- | --- |
| 看状态 | `wx-bot status` |
| 查微信聊天记录 | `wx-bot chatlog [--since 24h] [--with wxid]` |
| 排查收不到消息 | `wx-bot health --grace 0` |
| 重放已放弃（dead）的消息 | `wx-bot inbox requeue [--binding B] [event_id...]` |
| 升级（不用重新扫码） | `wx-bot update` |
| 回滚 | `wx-bot update --version <版本>` |
| 卸载 | `wx-bot uninstall --yes`（加 `--keep-data` 保留登录） |

配置项 `chatlog_days`（整数，默认 `0` 关闭）开启后，收发原文按天追加到 `<state_dir>/chatlog/<binding>/<YYYY-MM-DD>.jsonl`，并保留最近 N 天；改回 `0` 只停止写入，不删已有文件。聊天记录是隐私数据，默认不写。查询用 `wx-bot chatlog --since 24h`（可加 `--with <wxid>`、`--binding`、`--limit`、`--json`）；未开启且没有历史文件时退出码 1，并提示如何打开。

v0.4.0 之前的版本，重跑一遍 `install.sh` 即可升级。也可以直接让 Agent「把 wx-bot 升级到最新版」。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| Agent 收不到消息 | 先跑 `wx-bot health --grace 0`，按提示处理；详见[断线排查](docs/agents/troubleshoot.md) |
| `send` 报 `no context_token` | 对方还没给 ClawBot 发过消息，先发一条 |
| 日志出现 `-14` / `expired` | 登录过期，重新 `wx-bot login <binding>` |
| 只能走代理出网 | 把 `https_proxy` 写进 `~/.config/wx-bot/env`，重启服务 |
| `status` 里有 `dead` 消息 | 被 Agent 拒绝（400/413/422；响应体含 rate limit 的 400 会按 1/2/5/10 分钟重投，不记 dead）或超过 7 天，看日志 |
| 二维码要发给别人扫 | `wx-bot login <binding> --qr-png ./qr.png` |

## 开发

```bash
bun install
bun run typecheck && bun test
cd packages/cli && bun run scripts/cross.ts   # 交叉编译到 dist/
```

`packages/core` 协议与收件箱 · `packages/cli` 命令行 · `packages/cloudflare` Workers 部署

---

本项目调用腾讯官方 [ClawBot / iLink](https://ilinkai.weixin.qq.com) 接口，但与腾讯无关，不是腾讯官方产品。
