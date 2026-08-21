# dsh-sidebar-open-in-ide

在 DSH Web GUI 中一键把文件送到 IntelliJ IDEA 打开——依托 JetBrains MCP Server（stdio 直连），不经过 mcp-proxy 网关。

![license](https://img.shields.io/badge/license-MIT-blue)

## 功能

- **侧边栏 · 文件管理（explorer）**：每个文件行在 `@` 引用按钮旁新增 `idea` 按钮，点击即在 IDEA 打开该文件（目录/损坏链接/加载行自动跳过）
- **侧边栏 · 源代码管理（git）**：已暂存 / 未暂存列表每行新增 `idea` 按钮（按钮携带仓库相对路径，由 Node half 经会话工作目录的 git 根解析为绝对路径）
- **侧边栏 · 文件预览**：顶部路径输入框右侧新增常驻 `idea` 按钮
- **全局快捷键**：`Cmd/Ctrl + Shift + O` 把当前预览中的文件带到 IDEA
- **打开后自动激活 IDE 窗口**：macOS `open -a` / Windows PowerShell AppActivate / Linux wmctrl→xdotool（尽力而为，失败不影响打开）
- **DSH 设置页**：「在 IDEA 中打开」设置项（ideaHome），免改配置文件

## 依赖

| 依赖 | 版本 | 必需 | 说明 |
|---|---|---|---|
| DSH | >= 0.1.x（web） | ✅ | 宿主 |
| [dsh-better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar) | >= 0.14.0 | ✅ | 按钮注入其侧边栏 DOM（v0.14.0 验证） |
| IntelliJ IDEA | 2024.2+（含 MCP Server 插件） | ✅ | 端口 64342 提供 JetBrains MCP |
| schemastery / @deepseek-ai/dsh-settings | — | ✅ | Node half 运行时依赖（自动安装） |

> **关于类名兼容（重要）**：better-sidebar 的类名是 CSS Modules 格式 `<哈希>_<局部名>`（如 `nArs4W_explorerRow`）。本插件**只依赖局部名**（`explorerRow` 等），运行时通过 classList 后缀匹配动态定位元素、并从元素上反向提取哈希前缀拼回注入按钮的 `_explorerRef` 类——因此 better-sidebar 升级更换哈希前缀不会破坏功能；只有源码层局部类名被改时才可能失效（此时按钮静默不显示，其余功能不受影响）。

## 安装

```bash
# 1. 确保已安装侧边栏插件
dsh plugin --profile web add dsh-better-sidebar

# 2. 把本插件放入 profile 插件目录
cp -r dsh-sidebar-open-in-ide ~/.dsh/profiles/web/node_modules/

# 3. 在 ~/.dsh/profiles/web/cordis.patch.yml 追加条目
```

```yaml
- insert:
    - id: open-in-ide
      name: 'dsh-sidebar-open-in-ide'
```

```bash
# 4. 重启 web 进程（如 pm2 管理）
pm2 restart dsh-web
```

## 配置

### 方式一：设置页（推荐）

打开 DSH 设置 → 「在 IDEA 中打开」，填入 IDEA 安装根目录后保存，下次点击按钮即生效（无需重启）。

### 方式二：patch 配置

`cordis.patch.yml` 的 `open-in-ide` 条目可传 `config.ideaHome`（设置页未配置时作为回退）：

```yaml
- insert:
    - id: open-in-ide
      name: 'dsh-sidebar-open-in-ide'
      config:
        ideaHome: '/Applications/IntelliJ IDEA.app'   # macOS（默认值，可省略）
        # ideaHome: 'C:\\Program Files\\JetBrains\\IntelliJ IDEA'   # Windows
        # ideaHome: '/opt/idea'                                      # Linux
```

不配置时按平台默认探测：macOS 为 `/Applications/IntelliJ IDEA.app`；Windows / Linux 需要在 IDEA 安装根目录下存在 `jbr/bin/java` 与 `plugins/mcpserver/lib/mcpserver-frontend.jar`。

## 使用

| 入口 | 操作 |
|---|---|
| explorer / git 文件行 | 悬停行 → 点击 `idea` 按钮 |
| 文件预览 | 点击路径框右侧 `idea` 按钮 |
| 快捷键 | `Cmd/Ctrl + Shift + O`（需先在侧边栏打开文件） |

按钮反馈：`✓` 打开成功；`✕` 失败（toast 显示具体原因）。

## 错误码

| 错误码 | 含义 |
|---|---|
| `JAVA_MISSING` | 未找到 IDEA 安装布局（请到设置页配置 ideaHome） |
| `SPAWN_FAILED` | 无法启动 IDEA MCP 进程 |
| `IDE_UNAVAILABLE` | IDEA 未运行或 MCP 未就绪 / 工具不完整（未打开任何项目） |
| `IDE_CRASHED` | IDEA MCP 进程退出，冷却后自动重试 |
| `NOT_FOUND` | 文件不存在 |
| `NOT_IN_PROJECT` | 文件不在任何已打开的 IDEA 项目中 |
| `IDE_CALL_FAILED` | IDEA 拒绝了 MCP 调用 |
| `TIMEOUT` | MCP 调用超时 |
| `GIT_ROOT_NOT_FOUND` | git 行路径无法解析（会话目录不在 Git 仓库中） |

## 工作原理

- **Node half**（`lib/index.js`）：常驻 spawn `com.intellij.mcpserver.stdio.McpStdioRunnerKt`（与 dsh-mcp-client 的 jetbrains 条目同款 classpath），实现 JSON-RPC 2.0 over stdio（initialize → initialized → tools/list → tools/call）；暴露三个 HTTP 路由：`POST /open-in-ide`、`GET /open-in-ide/status`、`POST /open-in-ide/settings`（设置页读写，revision 防冲突）
- **Browser half**（`lib/client.js`）：三个 MutationObserver DOM 注入点 + 全局快捷键 + DSH 设置页 section（`settings.section` slot）

## License

MIT
