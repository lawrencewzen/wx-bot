# wx-bot 断线排查

> 先读仓库根目录的 [AGENTS.md](../../AGENTS.md)：其中的「通用规则」同样适用，本文不再重复。

用户说收不到微信消息，或 hook 因「wx-bot 异常」唤醒你时执行。先运行：

```bash
~/.local/bin/wx-bot health --grace 0
```

按输出处理（改完都要重启服务，再跑一次 `health` 直到退出码为 0）：

| 输出 | 原因 | 处理 |
| --- | --- | --- |
| `login expired` / `not logged in` | 登录过期 | 重新扫码登录（[Grok 第 6 步](grok.md#安装步骤) / [Muse 第 3 步](muse.md)），然后重启服务 |
| `wx-bot run is not running` | 服务没在运行 | 按下方「服务没在运行」处理 |
| `the service has no proxy but this shell uses …` | 服务没带代理，连不上微信 | 按 [Muse 第 2 步](muse.md) 的命令把代理变量写进 `~/.config/wx-bot/env` |
| `the service uses proxy A but this shell uses B` 或 `if its credentials changed` | 代理地址或密码换了 | 同上，重新写一遍 env 文件 |
| `stalled` 或其他 `failing` | 卡住或网络问题 | 重启服务；仍不行把输出告诉用户 |

重启服务：Muse 用 `sudo systemctl restart wx-bot`，Grok 用 `systemctl --user restart wx-bot`。断线期间发来的消息一般会在恢复后补收。

## 服务没在运行

先看 unit 还在不在：

```bash
systemctl cat wx-bot          # Muse 的系统 unit（/etc/systemd/system/wx-bot.service）
systemctl --user cat wx-bot   # Grok 的 user unit
```

**找得到 unit：** `systemctl status wx-bot`（Grok 用 `systemctl --user`）看原因，日志用 `journalctl -u wx-bot -n 50`（Grok 加 `--user`），修好后按上面的命令重启。

**`systemctl cat wx-bot` 提示找不到 unit**（运行环境被替换、`/etc` 被清空）：二进制、配置、登录态都在 home 下，**不用重新扫码**。先停掉 keepalive 可能留下的 nohup 进程，再按 [Muse 第 4 步](muse.md) 重装 unit 并 `enable --now`：

```bash
pkill -f "wx-bot.* run$" 2>/dev/null || true
HOME_ABS="$(cd ~ && pwd)"
USER_NAME="$(stat -c '%U' "$HOME_ABS" 2>/dev/null || id -un)"
curl -fsSL https://raw.githubusercontent.com/lawrencewzen/wx-bot/main/adapters/muse/wx-bot.service \
  | sed "s|__HOME__|${HOME_ABS}|g; s|__USER__|${USER_NAME}|g" \
  | tee /etc/systemd/system/wx-bot.service >/dev/null
systemctl daemon-reload && systemctl enable --now wx-bot
```

写 `/etc` 若 Permission denied，把 `tee` 改成 `sudo tee`，两条 `systemctl` 改成 `sudo systemctl`。装好后等 15 秒：

```bash
systemctl status wx-bot --no-pager
~/.local/bin/wx-bot health --grace 0
```

退出码必须为 0。这不是用户故意停服务，直接重装，不必先问。在你自己的聊天里告诉用户：运行环境替换导致 systemd unit 丢失，已重装，登录态还在，不用扫码。

**不能用 systemd**（没有 `systemctl`，或上面安装失败）时，不要反复 `systemctl restart`，直接运行：

```bash
~/.local/bin/wx-bot-keepalive
```

它只输出一行：`ok` / `restarted: …` 表示已经在收消息；`NEED_USER: …` 把后面的原因告诉用户。这只是把进程拉起来，下次环境再被替换仍要按上面重装 unit 才能开机自启。详见 [Muse：运行环境会被替换时](muse.md#运行环境会被替换时)。

## 二维码扫了提示过期

二维码约 2 分钟有效。让用户看到的图片必须是日志里**最新**的那张，并且登录进程还在：

```bash
grep "QR " ~/wx-bot-login.log          # 最新一行的 QR #n、id、expires_at（UTC）
pgrep -af "wx-bot login"               # 必须有输出；没有说明登录进程已结束，要重新执行登录命令
ls -l --time-style=full-iso ~/workspace/*qr*.png
date -u
```

- 你发出的消息里写的 id，要和最新 `QR PNG:` 路径里的 id 一致，且当前时间早于 `expires_at`。
- 聊天界面可能按路径缓存图片：只发日志里给出的路径，**不要**复制或改名；v0.4.7 起文件名带二维码 id，不会和以前的重名。
