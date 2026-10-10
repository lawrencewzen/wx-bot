# 部署到 Cloudflare Workers

`packages/cloudflare` 把 wx-bot 跑在 Cloudflare Workers 上：**每个微信号（binding）一个 Durable Object**，用 Alarm 长轮询微信，不需要自己的机器常开。收件箱、登录状态存在 Durable Object 自带的 SQLite 里，媒体文件存在 R2（可选）。对外接口和命令行版一致，见 [`docs/protocol.md`](../protocol.md)。

## 和命令行版的区别

| | 命令行版 | Cloudflare 版 |
| --- | --- | --- |
| 运行方式 | 常驻进程 `wx-bot run` | Durable Object 的 Alarm，每轮约 14 分钟后自动续约 |
| 存储 | `state_dir` 下的文件 + `inbox.db` | Durable Object SQLite |
| 媒体 | `media_dir` 下的本地文件，`media[].path` 是绝对路径 | R2，`media[].path` 是对象 key，用 `GET /b/<binding>/media/<key>` 下载 |
| 接口位置 | 只监听本机 `127.0.0.1` | 公网 HTTPS，**所有接口都要 `Authorization: Bearer <API_TOKEN>`** |
| 回复 | `wx-bot send` 或 `POST /v1/send` | `POST /b/<binding>/v1/send`（JSON 或 multipart 上传文件，不支持本地路径），或 RPC |
| 配置 | `config.json` | `PUT /b/<binding>/config` |

## 部署

```bash
cd packages/cloudflare
bunx wrangler login
bunx wrangler secret put API_TOKEN        # 粘贴一个随机值，例如 openssl rand -hex 32 的输出
bunx wrangler deploy
```

需要接收图片、文件时，先建一个 R2 桶，并在 `wrangler.jsonc` 里取消 `r2_buckets` 那几行的注释：

```bash
bunx wrangler r2 bucket create wx-bot-media
```

免费计划即可：Durable Object 用的是 SQLite 后端（免费计划只能用这种）。一个微信号持续轮询，每天大约消耗 10,800 GB-s 运行时长（按 128 MB 估算），免费额度是 13,000 GB-s，和同一账号下的其他 Durable Object 共用。

## 使用

以下 `$W` 是 Worker 地址，`$T` 是 API_TOKEN，binding 名为 `muse`。

```bash
H="Authorization: Bearer $T"

# 1. 选投递方式（默认 pull）
curl -X PUT -H "$H" $W/b/muse/config -d '{"delivery":"pull"}'
# 或 webhook：
curl -X PUT -H "$H" $W/b/muse/config \
  -d '{"delivery":"webhook","webhook":{"url":"https://agent.example/hook","key":"..."}}'

# 2. 扫码登录：返回 qrcode_url，把它渲染成二维码给用户扫
curl -X POST -H "$H" $W/b/muse/login
curl -H "$H" $W/b/muse/login                  # status: waiting / confirmed / expired

# 3. 收发
curl -H "$H" "$W/b/muse/v1/events?wait=30s"   # pull
curl -H "$H" $W/b/muse/v1/events/ack -d '{"event_ids":["muse:..."]}'
curl -H "$H" $W/b/muse/v1/send -d '{"binding":"muse","to":"<from_wxid>","text":"你好"}'
curl -H "$H" $W/b/muse/v1/send -F binding=muse -F to=<from_wxid> -F image=@a.jpg
curl -H "$H" $W/b/muse/v1/status
```

`config` 里还可以设置 `allow_wxids`（默认只放行扫码的微信号）和 `forward_unallowed`，含义与命令行版相同。

### 从命令行版迁移登录状态

不想重新扫码时，可以把命令行版 `state_dir/<binding>/` 下的会话导入：

```bash
curl -X PUT -H "$H" $W/b/muse/session -d @- <<EOF
{"session": $(cat ~/.local/state/wx-bot/muse/session.json),
 "context_tokens": $(cat ~/.local/state/wx-bot/muse/context_tokens.json),
 "cursor": "$(cat ~/.local/state/wx-bot/muse/cursor)"}
EOF
```

导入后**停掉命令行版的 `wx-bot run`**：同一个微信号同时被两处轮询，消息会被分走。

## 在同一个 Worker 里直接调用（RPC）

Agent 也部署在 Cloudflare 上时（例如 Pi Durable），可以直接引用 `@wx-bot/cloudflare`，跳过 HTTP：

```ts
import { WxBinding } from "@wx-bot/cloudflare";
export { WxBinding }; // 并在 wrangler 配置里声明 WXBOT 绑定和 new_sqlite_classes 迁移

const wx = env.WXBOT.get(env.WXBOT.idFromName("muse"));
const events = await wx.pull({ limit: 20, leaseMs: 5 * 60_000 });
await wx.send({ to: events[0].from_wxid, text: "收到" });
await wx.ack(events.map((e) => e.event_id));
```

`pull` 要求该 binding 的投递方式是 `pull`。

## 注意事项

- 腾讯可能对 Cloudflare 的出口 IP 做限制或风控；上线前用测试微信号验证。
- 一个微信号只能有一处在轮询（命令行版或 Cloudflare 版二选一）。
- Durable Object 被替换或重启时，Alarm 会自动恢复轮询；收件箱和游标都已持久化。
