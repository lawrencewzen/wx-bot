# wx-bot 对接协议 v1

本文是 wx-bot 与 Agent 之间的标准接口。任何 Agent 或 Agent Runtime 按本文对接，都不需要改 wx-bot 代码。

## 1. 总览

```
微信 ─iLink─▶ wx-bot ─▶ 收件箱（SQLite）─① 投递─▶ Agent
                ▲                                  │
                └──────────── ② 回复 ──────────────┘
```

wx-bot 收到微信消息后，先写入本地收件箱，写成功才推进 iLink 游标；再按 binding 的投递方式交给 Agent。Agent 只需要实现两件事：

1. **接收入站事件**：webhook（wx-bot 推送）或 pull（Agent 拉取），二选一。
2. **调用回复接口**：`wx-bot send` 或 `POST /v1/send`。

| 概念 | 说明 |
| --- | --- |
| binding | 一个扫码登录的微信号，配置里的 `bindings[].name`，匹配 `^[a-z0-9_-]{1,32}$` |
| 入站事件 | 一条微信消息对应的 JSON，见第 2 节 |
| 投递方式 | binding 的 `delivery`：`webhook`（默认）或 `pull` |

## 2. 入站事件

```json
{
  "schema": "wxbot.event.v1",
  "event_id": "xiaox:1001",
  "binding": "xiaox",
  "kind": "message",
  "message_id": "1001",
  "from_wxid": "wxid_xxx",
  "to_bot_id": "bot_xxx",
  "create_time": 1760000000,
  "text": "文本",
  "voice_text": "语音转写",
  "media": [
    { "type": "image", "path": "/abs/path/image.jpg", "file_name": "image.jpg", "size": 123 }
  ],
  "media_errors": ["video: download failed"],
  "has_context_token": true,
  "reply_hint": "wx-bot send --binding xiaox --to wxid_xxx --text - <<'EOF'\n<reply>\nEOF"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schema` | string | 固定为 `wxbot.event.v1` |
| `event_id` | string | `<binding>:<message_id>`，全局唯一；去重和 ack 都用它 |
| `binding` | string | 收到消息的绑定名，回复时原样传回 |
| `kind` | string | `message`（微信消息）或 `alert`（wx-bot 异常通知，见 2.1）。旧版事件没有此字段，按 `message` 处理 |
| `message_id` | string | 微信消息 ID，十进制数字字符串 |
| `from_wxid` | string | 发送者，回复时作为 `to` |
| `to_bot_id` | string | 机器人账号 ID |
| `create_time` | number | 消息时间，Unix 秒 |
| `text` | string | 文字内容，多段用 `\n` 连接；可能为空 |
| `voice_text` | string | 语音的微信转写，可选 |
| `media` | array | 已下载到本机的媒体，始终是数组（可能为空） |
| `media[].type` | string | `image` / `voice` / `file` / `video` |
| `media[].path` | string | 本机绝对路径（见第 6 节） |
| `media_errors` | array | 下载失败的媒体说明，可选；含尝试次数，如 `image: The operation timed out. (3 attempts)` |
| `has_context_token` | bool | 当前能否回复该用户 |
| `reply_hint` | string | 回复命令示例，方便 LLM 直接参考 |

`text`、`voice_text`、`media` 可能同时为空（微信的空事件），Agent 应直接忽略并视为处理成功。

### 2.1 异常通知（`kind: "alert"`）

wx-bot 自身出问题时，会往同一条投递通道（webhook 或 pull）放一条 alert 事件，让 Agent 告诉用户：

```json
{
  "schema": "wxbot.event.v1",
  "event_id": "xiaox:alert:ilink_unreachable:1760000000",
  "binding": "xiaox",
  "kind": "alert",
  "message_id": "", "from_wxid": "", "to_bot_id": "bot_xxx", "create_time": 1760000130,
  "text": "", "media": [], "has_context_token": false, "reply_hint": "",
  "alert": {
    "code": "ilink_unreachable",
    "message": "wx-bot 连不上微信已超过 2 分钟，暂时收不到微信消息：Unable to connect",
    "hint": "如果这台机器要通过代理上网，把 https_proxy 等代理变量写进 ~/.config/wx-bot/env 后重启 wx-bot 服务；否则检查网络。",
    "since": 1760000000
  }
}
```

| `alert.code` | 何时发出 |
| --- | --- |
| `ilink_unreachable` | 连续连不上微信超过 2 分钟（每次断线只发一条） |
| `recovered` | 发过 `ilink_unreachable` 之后恢复连接 |
| `session_expired` | 微信登录过期，需要重新扫码 |

- Agent 收到后：把 `alert.message` 和 `alert.hint` 用自己的话告诉用户（在 Agent 自己的聊天里，**不要**用 `wx-bot send` 发微信：此时微信通常不可用），然后照常 ack / 返回 2xx。
- alert 的 `text`、`media` 为空，只认识消息的旧版 Agent 会把它当空事件忽略，不会出错。
- 局限：webhook 和微信走同一个网络出口时（例如代理失效），alert 可能要等网络恢复才送达。

反方向：如果 Agent 那边**超过 10 分钟没处理**排队的消息（webhook 一直失败、pull 没人来取），wx-bot 会直接用微信给登录账号的主人发一条提醒，恢复后再发一条「已恢复」。

## 3. 投递方式

### 3.1 webhook（推送）

适合有 HTTP 入口的 Agent，例如 Grok Bot routine、Pi Durable。

```json
{ "name": "xiaox", "delivery": "webhook", "webhook": { "url": "https://...", "key": "env:WXBOT_WEBHOOK_KEY" } }
```

```
POST <webhook.url>
Content-Type: application/json
Authorization: Bearer <webhook.key>          # 可用 key_header / key_prefix 调整
X-WxBot-Signature: sha256=<hex>              # 配置了 secret 时
X-WxBot-Timestamp: <unix 秒>                 # 配置了 secret 时
```

- 请求体就是第 2 节的事件，末尾有一个换行符。
- 签名是 `HMAC-SHA256(secret, 请求体原始字节)`。时间戳不参与签名，只作参考。
- Agent 返回 **2xx** 即视为送达。单次请求超时 15 秒。
- **先确认、再处理**：收到后尽快落库或入队并返回 2xx，不要等模型跑完再响应。
- 失败处理：

  | Agent 响应 | wx-bot 的处理 |
  | --- | --- |
  | 2xx | 送达 |
  | 400 且响应体含 rate limit | 按 1/2/5/10 分钟重投 |
  | 400、413、422 | 认为事件本身不可接受，放弃该事件（`status` 中计为 dead） |
  | 其他 4xx、5xx、超时、网络错误 | 退避重投：2s、4s、8s……最长 5 分钟一次，直到成功 |

- 一条事件失败不阻塞后面的事件；`wx-bot run` 重启后继续投递未送达的事件。已放弃（dead）的事件可用 `wx-bot inbox requeue [--binding B] [event_id...]` 重新放回待投递。

### 3.2 pull（拉取）

适合无法被推送、只能自己来取的 Agent，例如 Muse（用 hook 轮询唤醒）。

```json
{ "name": "muse", "delivery": "pull" }
```

只有 `delivery: pull` 的 binding 能被拉取和 ack。

**命令行**（直接读写收件箱，`wx-bot run` 不在运行时也能用）：

```bash
wx-bot inbox count [--binding B]                        # 可领取的事件数，不领取，适合 hook 检测
wx-bot inbox pull  [--binding B] [--limit 20] [--lease 5m] [--wait 0s]
wx-bot inbox ack   <event_id>...
```

**本地 HTTP**（`wx-bot run` 期间，鉴权同第 5 节）：

```
GET  /v1/events?binding=&limit=20&lease=5m&wait=0s
POST /v1/events/ack     {"event_ids": ["muse:1001"]}
```

| 返回 | 内容 |
| --- | --- |
| pull | `{"events": [<事件>, ...]}`，按到达顺序；没有事件时为 `[]` |
| ack | `{"acked": N}`，N 为实际确认的条数；重复 ack 或未知 ID 计 0 |

| 参数 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `binding` | 全部 pull binding | — | 只拉某一个 binding |
| `limit` | 20 | 1–100 | 单次最多领取条数 |
| `lease` | 5m | 1s–1h | 租约：领取后这段时间内不会再被领取 |
| `wait` | 0s | 0–60s | 长轮询：没有事件时最多等待这么久 |

**租约语义**：领取的事件在租约期内对其他领取者不可见；处理完（包括决定不回复）后 ack。租约到期仍未 ack 的事件会重新可领取，所以 Agent 中途失败不会丢消息。处理时间可能超过默认 5 分钟时，请加大 `lease`。

### 3.3 exec（暂未实现）

保留给「有命令行唤醒入口、没有 HTTP 入口」的 Agent：wx-bot 执行本地命令，事件从 stdin 传入。有实际接入方时再实现。

## 4. 送达语义

- **至少一次**：同一事件可能送达多次（重投、租约过期、进程重启）。
- **Agent 必须去重**：用 `event_id`（等价于 `binding + message_id`）作为幂等键。wx-bot 自身也会按 `event_id` 去重，但不能保证 Agent 只收到一次。
- **顺序**：同一 binding 按到达顺序投递，但失败重投的事件可能晚于后来的事件。需要严格顺序时按 `create_time`、`message_id` 排序。
- **保留期**：已送达和已放弃的事件保留 7 天后清除；7 天内一直未送达的事件被放弃。清除前可用 `wx-bot inbox requeue` 把 dead 事件重新放回队列。

## 5. 回复接口

### 命令行

```bash
wx-bot send --binding <binding> --to <from_wxid> --text '你好'
wx-bot send --binding <binding> --to <from_wxid> --text - <<'EOF'
从 stdin 读取，内容里的引号和 $ 不用转义（推荐 Agent 使用）
EOF
wx-bot send --binding <binding> --to <from_wxid> --image ./a.jpg --caption '见图'
wx-bot send --binding <binding> --to <from_wxid> --file ./a.pdf
wx-bot send --binding <binding> --to <from_wxid> --video ./a.mp4
```

### 本地 HTTP（`wx-bot run` 期间）

只监听 loopback，默认 `127.0.0.1:18790`。`local_api.token` 非空时，所有 `/v1/*` 需带 `Authorization: Bearer <token>`。

```
POST /v1/send
{"binding": "xiaox", "to": "wxid_xxx", "text": "你好"}
```

`text`、`image`、`file`、`video` 四选一；`image`、`file`、`video` 是 wx-bot 所在机器上的路径，可附 `caption`。

Agent 与 wx-bot 不在同一文件系统时，用 multipart 直接上传文件：

```
POST /v1/send
Content-Type: multipart/form-data

binding=xiaox  to=wxid_xxx  caption=见图（可选）  text=…（发文字时）
image=@a.jpg   或 file=@a.pdf   或 video=@a.mp4   （最多一个文件，≤ 100 MB）
```

上传的文件在发送后删除。

| 状态码 | 含义 | Agent 应该 |
| --- | --- | --- |
| 200 | 已发送 | 标记完成 |
| 400 | 请求不合法 | 修正请求，不重试 |
| 413 | 文件超过 100 MB | 不重试 |
| 401 | token 错误，或该 binding 登录已过期 | 不重试；检查 token 或重新扫码 |
| 403 | 收件人不是扫码登录的微信号 | 不重试 |
| 404 | binding 不存在 | 不重试 |
| 409 | 没有 `context_token`：该用户还没给机器人发过消息 | 不重试，等用户先发消息 |
| 502 | 发往微信失败 | 退避后重试 |

响应体为 `{"ok": true}` 或 `{"error": "<原因>"}`。命令行失败时退出码非 0，原因写在 stderr。

其他接口：`GET /v1/status`（各 binding 的登录、轮询状态 `poll`、投递方式、收件箱计数）、`GET /healthz`。`poll.state` 为 `ok`、`starting`、`failing`（附 `error`）、`stalled` 或 `not_running`。

**限制**：微信只显示纯文本，Markdown 请在 Agent 侧去掉；单文件上限 100 MB；回复依赖用户最近发来消息时的上下文，长时间未互动可能无法主动推送。

## 6. 媒体文件

`media[].path` 是 wx-bot 所在机器上的绝对路径。Agent 与 wx-bot 不在同一文件系统时（例如两个容器），需要把 `media_dir` 挂载为共享卷，并保证两边路径一致；否则 Agent 读不到附件。

## 7. 只能本人使用

wx-bot 只处理**扫码登录的那个微信号**发给 ClawBot 的消息，回复也只能发给它。好友给该微信号发的普通私聊不会转发到 Agent。

旧配置里的 `allow_wxids` / `forward_unallowed` 会被忽略（`wx-bot run` 启动时打一条警告）。

## 8. 部署约束

- wx-bot 只出站，不对外开端口；本地 API 只监听 loopback。
- 容器部署时，Agent 与 wx-bot 共享网络命名空间（如 compose 的 `network_mode: service:<agent>`），通过 `127.0.0.1` 互访。
- `webhook.key` 与 `local_api.token` 使用不同的随机值。
- `state_dir` 必须持久化：其中有登录会话、游标和收件箱（`inbox.db`）。

## 9. 聊天记录（可选）

默认不记录。根配置 `chatlog_days` 为正整数时，wx-bot 把收发原文按天追加到本机 JSONL，供 Agent 事后查询（用户在 Agent 自己的聊天里问「微信里聊了啥」）。

| 项 | 说明 |
| --- | --- |
| 配置 | `chatlog_days`：保留天数；缺省或 `0` 关闭写入 |
| 路径 | `<state_dir>/chatlog/<binding>/<YYYY-MM-DD>.jsonl`（本机时区，按记录时间取日期） |
| 权限 | 目录 `0700`，文件 `0600` |
| 清理 | 保留最近 N 天的日期文件；改回 `0` 只停止写入，不删已有文件 |

每行一条 JSON，字段与写入时一致：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ts` | number | Unix 毫秒 |
| `dir` | string | `in`（收到）或 `out`（发出） |
| `binding` | string | 绑定名 |
| `wxid` | string | 对端微信号 |
| `event_id` | string | 入站事件 id，可选 |
| `by` | string | 出站来源：`agent` 或 `wx-bot`（stall 通知等），可选 |
| `text` | string | 文本，可选 |
| `voice_text` | string | 语音转写，可选 |
| `media` | array | `{type, path?, file_name}`，`type` 为 `image` / `voice` / `file` / `video` |
| `caption` | string | 媒体说明，可选 |

```bash
wx-bot chatlog [--binding B] [--since 24h] [--with <wxid>] [--limit 200] [--json]
```

`--since` 为 Go 风格时长（`30m`、`24h`），另支持 `3d` 这种整天数（N×24h）。不给 `--binding` 时读所有 binding 目录；`--with` 只看与该 wxid 的收发。默认打印文本（给 Agent 看）；`--json` 打印 `{"records":[...]}`，元素是文件里的原始记录。未开启且没有任何历史文件时退出码 1，并提示在 `config.json` 根级设置 `"chatlog_days": 30` 后重启 `wx-bot run`。

## 10. 版本规则

- v1 内只**新增**字段，不删除、不改变已有字段含义；Agent 应忽略不认识的字段。
- 不兼容的变更发布为 v2，通过 `schema` 字段区分。

## 11. 对接清单

- [ ] 选定投递方式（webhook / pull），能收到入站事件
- [ ] webhook：校验 `Authorization`（及可选签名），15 秒内返回 2xx
- [ ] pull：处理完每个事件后 ack；处理可能很慢时加大 `lease`
- [ ] 按 `event_id` 去重
- [ ] 忽略空事件
- [ ] `kind` 为 `alert` 时把 `alert.message` / `alert.hint` 告诉用户（不要回微信）
- [ ] 回复时 `binding` 原样传回，`to` 使用 `from_wxid`
- [ ] 按第 5 节状态码处理失败，401 / 409 不盲目重试
- [ ] 回复去掉 Markdown
- [ ] 需要附件时确认能读到 `media[].path`
