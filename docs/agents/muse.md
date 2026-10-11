# wx-bot 安装：Muse

> 先读仓库根目录的 [AGENTS.md](../../AGENTS.md)：其中的「通用规则」同样适用，本文不再重复。

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

2. **写配置**：`~/.config/wx-bot/config.json`（目录权限 0700，文件 0600），内容取自 [`examples/config.pull.example.json`](../../examples/config.pull.example.json)，binding 名为 `muse`，`"delivery": "pull"`。pull 模式不需要 webhook URL 和 key。

   如果你的 shell 里有代理变量（`env | grep -i _proxy` 有输出），把它们写进 `~/.config/wx-bot/env`。systemd 服务启动时**不带**这些变量，不写的话服务连不上微信：

   ```bash
   f=~/.config/wx-bot/env; touch "$f"
   { grep -viE '^(https?|all|no)_proxy=' "$f"; env | grep -iE '^(https?|all|no)_proxy='; } > "$f.new"
   mv "$f.new" "$f" && chmod 0600 "$f"
   ```

3. **扫码登录**：二维码要以**图片**发给用户。**每张码只有约 2 分钟有效**，务必生成后立刻发。

   ```bash
   pkill -f "wx-bot login" 2>/dev/null
   mkdir -p ~/workspace
   setsid nohup ~/.local/bin/wx-bot login muse --qr-png ~/workspace/wx-bot-qr.png --timeout 10m \
     > ~/wx-bot-login.log 2>&1 < /dev/null &
   ```

   `setsid` 让登录进程脱离当前命令，不会在命令结束后被清理掉。登录进程会一直等 10 分钟，每张码过期就换一张。每张码单独一个文件（`~/workspace/wx-bot-qr-1.png`、`~/workspace/wx-bot-qr-2.png`……，即 `sandbox://workspace/wx-bot-qr-<n>.png`），日志里对应两行：`QR #n id=... generated_at=... expires_at=...`（UTC）和 `QR PNG: <路径>`。

   - **日志里出现新的 `QR PNG: <路径>`，立刻把这个路径的图片原样发到聊天里**，中间不要做别的事。**不要复制或改名成固定文件名**（如 `wx-bot-qr.png`）：聊天界面按路径缓存图片，同一路径永远显示第一张，用户扫到的就一直是过期码。消息里同时写上 `QR #n` 和 id 前 8 位，方便用户核对。告诉用户：「用微信扫这个二维码并在手机上确认，约 2 分钟内有效」。用户需要在另一块屏幕上看到它再用手机扫，同一台手机扫不了自己屏幕上的码。
   - 同一个 `QR #n` 只发一次。之后继续盯日志：出现 `QR #n+1` 说明上一张已过期，立即发新图；出现 `login ok` 即成功。
   - **发图前先确认登录进程还在**：`pgrep -f "wx-bot login"` 有输出，且图片文件存在。登录进程一结束（成功、超时或被杀）这些图片都会被删除，聊天里的旧图会显示 Not found，这是正常的。图片不存在就**不要**发任何旧图，看日志最后一行：`login ok` 是成功；`not scanned within 10m0s` 是超时，等用户说准备好了再重新执行上面的命令；其他情况直接重新执行。
   - 用户说「过期了」：看日志最新的 `QR #n` 和进程是否还在，按上面两条发新图或重启登录，不要重发同一张。

4. **常驻服务**：取 [`adapters/muse/wx-bot.service`](../../adapters/muse/wx-bot.service)，把 `__HOME__` 换成 home 的绝对路径、`__USER__` 换成该目录的属主，安装为 `/etc/systemd/system/wx-bot.service`，然后：

   ```bash
   systemctl daemon-reload && systemctl enable --now wx-bot
   systemctl status wx-bot --no-pager && ~/.local/bin/wx-bot status
   ```

   `systemctl is-enabled wx-bot` 应为 `enabled`：系统服务随电脑开机自动启动，重启后不用管。`status` 应显示 `logged_in: true`、`delivery: pull`。再等 15 秒运行 `~/.local/bin/wx-bot health --binding muse --grace 0`，退出码必须为 0；否则按输出提示处理（最常见的是第 2 步的代理没写）。**每次重新扫码或改了 env 文件后都要 `systemctl restart wx-bot`**。

5. **建 hook**：按 [`adapters/muse/wechat-hook.sh`](../../adapters/muse/wechat-hook.sh) 在 `~/hooks/scripts/` 下写检测脚本，套用你的 hook 脚本协议：
   - `wx-bot inbox count --binding muse` 大于 0 时 `wake`（有新消息）；
   - 否则运行 `wx-bot health --binding muse --liveness`，退出码非 0 时 `wake`（wx-bot 服务没在运行或卡住，唤醒文字以「wx-bot 异常：」开头并带上它的输出），同一个问题只唤醒一次、之后每小时最多再提醒一次。连不上微信、登录过期会以 alert 事件进收件箱，由上一条唤醒；
   - 其余 `silent`。

   轮询间隔：建 hook 时 **`poll_interval_secs` 设为 5**（平台下限，默认 60 太慢）。先 `hooks.dry_run` 检查（`count` 和 `health` 都不领取消息，dry run 不会吃掉消息），再 `hooks.enable`。

6. **被唤醒后怎么做**（把这段**完整**写进 hook 唤醒你时要执行的指令）：

   **先看唤醒原因。**

   **A. 原因以「wx-bot 异常」开头**（wx-bot 服务没在运行或卡住）：
   1. **不要**去 pull 消息，也不要自行重启服务（用户可能是故意停的）。
   2. 运行 `~/.local/bin/wx-bot health --binding muse --grace 0`，对照[断线排查](troubleshoot.md)判断原因和处理办法。
   3. **必须在 Muse 聊天里给用户发一条消息**，即使你什么都没修：说明「微信桥异常」、`health` 的原因（翻译成中文）、建议的处理办法，并问用户是否要你处理。这一步不能省，否则用户完全不知道微信断了。

   **B. 原因是「微信有 N 条新事件」：**
   1. `~/.local/bin/wx-bot inbox pull --binding muse --lease 30m`，得到 `{"events": [...]}`。
   2. `kind` 为 `alert` 的事件是 wx-bot 异常通知（连不上微信、登录过期、已恢复）：**必须**在 Muse 聊天里把 `alert.message` 和 `alert.hint` 用中文告诉用户，问是否需要你处理，然后 ack。不要回微信。
   3. 其余事件逐条处理：`text` 是文字，`voice_text` 是语音转写，`media[].path` 是本机文件（可直接读取），`from_wxid` 是发送者。把它当作用户直接对你说的话；三者都为空的事件直接跳过。
   4. 回复：`~/.local/bin/wx-bot send --binding muse --to <from_wxid> --text - <<'EOF'`，下一行起是回复内容，最后一行 `EOF`；图片、文件、视频用 `--image` / `--file` / `--video`。只发纯文本。较长的任务先回一句简短确认，做完再发结果。
   5. 每条处理完（包括决定不回复）后：`~/.local/bin/wx-bot inbox ack <event_id>`。没 ack 的消息 30 分钟后会再次唤醒你。
   6. `send` 失败时按 [AGENTS.md 通用规则](../../AGENTS.md#通用规则)在 Muse 聊天里告诉用户；登录过期就重做第 3 步并重启服务。

7. **告诉用户**：先用自己的微信给 ClawBot 发一条消息，之后就能对话。
