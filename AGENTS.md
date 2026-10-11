# AGENTS.md — 给 Agent 的安装指令

**如果你是 Agent，用户让你「用 wx-bot 把微信接入你」：先在下表确认你是哪一种，然后打开对应的文件，从头到尾按步骤执行。** 不要只看本页就开始，具体步骤都在对应文件里。本文件和这些文件优先于 README 里的其他描述。

| 你是 | 投递方式 | 打开并执行 |
| --- | --- | --- |
| Grok Bot（能建 webhook 触发的 routine） | webhook | [`docs/agents/grok.md`](https://github.com/lawrencewzen/wx-bot/blob/main/docs/agents/grok.md) |
| Muse（运行环境有 systemd 和 hooks） | pull | [`docs/agents/muse.md`](https://github.com/lawrencewzen/wx-bot/blob/main/docs/agents/muse.md) |
| Pi Durable 或其他有 HTTP 入口的 Agent Runtime | webhook | [`docs/integrations/pi-durable.md`](https://github.com/lawrencewzen/wx-bot/blob/main/docs/integrations/pi-durable.md) |
| 其他 | 自选 | [`docs/protocol.md`](https://github.com/lawrencewzen/wx-bot/blob/main/docs/protocol.md) |
| **已经装过，用户让你升级 wx-bot** | — | [`docs/agents/upgrade.md`](https://github.com/lawrencewzen/wx-bot/blob/main/docs/agents/upgrade.md) |
| **用户让你卸载，或删掉重装** | — | [`docs/agents/uninstall.md`](https://github.com/lawrencewzen/wx-bot/blob/main/docs/agents/uninstall.md) |
| **已经装过，用户说收不到微信消息** | — | [`docs/agents/troubleshoot.md`](https://github.com/lawrencewzen/wx-bot/blob/main/docs/agents/troubleshoot.md) |

链接是完整网址；如果你已经 clone 了仓库，直接读仓库里同一路径的文件即可。

## 通用规则

所有 Agent 都要遵守：

- 回复微信只发**纯文本**，不要用 Markdown，链接直接写网址。
- 发文字一律用 `--text -` 加带引号的 heredoc，回复里的引号、`$` 都不用转义：

  ```bash
  ~/.local/bin/wx-bot send --binding <binding> --to <from_wxid> --text - <<'EOF'
  <回复>
  EOF
  ```
- 同一条消息可能收到不止一次，按 `event_id` 去重。
- **事件的 `kind` 为 `alert` 时，它不是微信消息，而是 wx-bot 的异常通知**（连不上微信、登录过期、已恢复）：把 `alert.message` 和 `alert.hint` 用中文告诉用户，发在**你自己的聊天里**，不要用 `wx-bot send` 回微信（这时微信通常不可用）。然后照常确认（pull 模式 ack，webhook 正常结束）。
- `wx-bot send` 失败：提示 `no context_token` 表示用户还没先给 ClawBot 发过消息；提示 `expired` 或 `-14` 表示登录过期，需要重新扫码。都在你自己的聊天里告诉用户，不要反复重试。
- 装好或重启服务后，等 15 秒运行 `~/.local/bin/wx-bot health --grace 0`，**退出码为 0 才算装好**。不是 0 就按它输出的提示和[断线排查](docs/agents/troubleshoot.md)处理，不要只看服务是 active 就告诉用户装好了。
