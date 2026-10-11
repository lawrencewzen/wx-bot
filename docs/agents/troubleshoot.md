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
| `wx-bot run is not running` | 服务没在运行 | `systemctl status wx-bot`（Grok 用 `systemctl --user`）看原因，日志用 `journalctl -u wx-bot -n 50`，修好后启动 |
| `the service has no proxy but this shell uses …` | 服务没带代理，连不上微信 | 按 [Muse 第 2 步](muse.md) 的命令把代理变量写进 `~/.config/wx-bot/env` |
| `the service uses proxy A but this shell uses B` 或 `if its credentials changed` | 代理地址或密码换了 | 同上，重新写一遍 env 文件 |
| `stalled` 或其他 `failing` | 卡住或网络问题 | 重启服务；仍不行把输出告诉用户 |

重启服务：Muse 用 `sudo systemctl restart wx-bot`，Grok 用 `systemctl --user restart wx-bot`。断线期间发来的消息一般会在恢复后补收。

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
