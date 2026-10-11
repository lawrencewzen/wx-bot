# 接入 Pi Durable

Pi Durable 通过 **webhook** 接收微信消息，通过本地 `POST /v1/send` 回复。wx-bot 与 Pi Durable 各跑一个容器，共享网络命名空间，只经 `127.0.0.1` 互访，不对外开端口。协议细节见 [`docs/protocol.md`](../protocol.md)。

## 1. 镜像

使用官方镜像，不需要自己克隆源码或打补丁：

```
ghcr.io/lawrencewzen/wx-bot:<版本>      # 例如 0.4.4；也有 0.4 和 latest
```

镜像支持 `linux/amd64`、`linux/arm64`，以非 root 用户 `bot` 运行，`/state` 和 `/media` 为数据卷。配置文件挂载到 `/etc/wx-bot/config.json`。

## 2. 配置

`deploy/wechat/config.json`：

```json
{
  "state_dir": "/state",
  "media_dir": "/media",
  "local_api": {
    "listen": "127.0.0.1:18790",
    "token": "env:WECHAT_SEND_TOKEN"
  },
  "bindings": [
    {
      "name": "primary",
      "webhook": {
        "url": "http://127.0.0.1:3000/channels/wechat/incoming",
        "key": "env:WECHAT_WEBHOOK_KEY"
      },
      "allow_wxids": []
    }
  ]
}
```

`WECHAT_WEBHOOK_KEY` 与 `WECHAT_SEND_TOKEN` 用两个不同的随机值（`openssl rand -hex 32`），写在 `.env` 里。

## 3. compose

```yaml
services:
  pi-durable-assistant:
    # ……原有配置……
    volumes:
      - pi-durable-assistant-data:/data
      - wx-bot-media:/media:ro          # 可选：让 Pi 读到微信附件，路径与 wx-bot 一致

  wx-bot:
    profiles: ["wechat"]
    image: ghcr.io/lawrencewzen/wx-bot:0.4.4
    restart: unless-stopped
    env_file: .env
    depends_on:
      - pi-durable-assistant
    network_mode: "service:pi-durable-assistant"
    volumes:
      - ./deploy/wechat/config.json:/etc/wx-bot/config.json:ro
      - wx-bot-state:/state
      - wx-bot-media:/media
    read_only: true
    tmpfs:
      - /tmp
    mem_limit: 256m
    cpus: 0.5
    security_opt:
      - no-new-privileges:true

volumes:
  wx-bot-state:
  wx-bot-media:
  pi-durable-assistant-data:
```

扫码与启动：

```bash
docker compose up -d pi-durable-assistant
docker compose --profile wechat run --rm wx-bot --config /etc/wx-bot/config.json login primary
docker compose --profile wechat up -d
docker compose --profile wechat exec wx-bot wx-bot --config /etc/wx-bot/config.json status
```

`status` 里的 `inbox: N pending, M dead` 显示待投递和已放弃的消息数。

## 4. 送达行为

- 每条微信消息先写入 `/state/inbox.db`，写成功才推进 iLink 游标。
- webhook 返回 2xx 即送达。5xx、超时、网络错误按 2s、4s……最长 5 分钟退避重投，直到成功；返回 400、413、422 时放弃该条。一条失败不阻塞后续消息，容器重启后继续投递。
- 送达语义是**至少一次**。Pi Durable 现有的 `binding + from_wxid + message_id` 幂等键可以继续用，也可以改用事件里新增的 `event_id`。
- 入站事件新增 `schema`、`event_id`、`kind` 字段，原有字段不变。
- 从 0.4.4 起，wx-bot 连不上微信（超过 2 分钟）、登录过期、恢复时，会推一条 `kind: "alert"` 事件（`text`、`media` 为空，详情在 `alert.message` / `alert.hint`，见 [协议 2.1](../protocol.md#21-异常通知kind-alert)）。建议 Pi 把它作为系统通知告诉用户，不要回微信。只认识消息的旧逻辑会把它当空事件，**但 alert 的 `from_wxid`、`message_id` 为空，若仍用 `binding + from_wxid + message_id` 做幂等键，多条 alert 会被误判为重复——请改用 `event_id`。**
- Pi 超过 10 分钟没接收排队的消息时（webhook 一直失败），wx-bot 会用微信直接提醒登录账号的主人。

## 5. 从「固定提交 + 补丁」迁移

v0.3.0 起，`deploy/wechat/patch_upstream.py` 里的修改都已在上游：

| 原补丁 | 上游对应 |
| --- | --- |
| 获取二维码改为 POST，加 `AuthorizationType` / `Content-Type` | v0.2.0 |
| getUpdates 业务错误不推进游标 | v0.2.0 |
| webhook 成功后才推进游标 | v0.3.0 收件箱：先落盘再推进游标，失败由后台重投（不会因某条消息一直失败而卡住整个绑定） |
| poller 测试等待协程退出 | v0.2.0 |

迁移步骤：

1. compose 里 `wx-bot` 服务改用 `image: ghcr.io/lawrencewzen/wx-bot:0.4.4`，删除 `build`。
2. 配置文件改为挂载（见第 3 节）。
3. 删除 `deploy/wechat/Dockerfile` 和 `deploy/wechat/patch_upstream.py`。
4. 现有 `wx-bot-state` 卷可直接沿用，登录状态和游标不丢；`inbox.db` 首次启动时自动创建。若容器内无法写入 `/state`，检查卷内文件属主是否与镜像中的 `bot` 用户一致。
