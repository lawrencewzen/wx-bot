# wx-bot 安装：Grok Bot

> 先读仓库根目录的 [AGENTS.md](../../AGENTS.md)：其中的「通用规则」同样适用，本文不再重复。

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
   - JSON 里 `kind` 为 `alert` 时不是微信消息，而是 wx-bot 的异常通知：把 `alert.message` 和 `alert.hint` 用中文在 Grok Bot 聊天里告诉用户，不要回微信。

3. **发出两个字段链接**：按上面「必须遵守」一节，在聊天回复里发出「Webhook URL」和「Webhook key」链接。

4. **接收 URL 和 key**
   - 用户把 Webhook URL 贴回聊天。
   - 弹出**加密输入框**让用户填 Webhook key，存为环境变量 `WXBOT_WEBHOOK_KEY`。不要让用户把 key 贴进聊天。

5. **写配置**
   - `~/.config/wx-bot/config.json`：`bindings[0].webhook.url` 填用户给的 URL，`key` 保持 `env:WXBOT_WEBHOOK_KEY`。不用签名时**删掉 `secret` 这一行**，否则环境变量未设置会导致启动失败。
   - `~/.config/wx-bot/env`：写入 `WXBOT_WEBHOOK_KEY=<key>`（格式 `KEY=value`，不加 `export`）。

6. **扫码登录**：运行 `wx-bot login <binding>`（`<binding>` 是配置里 `bindings[0].name`，示例配置为 `xiaox`），把二维码展示给用户，让用户用微信扫码。二维码约 2 分钟过期，过期会自动换新码，10 分钟内没扫码就退出（`--timeout` 可调）。

7. **启动，并设为开机自启**

   ```bash
   systemctl --user enable --now wx-bot
   loginctl enable-linger "$(id -un)"        # 用户服务开机就启动，不用等登录
   loginctl show-user "$(id -un)" -p Linger   # 应显示 Linger=yes
   ```

   `install.sh --service` 已尝试开启 linger；上面再确认一次。没有 `systemctl --user` 的环境跳过这一步，由下一步的保活任务负责启动。然后按 [AGENTS.md 通用规则](../../AGENTS.md#通用规则)用 `wx-bot health --grace 0` 确认能收到消息。

8. **建保活 routine**：云电脑可能被重启或恢复，服务不一定自己回来。再建一个 routine，名称如「wx-bot 保活」，触发方式选**定时、每 10 分钟**，指令写：

   > 运行 `~/.local/bin/wx-bot-keepalive`（不存在就先执行 `curl -fsSL https://raw.githubusercontent.com/lawrencewzen/wx-bot/main/deploy/keepalive.sh -o ~/.local/bin/wx-bot-keepalive && chmod 0755 ~/.local/bin/wx-bot-keepalive`）。输出 `ok` 或 `restarted: …` 时什么都不用说，静默结束；输出 `NEED_USER: …` 时，把后面的原因翻译成中文，在聊天里告诉用户并说明怎么处理（例如登录过期就请用户重新扫码）。

   这个脚本会：wx-bot 没在运行就用保存的登录状态重新启动（**不需要重新扫码**），程序文件丢了就自动重装，只有登录过期、代理失效这类它修不好的问题才输出 `NEED_USER`。

9. **告诉用户**：先用自己的微信给 ClawBot 发一条消息，之后就能对话。
