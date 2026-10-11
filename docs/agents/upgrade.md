# wx-bot 升级

> 先读仓库根目录的 [AGENTS.md](../../AGENTS.md)：其中的「通用规则」同样适用，本文不再重复。

用户让你「升级 wx-bot」时执行。配置、登录状态、收件箱都兼容，**不需要重新扫码**。

1. **升级**：
   - 先试 `~/.local/bin/wx-bot update`（v0.4.0 及以后都有）。
   - 报 `unknown command "update"` 说明是旧版（包括 Go 版 v0.3.x），改用：

     ```bash
     curl -fsSL https://raw.githubusercontent.com/lawrencewzen/wx-bot/main/install.sh | bash
     ```

   两种方式都会自动选对文件（含 musl）、校验 sha256、替换程序，并重启正在运行的 systemd / launchd 服务。输出里出现 `restart it` 时，按提示手动重启（例如 Muse 的系统服务需要 `sudo systemctl restart wx-bot`）。
2. **确认**：`wx-bot version` 是新版本；等 15 秒后 `wx-bot health --grace 0` 退出码为 0。
3. **更新 routine / hook 指令**：
   - 回复如果写的是 `--text '<回复>'`，改成 `--text -` 加带引号的 heredoc（见 [AGENTS.md 通用规则](../../AGENTS.md#通用规则)），引号就不用再手动转义。
   - 加上 alert 事件的处理（v0.4.4 起）：`kind` 为 `alert` 时把 `alert.message` 和 `alert.hint` 在你自己的聊天里告诉用户，不要回微信。Grok 按 [Grok 安装](grok.md#安装步骤) 第 2 步最后一条改 routine 指令；Muse 按下一步。
4. **Muse 还要更新 hook**：对照 [`adapters/muse/wechat-hook.sh`](../../adapters/muse/wechat-hook.sh) 和 [Muse 安装](muse.md) 第 5、6 步，确认你的 hook 在没有新事件时会运行 `wx-bot health --liveness`、异常时唤醒你，`poll_interval_secs` 为 5，且唤醒指令里包含第 6 步的 A、B 两种情况。没有就改上，先 dry run 再启用。
5. **Grok 确认开机自启和保活**：`loginctl show-user "$(id -un)" -p Linger` 不是 `Linger=yes` 就执行 `loginctl enable-linger "$(id -un)"`；没有「wx-bot 保活」routine 就按 [Grok 安装](grok.md#安装步骤) 第 8 步建一个。Muse 确认 `systemctl is-enabled wx-bot` 为 `enabled`。
6. **告诉用户**：从哪个版本升级到哪个版本，并请用户发一条微信确认能正常对话。

出问题需要回滚：`wx-bot update --version <旧版本号>`。Docker 部署（例如 Pi Durable）不用这一节：改镜像标签后 `docker compose up -d`。
