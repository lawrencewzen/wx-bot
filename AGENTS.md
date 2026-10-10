# AGENTS.md — 给 Agent 的安装指令

**如果你是 Agent，用户让你「用 wx-bot 把微信接入你」，先确认你是哪一种，再只执行对应的一节。** 本文件优先于 README 里的其他描述。

| 你是 | 投递方式 | 执行 |
| --- | --- | --- |
| Grok Bot（能建 webhook 触发的 routine） | webhook | [Grok Bot](#grok-bot) |
| Muse（运行环境有 systemd 和 hooks） | pull | [Muse](#muse) |
| Pi Durable 或其他有 HTTP 入口的 Agent Runtime | webhook | [Pi Durable](#pi-durable) |
| 其他 | 按 [`docs/protocol.md`](docs/protocol.md) 选择 | — |
| **已经装过，用户让你升级 wx-bot** | — | [升级](#升级) |

所有 Agent 都要遵守：

- 回复微信只发**纯文本**，不要用 Markdown，链接直接写网址。
- 发文字一律用 `--text -` 加带引号的 heredoc，回复里的引号、`$` 都不用转义：

  ```bash
  ~/.local/bin/wx-bot send --binding <binding> --to <from_wxid> --text - <<'EOF'
  <回复>
  EOF
  ```
- 同一条消息可能收到不止一次，按 `event_id` 去重。
- `wx-bot send` 失败：提示 `no context_token` 表示用户还没先给 ClawBot 发过消息；提示 `expired` 或 `-14` 表示登录过期，需要重新扫码。都在你自己的聊天里告诉用户，不要反复重试。

---

## Grok Bot

### ⚠️ 必须遵守：把 Webhook 字段链接直接发在聊天里

创建 routine 后，**你的下一条聊天回复里必须包含两个可点击的字段链接：「Webhook URL」和「Webhook key」**，也就是 routine 详情面板里这两个字段的链接。

原因：Grok Bot 应用目前有缺陷，用户在侧栏「例行任务」里点 routine **打不开详情页**，自己找不到 URL 和 key。只有你在聊天里发出的字段链接，用户才点得开。

- ✅ 正确：回复里直接放「⊕ Webhook URL」「⊕ Webhook key」两个链接，并说明各自怎么用。
- ❌ 错误：「去右侧例行任务里点开『微信消息』查看」「在侧栏可以找到 URL 和 key」。
- ❌ 错误：只发一个链接，或只给文字不给链接。

回复示例：

> routine 已建好。请点 ⊕ Webhook URL，复制后贴回这里；再点 ⊕ Webhook key，复制后填进上面的加密输入框（不要贴在聊天里）。

### 安装步骤

1. **安装 wx-bot**

   ```bash
   git clone https://github.com/lawrencewzen/wx-bot
   cd wx-bot
   ./install.sh --service
   ```

2. **创建 routine**：触发方式选 **webhook**，名称如「微信消息」。指令里写明：
   - 收到的 JSON 中 `text` 是文字，`voice_text` 是语音转写，`media[].path` 是本机文件绝对路径，`from_wxid` 是发送者，`binding` 是绑定名。
   - 回复用 `~/.local/bin/wx-bot send --binding <binding> --to <from_wxid> --text - <<'EOF'`，下一行起是回复内容，最后一行 `EOF`；图片、文件、视频用 `--image` / `--file` / `--video`。
   - 微信只显示纯文本，回复里不要用 Markdown。
   - `wx-bot send` 报 `-14` 或 `no context_token` 时，在 Grok Bot 聊天里告诉用户需要重新扫码登录。

3. **发出两个字段链接**：按上面「必须遵守」一节，在聊天回复里发出「Webhook URL」和「Webhook key」链接。

4. **接收 URL 和 key**
   - 用户把 Webhook URL 贴回聊天。
   - 弹出**加密输入框**让用户填 Webhook key，存为环境变量 `WXBOT_WEBHOOK_KEY`。不要让用户把 key 贴进聊天。

5. **写配置**
   - `~/.config/wx-bot/config.json`：`bindings[0].webhook.url` 填用户给的 URL，`key` 保持 `env:WXBOT_WEBHOOK_KEY`。不用签名时**删掉 `secret` 这一行**，否则环境变量未设置会导致启动失败。
   - `~/.config/wx-bot/env`：写入 `WXBOT_WEBHOOK_KEY=<key>`（格式 `KEY=value`，不加 `export`）。

6. **扫码登录**：运行 `wx-bot login <binding>`（`<binding>` 是配置里 `bindings[0].name`，示例配置为 `xiaox`），把二维码展示给用户，让用户用微信扫码。二维码过期会自动刷新最多 3 次。

7. **启动**：按 `install.sh` 输出的命令加载 systemd / launchd 服务；或直接运行 `wx-bot run`。用 `wx-bot status` 确认在运行。

8. **告诉用户**：先用自己的微信给 ClawBot 发一条消息，之后就能对话。

---

## Muse

wx-bot 跑在**你自己的运行环境**里（不是用户的 Mac），作为 systemd 服务常驻；消息进入本地收件箱，由一个 hook 每隔几秒检测，有新消息就唤醒你，你再领取、回复、确认。以下路径里的 `~` 都是你运行环境的 home 目录。

1. **安装**（直接下载发布版，单文件约 90 MB）

   ```bash
   mkdir -p ~/.local/bin
   case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; esac
   LIBC=""; ls /lib/ld-musl-* >/dev/null 2>&1 && LIBC=_musl      # Alpine 等 musl 系统
   ASSET="wx-bot_linux_${ARCH}${LIBC}"
   BASE=https://github.com/lawrencewzen/wx-bot/releases/latest/download
   cd ~/.local/bin
   curl -fLO "$BASE/$ASSET" && curl -fLO "$BASE/checksums.txt"
   sha256sum -c --ignore-missing checksums.txt
   mv "$ASSET" wx-bot && chmod 0755 wx-bot && rm checksums.txt
   ~/.local/bin/wx-bot version
   ```

2. **写配置**：`~/.config/wx-bot/config.json`（目录权限 0700，文件 0600），内容取自 [`examples/config.pull.example.json`](examples/config.pull.example.json)，binding 名为 `muse`，`"delivery": "pull"`。pull 模式不需要 webhook URL 和 key。

3. **扫码登录**：二维码要以**图片**发给用户。

   ```bash
   nohup ~/.local/bin/wx-bot login muse --qr-png ~/wx-bot-qr.png > ~/wx-bot-login.log 2>&1 &
   ```

   - 等 `~/wx-bot-qr.png` 生成后，把这张图片发到聊天里，告诉用户：「用微信扫这个二维码，并在手机上确认登录」。
   - 读 `~/wx-bot-login.log`，出现 `login ok` 即成功。日志出现「二维码已过期」时图片已被覆盖，重新发送新图片。
   - 登录成功后删除 `~/wx-bot-qr.png`。

4. **常驻服务**：取 [`adapters/muse/wx-bot.service`](adapters/muse/wx-bot.service)，把 `__HOME__` 换成 home 的绝对路径、`__USER__` 换成该目录的属主，安装为 `/etc/systemd/system/wx-bot.service`，然后：

   ```bash
   systemctl daemon-reload && systemctl enable --now wx-bot
   systemctl status wx-bot --no-pager && ~/.local/bin/wx-bot status
   ```

   `status` 应显示 `logged_in: true`、`delivery: pull`。**每次重新扫码后都要 `systemctl restart wx-bot`**。

5. **建 hook**：按 [`adapters/muse/wechat-hook.sh`](adapters/muse/wechat-hook.sh) 在 `~/hooks/scripts/` 下写检测脚本，套用你的 hook 脚本协议：`wx-bot inbox count --binding muse` 大于 0 时 `wake`，否则 `silent`。轮询间隔设 5–10 秒。先 `hooks.dry_run` 检查（`count` 不领取消息，dry run 不会吃掉消息），再 `hooks.enable`。

6. **被唤醒后怎么做**（把这段写进 hook 唤醒你时要执行的指令）：

   1. `~/.local/bin/wx-bot inbox pull --binding muse --lease 30m`，得到 `{"events": [...]}`。
   2. 逐条处理：`text` 是文字，`voice_text` 是语音转写，`media[].path` 是本机文件（可直接读取），`from_wxid` 是发送者。把它当作用户直接对你说的话；三者都为空的事件直接跳过。
   3. 回复：`~/.local/bin/wx-bot send --binding muse --to <from_wxid> --text - <<'EOF'`，下一行起是回复内容，最后一行 `EOF`；图片、文件、视频用 `--image` / `--file` / `--video`。只发纯文本。较长的任务先回一句简短确认，做完再发结果。
   4. 每条处理完（包括决定不回复）后：`~/.local/bin/wx-bot inbox ack <event_id>`。没 ack 的消息 30 分钟后会再次唤醒你。
   5. `send` 失败时按本文开头的规则在 Muse 聊天里告诉用户；登录过期就重做第 3 步并重启服务。

7. **告诉用户**：先用自己的微信给 ClawBot 发一条消息，之后就能对话。

---

## 升级

用户让你「升级 wx-bot」时执行。配置、登录状态、收件箱都兼容，**不需要重新扫码**。

1. **升级**：
   - 先试 `~/.local/bin/wx-bot update`（v0.4.0 及以后都有）。
   - 报 `unknown command "update"` 说明是旧版（包括 Go 版 v0.3.x），改用：

     ```bash
     curl -fsSL https://raw.githubusercontent.com/lawrencewzen/wx-bot/main/install.sh | bash
     ```

   两种方式都会自动选对文件（含 musl）、校验 sha256、替换程序，并重启正在运行的 systemd / launchd 服务。输出里出现 `restart it` 时，按提示手动重启（例如 Muse 的系统服务需要 `sudo systemctl restart wx-bot`）。
2. **确认**：`wx-bot version` 是新版本，`wx-bot status` 显示 `logged_in: true`。
3. **更新回复指令**：你的 routine 或 hook 指令里如果回复写的是 `--text '<回复>'`，改成 `--text -` 加带引号的 heredoc（见本文开头），引号就不用再手动转义。
4. **告诉用户**：从哪个版本升级到哪个版本，并请用户发一条微信确认能正常对话。

出问题需要回滚：`wx-bot update --version <旧版本号>`。Docker 部署（例如 Pi Durable）不用这一节：改镜像标签后 `docker compose up -d`。

---

## Pi Durable

Pi Durable 通过 webhook 接收、`POST /v1/send` 回复，用官方 Docker 镜像部署在 Pi 旁边。按 [`docs/integrations/pi-durable.md`](docs/integrations/pi-durable.md) 执行：配置、compose、扫码、从旧补丁迁移都在里面。
