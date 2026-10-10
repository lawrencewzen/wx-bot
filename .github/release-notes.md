## 如何升级

配置、登录状态、收件箱都兼容，**不需要重新扫码**；正在运行的 wx-bot 服务会自动重启。

| 你现在的版本 | 升级命令 |
| --- | --- |
| v0.4.0 及以后 | `wx-bot update` |
| 任何版本（包括 Go 版 v0.3.x） | `curl -fsSL https://raw.githubusercontent.com/lawrencewzen/wx-bot/main/install.sh \| bash` |
| Docker（如 Pi Durable） | 镜像改为 `ghcr.io/lawrencewzen/wx-bot:__VERSION_NUM__`，然后 `docker compose up -d` |

让 Agent 升级：对 Grok Bot / Muse 说「帮我把 wx-bot 升级到最新版」，它会按 [AGENTS.md](https://github.com/lawrencewzen/wx-bot/blob/main/AGENTS.md#升级) 执行。

升级后用 `wx-bot version` 确认版本为 `__VERSION__`。需要回滚：`wx-bot update --version <旧版本>`。

---

