# Hireloop · 招聘工作台

给公司内部招聘团队用的轻量招聘工作台。职位、候选人、筛选、面试、谈薪和入职在同一个工作台处理。数据存于本地 SQLite，AI 功能通过管理员配置的 OpenAI 兼容 API 调用，飞书接入默认关闭。

## 快速开始

```bash
npm install          # 首次安装依赖
npm run dev          # 同时启动 API(8787) 与前端(5173)，访问 http://127.0.0.1:5173
```

首次启动空库时按页面提示注册管理员。需要演示数据时，在独立的数据目录运行 `npm run seed`，启动时沿用同一个目录。脚本会设置演示账号 `123` / `123`，请只用于本机演示库。

管理员在「设置 → AI 模型」填写 API 地址、模型 ID 和密钥，保存后测试连通性。DeepSeek 官方地址为 `https://api.deepseek.com`，模型 ID 为 `deepseek-flash`。

生产模式（单进程同时提供 API 与前端静态文件）：

```bash
npm run build        # 类型检查 + 打包 web/dist
npm start            # NODE_ENV=production，访问 http://127.0.0.1:8787
```

生产模式默认给会话 cookie 加 `Secure`（浏览器把 127.0.0.1 / localhost 视为可信来源，所以本机预览没问题）。如果要把服务放到内网 `http://` 上给别人试用，启动时加 `HIRELOOP_INSECURE_COOKIE=1`，否则对方登录后拿不到会话。

其他命令：

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 前后端 `tsc --noEmit` 类型检查 |
| `npm test` | 运行单元测试和接口测试 |
| `npm run db:reset` | 清空默认开发数据及上传文件，仅用于可丢弃的本地数据 |
| `node scripts/shot.mjs` | 使用本地 Chrome 截图，用于视觉回归 |
| `npm run smoke` | 在隔离数据库中执行浏览器冒烟检查，覆盖简历导入、筛选和面试到入职 |
| `npm run flow -- --no-llm` | 用隔离数据库验证无模型时的招聘流程 |
| `npm run flow` | 接真实模型执行流程回归，所需配置见开发文档 |
| `npm run smoke:permissions` | 浏览器端权限冒烟：管理员加成员、成员看不到删除与飞书配置、越权接口被 403 |
| `npm run smoke:heading` | 浏览器端头部状态检查：隔离库里走「未投递 → 投递 → 排期 → 取消」，核对详情头部状态与排期入口（不需要 `npm start`） |
| `node scripts/measure.mjs` | 响应式溢出测量：两种以上宽度 × 八个页面逐一检查 `scrollWidth` |

交互验证、截图和独立评审记录见 [评审记录](REVIEW.md)。手测步骤与剩余验收项见 [下一阶段开发文档](docs/下一阶段开发文档.md)。视觉规范见 [设计契约](DESIGN.md)。

## 功能范围

1. **工作台首页** — 今日该做的事、今日面试、招聘漏斗、职位进度、超过 5 天没动作的跟进项、最近动作、候选人来源。
2. **职位管理** — 职位增删改查、开放/暂停/关闭、编制人数、薪资区间、技能关键词；职位卡片用「流动带」显示各阶段人数。
3. **候选人管理** — 候选人库、按投递职位筛选、按流程阶段分类、关键词搜索、档案字段、标签、负责人、投递记录、面试记录。顶部按「待筛选 / 面试中 / 谈薪 / 待入职 / 已入职 / 已拒绝 / 未投递」展示人数。职位、阶段和关键词可组合筛选。选定职位后，阶段和人数都按该职位的投递统计。详情头部直接显示所投职位与当前阶段；已安排面试时显示最近一场的时间，未排期时才出现「安排面试」，追加投递与下一轮排期分别收在「投递其他职位」和面试记录卡片里。
4. **职位内六个子模块** — 一个职位就是一次招聘的完整工作面，子导航固定为「概览 → 岗位画像 → 简历筛选 → 面试 → 谈薪 → 入职」，序号就是推荐顺序，六个子模块都能当场把事做完，不用跳去候选人页。概览页只做导航和汇总，给出「下一步」建议；确认岗位画像后，在简历筛选里拖入或选择 PDF、DOCX、TXT、MD 简历，**一次可选多份**，逐份导入并逐份报结果，每份最大 8 MB。先看 AI 摘选的简历原句，再按需展开画像评分，由招聘人员推进初试或归档。
5. **就地操作与批量** — 筛选、谈薪、入职都在职位页的行内抽屉里完成；面试在面试子模块里直接贴稿、看总结、定去留。筛选队列支持搜索、全选、批量推进初试和批量归档（带原因），批量里个别失败会逐条列出，不影响其他已成功的记录。
6. **谈薪与入职** — 谈薪后可生成可复制的 Offer 文本，招聘人员记录发出、接受和确认入职；入职页汇总待入职与已入职，归档投递仍可查看和恢复。
7. **面试管理** — 支持初试和可选复试，记录面试安排、改期、取消和未到场。保存逐字稿后生成本轮总结，复试完成后可查看两轮综合评估。招聘人员确认下一步。

角色与权限：

| 能力 | admin | recruiter | hiring_manager |
| --- | --- | --- | --- |
| 查看职位、候选人、面试 | ✓ | ✓ | ✓ |
| 新建或编辑职位、录入投递、安排面试、推进或归档 | ✓ | ✓ | 只读 |
| 创建成员、改角色、配置飞书、删除职位/候选人 | ✓ | ✗ | ✗ |

- **注册只在初始化时开放**：系统里还没有用户时，第一个注册的人成为管理员；之后新增成员必须由管理员在「设置 → 团队与权限」里创建，避免外部人员注册后看到全部候选人。
- **已入职是最终状态**：不能再拒收、回退或安排新面试；已拒收的记录要先「恢复」才能继续推进。
- **删除不可恢复**：职位、候选人删除只对管理员开放，且职位下仍有投递时会拒绝删除。

## 技术选型与理由

| 层 | 选择 | 为什么 |
| --- | --- | --- |
| 运行 | Node 24+ 原生 TypeScript（类型擦除，无编译步骤） | 省掉一层构建，服务端代码可直接 `node server/src/index.ts` 运行 |
| 数据库 | `node:sqlite`（`DatabaseSync`） | 零原生依赖、单文件、可以直接拷走备份；招聘规模（万级投递）足够 |
| HTTP | Fastify 5 | 内置 schema 校验与 multipart/static/cookie 插件，启动快 |
| 前端 | Vite + React 19 + 手写 CSS | 视觉完全可控；token 化样式见 `web/src/styles/tokens.css` |
| 校验 | zod | 请求体校验集中、错误信息可读 |
| 测试 | `node:test` | 不需要额外测试框架，`npm test` 直接跑 |
| 解析 | `pdfjs-dist` + `mammoth` | 纯 JS 实现，不依赖系统库；不做 AI 也能覆盖常见简历 |

数据存放在 `server/data/hireloop.db`（SQLite，WAL 模式）与 `server/data/uploads/`（原始简历文件）。两个目录都在 `.gitignore` 里。

## 目录结构

```
server/
  src/
    app.ts            # Fastify 实例：插件、会话、错误处理、静态资源
    index.ts          # 启动入口
    auth.ts           # 注册/登录/会话/角色
    constants.ts      # 阶段、拒绝原因、各类枚举与文案（前后端共享口径）
    db/
      index.ts        # 连接、迁移（ensureColumn）、查询辅助
      schema.sql      # 表结构
      seed.ts         # 演示数据
    lib/              # id/时间/哈希/JSON 辅助、AppError
    routes/           # auth / jobs / candidates / applications / interviews / workspace / uploads
    services/         # 业务规则：jobs、candidates、applications、interviews、dashboard、notifications、audit、resume-parser
    integrations/
      feishu.ts       # 飞书接入位：配置、就绪度检查、卡片构建、发送（未配置时显式 skipped）
web/
  src/
    App.tsx           # 路由与登录门
    components/       # AppShell、ui 基件、icons、StageTrack（流动带）
    pages/            # Dashboard / Jobs / JobWorkspace / Analytics / Candidates / Interviews / Settings
    lib/              # api 客户端、格式化、手写路由
    styles/           # tokens.css（设计令牌）+ app.css
scripts/shot.mjs      # 无依赖 CDP 截图脚本
test-fixtures/        # 解析用样例简历
screenshots/          # 视觉回归截图
DESIGN.md             # 视觉契约：配色、字体、流动带签名、组件状态
```

## 数据模型

- `users` — 团队成员，含 `role`、`feishu_open_id` / `feishu_union_id`（为飞书登录预留）。
- `jobs` — 职位，含状态、编制、薪资、技能、负责人。
- `candidates` — 候选人主档，`parsed` 保存最近一次简历解析原始结果，`resume_file_id` 指向 `files`。
- `applications` — 投递（职位 × 候选人，唯一），保存阶段、归档状态和两轮综合评估。
- `application_events` — 投递时间线，涵盖创建、阶段变更、归档、恢复、入职与备注。
- `interviews` — 面试轮次、安排、逐字稿、总结与人工确认结果。
- `job_profiles`、`screening_reviews`、`offers` — 岗位画像版本、筛选结果、谈薪与 Offer 状态。
- `ai_runs` — AI 调用状态、用量和审计信息。

辅助表：`files`（上传的简历原件）、`sessions`（登录会话）、`notifications`（通知出站箱）、`integrations`（第三方集成配置）、`audit_log`（操作审计）。

新投递从 `screening` 开始，依次进入 `interview`、`offer` 和 `hired`。职位工作台按 Offer 状态把 `offer` 阶段拆成谈薪和待入职两个子模块。已归档投递可通过「恢复」重新流转。

## 飞书接入的预留方式

这一版不连飞书，但把接入点都留好了，接入时不需要改动业务代码：

1. **身份映射** — `users.feishu_open_id` / `users.feishu_union_id` 已建列；`integrations` 表存在 `feishu` 记录，`GET /api/settings/feishu` 会返回 `ready.login` 供登录方式切换判断。
2. **通知出站箱** — 阶段变更、面试安排会同时写入 `notifications`（`inapp` + `feishu` 两条，飞书那条默认 `pending`）。飞书未配置时保持 pending，接入后按原顺序幂等补发，不会丢消息也不会重复。
3. **消息卡片** — `server/src/integrations/feishu.ts` 的 `buildInterviewCard()` 已按飞书 interactive card 结构生成面试通知（含职位/轮次/时间/形式/面试官与跳转按钮），接上 webhook 即可发送。
4. **日历事件** — `interviews.external_calendar_event_id` 用于保存飞书日历事件 id，面试安排/改期/取消时同步更新。
5. **配置入口** — 设置页「飞书接入」可以直接填写 App ID / App Secret / Verification Token / 机器人 Webhook / 日历 ID，并实时显示三项能力（登录、通知、日历）的就绪状态与待发消息数。

发送函数在未配置或未实现时会**明确返回 `skipped`**，不会伪造成功状态。

## 验证方式

```bash
npm run check                                   # 类型检查
npm test                                        # 解析规则、接口流程与权限测试
node scripts/shot.mjs --job <jobId> --only board # 截图（需先 npm start）
npm run smoke                                   # 使用隔离数据的浏览器冒烟检查
npm run smoke:permissions                       # 浏览器权限冒烟（会新增一个测试成员）
npm run smoke:heading                           # 头部状态四态（自建隔离库与临时数据）
node scripts/measure.mjs --width 390 --width 768 --width 1440
```

`scripts/shot.mjs` 用 Chrome 的 CDP 协议截图，不依赖 Playwright：它会先调登录接口拿到会话，再按路由截整页，可加 `--width 390` 看移动端、`--dark` 看深色。

自动化检查覆盖账号与权限、简历解析及导入、画像版本、原文引用、人工推进、两轮面试和 Offer 流转。

浏览器冒烟还会覆盖本轮新增的就地操作：一次拖入两份简历逐份出结果且不跳页、抽屉里看筛选总结并推进、批量推进与批量归档、面试子模块内约面贴稿定去留、谈薪抽屉保存草稿直到入职，全程停在职位页。注意冒烟跑的是 `web/dist`，改完前端源码要先 `npm run build`。

## 协作开发

两人并行开发的分支模型、文件归属、冲突约定和发布节奏见 `docs/协作规范.md`。要点：`main` 只收 `dev` 的合并、功能分支从 `dev` 拉、CI 必须绿才合。

## 已知边界

- AI 筛选使用文件解析出的文字。扫描版 PDF 需要先识别文字，复杂双栏排版可能影响提取顺序。面试总结使用粘贴的逐字稿，不做音频解析。
- 批量导入逐份串行提交，一次十几份会持续几十秒；关闭页面会中断剩余文件，已成功的不回滚。
- 候选人详情页仍保留同一套面板，可从候选人库直接操作；职位页只是更顺手的入口。
- 单实例部署，SQLite 单写者；多团队并发量很大时需要换 Postgres 并把 `db/index.ts` 的查询层抽成仓储接口。
- 邮件通知只有出站箱记录，没有接 SMTP；候选人自助投递页尚未提供（当前由招聘方录入）。
- 权限到「角色」级别，没有做「只能看自己负责职位」的数据行级隔离；同期只有一套候选人库，团队共享可见。
- 飞书出站箱由团队共享。可以在设置页按发送状态和渠道筛选，搜索候选人、面试官或职位并翻阅完整历史。状态数量是全箱统计；管理员的批量补发和跳过不受筛选影响。
