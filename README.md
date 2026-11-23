# dsh-lark-TA

C++ 课程 AI 助教的 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 飞书插件：常驻长连接，按 chat 路由到独立会话，课程群/私聊答疑，受限文件工具，长期记忆，每晚整理，外加一个侧边栏控制面板。

与个人版机器人（feishu-channel）结构相同但完全独立：独立飞书应用、独立工作区、独立记忆目录、独立的 agent preset。

## 功能

- **多会话路由**：每个飞书 chat 一个按天新建的会话（`feishu-<chatId>-<YYYYMMDD>`），群聊仅 @ 触发，私聊有每日条数上限。
- **两套 preset**：普通会话（课程群、学生私聊）无 shell、无原生文件工具、无飞书 MCP；助教/老师小群额外挂载精简版飞书 MCP（文档、日历、任务、wiki、通讯录、读消息）。
- **受限文件工具**：`ta_fs` 只读课程目录、只写工作区；`doc_exec` 只允许 unzip/pdftotext/pdfinfo/file；`view_image` 按需把图片交给多模态模型；`luogu` 检索洛谷题库。
- **长期记忆**：全局记忆 + 每个 chat 的记忆（Markdown 存储，原子写入）。普通会话只能写本 chat，全局记忆只由每晚的整理会话提炼。
- **记忆整理**：常驻 `feishu-root` 会话，每晚 03:17（可配）读取登记的课程群会话，用 `feishu_memory` 写入/清理。
- **定时任务**：只在助教/老师小群创建；到点唤醒当天会话，发送结果。
- **控制面板**：dsh 侧边栏「TA」整页，含概览、会话、工作安排、记忆、工具挂载、热更新参数六个页签。

## 目录

```
index.js              channel 主插件（连接、路由、会话、面板数据）
scheduler.js          定时任务持久化与触发
memory-store.js       记忆 Markdown 存储
memory-context.js     每轮注入记忆
memory-tool.js        feishu_memory 工具
memory-curator.js     每晚记忆整理
history-store.js      本地聊天历史
history-context.js    每轮注入最近聊天记录
reply-tool.js         引用回复 / 新消息
send-file.js          发送工作区文件
send-text.js          主动发新消息（仅小群）
schedule-tool.js      定时任务工具（仅小群）
ta-fs.js             受控文件读写
ta-fs-scope.js        路径作用域校验
doc-exec.js           受限文档命令
luogu.js              洛谷题库检索
view-image.js         按需看图
panel-runtime.js      面板与 channel 的模块级桥
curator-runtime.js    面板与整理器的模块级桥
ui/                   控制面板（Host 路由 + 浏览器 bundle，独立包）
TA.md                 助教守则（注入系统提示）
流程安排.md           助教工作流程手册（注入系统提示）
cordis.patch.yml      profile 补丁：插件条目、面板、三个 preset
```

## 部署

前置：Node.js >= 20，已安装 dsh（`>=0.2.1-rc.1 <0.3.0-0`），一台能长期在线的服务器。

1. 获取代码并安装依赖：

   ```bash
   git clone https://github.com/PLAtinuM-Baijin/dsh-lark-TA.git
   cd dsh-lark-TA
   npm install
   ```

2. 把 `cordis.patch.yml` 里的面板入口 `/opt/dsh-lark-TA/ui/index.js` 改成实际部署路径（绝对路径）。

3. 准备 dsh profile（示例 `ta`）：

   ```bash
   mkdir -p ~/.dsh/profiles/ta
   ```

   `~/.dsh/profiles/ta/package.json`：

   ```json
   {
     "name": "@local/ta-profile",
     "private": true,
     "dependencies": {
       "@local/dsh-lark-ta": "link:/opt/dsh-lark-TA"
     },
     "bundles": [
       "@deepseek-ai/dsh-base",
       "@deepseek-ai/dsh-web-app",
       "@local/dsh-lark-ta"
     ]
   }
   ```

   如需 PPT 工具，自行安装 `dsh-ppt-studio` 并加入 bundles（本仓库不依赖它）。

4. 飞书 MCP（可选，但助教小群的 preset 会引用它）：

   ```bash
   git clone <lark-mcp-dsh 仓库> /opt/lark-mcp-dsh
   cd /opt/lark-mcp-dsh && npm install
   ```

   或把 `TA_LARK_MCP_DIR` 指向已有副本。未配置时 MCP 工具行会启动失败，但不影响其他功能。

5. 配置环境变量（建议 `systemd EnvironmentFile`，权限 0600，不要写进仓库）：

   ```bash
   cp .env.example /etc/dsh-lark-ta.env
   # 编辑：填写 TA_APP_ID / TA_APP_SECRET / 群 chat_id / 工作区路径等
   chmod 600 /etc/dsh-lark-ta.env
   ```

6. 启动：在 `~/.dsh/profiles/ta` 下用 dsh 启动，或在 systemd 单元里设置 `EnvironmentFile`、`WorkingDirectory` 与 `dsh` 命令。控制面板地址为 `http://<host>:<port>/ta-panel/state` 所在的 dsh Web 页面，侧边栏进入「TA」。

7. 把 `TA.md` 与 `流程安排.md` 放到 `TA_WORKSPACE`（工作区根目录），按你的课程信息补全班级群 chat_id、工作区路径等本地内容。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `TA_APP_ID` / `TA_APP_SECRET` | 飞书自建应用凭据 |
| `TA_WORKSPACE` | agent 工作区（唯一可写目录，也是会话 cwd） |
| `TA_READ_DIRS` | 课程目录，只读；逗号分隔 |
| `TA_FILES_DIR` | 入站附件归档目录；应位于工作区内 |
| `TA_MEMORY_DIR` | 长期记忆目录；默认 `~/.dsh-lark-ta-memory` |
| `TA_SCHEDULE_FILE` | 定时任务持久化文件；默认 `~/.dsh-lark-ta-schedules.json` |
| `TA_HISTORY_DIR` | 本地聊天历史；默认 `~/.dsh-lark-ta-history` |
| `TA_DM_LIMIT_FILE` | 私聊日限用量文件；默认 `~/.dsh-lark-ta-dm-limits.json` |
| `TA_GROUP_CHAT_IDS` | 允许接收消息的群 chat_id；逗号分隔 |
| `TA_MANAGER_CHAT_IDS` | 助教/老师小群 chat_id（必须是上面群列表的子集）；逗号分隔 |
| `TA_CURATOR_CHAT_IDS` | 参与夜间整理的群；逗号分隔 |
| `TA_PUBLIC_CHAT_IDS` | 其中属于公开群（班级大群）的 chat_id；其余按内部群处理 |
| `TA_CURATOR_TIME` | 每晚整理时间，`HH:MM`，默认 `03:17`（Asia/Shanghai） |
| `TA_DM_DAILY_LIMIT` | 每个私聊每天最多提问条数；`0` 表示不限 |
| `TA_CARD_STREAMING` | `false` 关闭流式卡片，改为普通消息 |
| `TA_LARK_MCP_DIR` | lark-mcp-dsh 的部署目录 |
| `TA_OWNER_OPEN_ID` | 飞书 MCP 的 owner open_id（OAuth 授权卡接收者） |

## 控制面板

- **概览**：长连接状态、活跃会话、定时任务、记忆条目；运行参数、访问控制、记忆整理、运行信息、快捷操作。
- **会话**：当前进程内的活跃会话，标注助教/老师小群、课程群、学生私聊。
- **工作安排**：把定时任务与每晚记忆整理按下次触发时间排成一张表；下方可两步确认取消任务。
- **记忆**：按作用域只读展示条目与提示词注入预览。
- **工具挂载**：按 preset 列出工具行，可逐行开关；写回 profile 的 `cordis.patch.yml` 并热重载。
- **设置**：标注为 volatile 的字段可直接改，保存后立即生效；密钥与结构性字段仍需改配置并重启。

面板路由：`/ta-panel/{state,memory,params,tools,action}`，全部走 dsh 登录态与 Host/Origin 校验。

## 安全模型

- **没有 shell**；文件工具只读课程目录、只写工作区。
- **学生私聊只写 `scope=chat`**；全局记忆只由夜间整理会话写入。
- **飞书 MCP 只挂在助教/老师小群的 preset**；学生私聊与课程群拿不到文档/日历工具。
- 未审核的题目、答案、内部材料不发班级大群或学生私聊。
- 密钥只通过环境变量注入，不写进仓库与聊天。

## 开发

```bash
npm test          # ta-fs-scope 路径作用域测试
node --check index.js
```

控制面板 `ui/client.js` 是无构建步骤的浏览器 bundle（React.createElement），`ui/index.js` 是 Host 路由半身。

## License

MIT
