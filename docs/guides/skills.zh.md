# 后台 Skills

Skills 是包含 `SKILL.md` 的标准技能目录，由后台 Agent 读取和执行。它们不会安装给语音前台，也不会给前台增加 Shell 或文件执行环境。

## 安装与管理

`qwenaudio skill` 调用社区 [skills.sh](https://skills.sh) 安装器，自动选择已探测到及当前配置的受支持后台作为安装目标。

先查看来源包含哪些技能，再安装需要的项：

```bash
qwenaudio skill install vercel-labs/agent-skills --list
qwenaudio skill install vercel-labs/agent-skills --skill web-design-guidelines
```

也可以使用 Git 仓库 URL 或本地目录：

```bash
qwenaudio skill install ./my-skill --skill my-skill
```

`--skill` 可重复指定。只安装你需要且信任的技能，不会默认安装整个技能仓库。

```bash
qwenaudio skill list
qwenaudio skill remove <名称>
qwenaudio skill update
```

## 安装到哪里

技能写入后台支持的用户级目录，例如 `~/.qwen/skills/`、`~/.claude/skills/` 或 `~/.agents/skills/`。直接启动这些 Agent 时也能使用；桌面版和 CLI 无需各装一份。

只有声明支持该安装器的后台会被选为目标。MiniMax Code 的 Skill / Plugin 存储由它自己管理，当前不会写入其私有目录。

切换后台后，Gateway 会在启动时根据安装器锁文件检查并尝试同步缺失技能。同步失败会记录日志，不会将安装成功当作既成事实。离线时可稍后重新安装或启动。

## 让技能生效

各后台的重新加载机制不同。安装后未发现新技能时，[重启实际使用的 Gateway](../operations/gateway.zh.md#修改配置后生效)，让它重新启动后台。再明确要求使用该技能，并检查工作结果；技能可用不表示每次都会被模型选中。

前台按请求调用后台执行，不会读取后台的全部技能内容作为自己的提示词。技能需要的工具、凭据和依赖仍需在后台环境准备好。

## 高级配置

可用 `QWEN_AUDIO_AGENT_SKILLS_CLI_PACKAGE` 覆盖安装器包版本。通常保留默认值即可。

技能安装目录与工作目录不同。后台默认在共享的 `<data-dir>/workspace` 处理文件；覆盖方式见[后台通用设置](../configuration/backend.zh.md)。
