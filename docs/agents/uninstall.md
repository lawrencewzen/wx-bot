# wx-bot 卸载 / 重装

> 先读仓库根目录的 [AGENTS.md](../../AGENTS.md)：其中的「通用规则」同样适用，本文不再重复。

用户让你「卸载 wx-bot」或「删掉重装」时执行。**一定按本文删，不要自己列清单**：自己删容易漏掉旧的二维码图片和被旧版改坏的 `~/workspace` 权限，重装后扫码会一直提示过期或显示「找不到图片」。

1. **先看会删什么**（不会真的删）：

   ```bash
   ~/.local/bin/wx-bot uninstall
   ```

   把列出的内容告诉用户并确认。用户只是想重装、**不想重新扫码**时，加 `--keep-data`（保留配置和登录状态）。

2. **执行**：

   ```bash
   ~/.local/bin/wx-bot uninstall --yes            # 或 --yes --keep-data
   ```

   它会停掉并删除 systemd / launchd 服务，删除配置、登录状态、收件箱、媒体、日志、二维码图片、`wx-bot` 和 `wx-bot-keepalive`，并把被旧版改成 700 的 `~/workspace` 改回 755。

3. **删掉你这边的配置**（命令删不到）：
   - Muse：删除 wx-bot 的 hook（含 `~/hooks/scripts/` 下的检测脚本），以及你自己建的 wx-bot 巡检任务。
   - Grok：删除「微信消息」和「wx-bot 保活」两个 routine。

4. **告诉用户**删除了什么。要重装就按 [AGENTS.md](../../AGENTS.md) 从头来。

## 旧版本（没有 `uninstall` 命令，v0.4.6 及以前）

```bash
systemctl --user disable --now wx-bot 2>/dev/null; sudo -n systemctl disable --now wx-bot 2>/dev/null
pkill -f "wx-bot.* (run|login)"
rm -f ~/.config/systemd/user/wx-bot.service; sudo -n rm -f /etc/systemd/system/wx-bot.service
rm -rf ~/.config/wx-bot ~/.local/state/wx-bot ~/.cache/wx-bot ~/wx-bot-login.log \
  ~/wx-bot-qr*.png ~/workspace/wx-bot-qr*.png ~/workspace/wxqr*.png \
  ~/.local/bin/wx-bot ~/.local/bin/wx-bot-keepalive
[ "$(stat -c %a ~/workspace 2>/dev/null)" = 700 ] && chmod 755 ~/workspace
```

要保留登录状态就去掉 `~/.config/wx-bot ~/.local/state/wx-bot` 两项。然后照第 3、4 步做。
