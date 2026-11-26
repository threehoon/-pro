# Hireloop 评审与验收记录

> 目标：公司内部招聘工作台，覆盖职位与候选人管理、简历上传与基础解析、招聘流程看板、面试管理、工作台首页，并为飞书接入保留位置。
> 本轮验收日期：2026-11-25 · 运行目标：本地生产构建 `http://127.0.0.1:8787`（`NODE_ENV=production node server/src/index.ts`）

## 1. 设计上下文指纹

| 文件 | SHA-256（前 16 位） |
| --- | --- |
| `DESIGN.md` | `092eeaab86b5c41c` |
| `web/src/styles/tokens.css` | `8ea15d5de4e1397c` |
| `web/src/styles/app.css` | `d76b1b575351bc5b` |

表面类型：**operate**。主题：暖纸底 + 深青墨水，签名手法「流动带」（看板列头阶段色带 / 职位头部按人数成比例的阶段轨道 / 面试时间刻度轴）。

## 2. 实现版本

- 构建产物：`web/dist/assets/index-BcKp_FxP.js`（411.71 kB，gzip 126.25 kB）、`web/dist/assets/index-DslrMm0o.css`（73.66 kB，gzip 13.16 kB）
- 服务端：Node 原生 TypeScript 类型擦除 + `node:sqlite` + Fastify 5，无编译步骤
- 数据：`npm run db:reset && npm run seed` 后为 5 个职位 / 15 位候选人 / 15 条投递 / 6 场面试（含 3 场已完成的反馈）

## 2.1 本轮改动：候选人详情头部改为「当前状态区」

用户反馈：候选人已经投递了职位，详情头部仍无条件显示「＋ 投递职位」；已经安排过面试，头部还显示「安排面试」，看不出他现在在哪。

改动（纯前端，未动接口、库表与权限）：

- `web/src/pages/CandidatesPage.tsx` 优先显示在流程中且阶段最靠后的投递，同阶段取最近更新的一条。全部已拒绝时显示最近一条。「职位」旁显示岗位名和流程阶段，`+N` 统计其余所有投递，可跳到投递记录。有投递时提供次要入口「投递其他职位」，列表排除所有已投岗位和已关闭岗位。零投递时显示「投递职位」。
- 头部显示「已安排面试」和待进行场次的时间，可跳到面试记录。没有待进行面试时，只有存在未入职且在流程中的投递才显示「安排面试」。头部、卡片和排期弹窗共享同一份可排期投递列表。已有待进行面试时，可从面试记录卡片「再安排一轮」。
- `web/src/styles/app.css`：新增 `.status-chip` / `.status-chip-label` / `.status-chip-link` / `.status-chip-time` / `.status-chip-more`（中性描边、高 34、圆角 6，只用语义令牌，不加装饰色），`#applications`/`#interviews` 加 `scroll-margin-top`；`.profile-head` 允许换行、`.profile-title` 最小 240px，`.profile-actions` 右对齐且 `margin-left:auto`，<768 时恢复整行左对齐，避免状态 chip 变长后把姓名挤成竖排。
- `scripts/ui-smoke.mjs`：投递入口选择器兼容「投递职位 / 投递其他职位」，新增「详情头部显示已投递职位」「已安排面试时头部不再重复安排入口」「多条投递在头部显示 +N」三条断言。
- `scripts/shot.mjs`：新增 `--candidate <id>`、`--name <prefix>`，可对指定候选人与分支状态出图（默认行为不变）。
- `DESIGN.md`：组件清单补 `StatusChip`；`README.md`：候选人管理补一句头部状态说明。
- 顺带修正：`scripts/{shot,measure,permissions,ui-smoke}.mjs` 里管理员口令还是 `hireloop123`，而 seed 会把演示管理员改成 `123`，脚本因此登录 401；已统一为 `123`，否则所有浏览器脚本在演示库上直接失败。

## 3. 功能检查（自动，可重复执行）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（服务端 + 前端） | `npm run check` | 通过，exit 0 |
| 后端测试 | `npm test` | 62/62 通过（含候选人分组用例） |
| 生产构建 | `npm run build` | 通过（56 modules，387 ms） |
| 交互冒烟（真实浏览器） | `npm run smoke` | 80/80 通过，无控制台错误 |
| 权限冒烟（真实浏览器） | `npm run smoke:permissions` | 9/9 通过（第 17 节记录，本轮未改动权限路径） |
| 响应式溢出测量 | `node scripts/measure.mjs --width 390 --width 768 --width 1024 --width 1200 --width 1440` | 40/40 页面 `scrollWidth === clientWidth` |
| 头部状态流转（真实浏览器） | `npm run smoke:heading` | 11/11 通过 |

上表数字为本轮（第 19 节）实跑结果。本轮平台内置 `coding_check`（scope=changed 与 check=typecheck 两种调用）均返回 `Error: The coding operation could not be completed`（沿用第 16–18 节同一既有故障），因此上表不是平台自动验收证据，而是本地命令的 stdout 与 exit code；改动清单由 `git status`/`git diff`（工作区已在提交 `444758a` 之上）人工核对。

注意：`coding_inspect acceptance` 仍判 `ready: false`。工作区是 git 仓库（基线提交 `444758a`），本轮改动全部留在工作树、尚未提交，因此历史检查运行被标为 `fresh: false`（`git-revision-changed` / `source-incomplete`），四条准则全部 `missingChecks`。同时项目内为绕开 `~/.npm` 权限问题放了 `.npm-cache`（961 个文件 / 66 MB），检查器把它算进源码快照也会影响完整性。上表的 stdout 与 exit 0 是本轮真实执行结果，但按平台口径不能称「验收新鲜」，需要提交后再跑一次才会转为新鲜证据。

## 4. 交互流程实测（浏览器，非接口脚本）

1. 登录 → 工作台首页，KPI、漏斗、今日面试、职位进度、需要跟进、最近动作均渲染真实数据。
2. 职位页新建职位（表单必填校验、技能关键词、状态）→ 列表立即出现 → 搜索命中。
3. 候选人页投递候选人到职位 → 看板对应列计数 +1。
4. 看板鼠标拖拽与「移动」按钮两条路径都能换阶段，列计数从 `[0,0,0,0,0]` 变为 `[0,1,0,0,0]`；键盘可达性单独验证：打开移动弹窗后焦点进入弹窗（`BUTTON`），`Esc` 关闭且焦点回到触发按钮。
5. 拒绝需要选择原因；已拒绝的投递出现在看板下方横条，可一键恢复。
6. 面试页周视图（6 场）→ 记录面试结果需要评分与反馈 → 完成后状态与统计更新。
7. 候选人详情上传 DOCX 简历 → 解析面板显示姓名/邮箱/手机/城市/公司/职位/年限/学历/院校/技能与置信度，可下载原文件（服务端强制附件下载）。
8. 设置页飞书接入：未配置时显示 5 项准备清单与「待发消息」数量，保存配置后联动为「已配置」；发送在未接入时显式返回 `skipped`，不伪造成功。
9. 团队成员与权限：管理员可添加成员、改角色；普通成员看不到删除按钮、飞书表单与角色下拉，直接调接口返回 403。

## 4.1 解析器补强（本轮）

发现简历「教育背景」行里的专业（如「2014-2018　浙江大学　计算机科学与技术　本科」）此前识别不到，候选人的「专业」一直显示未识别。已补 `extractMajor`：先认「专业：」「主修：」等显式写法，否则在同一行里剔除时间段 / 院校 / 学历后取剩余片段，并新增两条用例（教育行拆专业、显式专业优先）。修复后 candidates 接口返回 `major: '软件工程'`，候选人详情不再出现「没识别到：专业」。

## 4.2 头部状态流转（本轮）

`npm run smoke:heading`（`scripts/heading-state.mjs`）在隔离库里新建候选人并走完整条状态链，断言的是真实渲染的 DOM：

1. 零投递：`.profile-actions` 内没有 `.status-chip`，按钮文案为「投递职位」。
2. 投递后：出现职位 chip（职位名 + 阶段 badge），出现 primary「安排面试」，投递入口降级为「投递其他职位」。
3. 安排面试后：出现「已安排面试 2026-11-25 17:00」chip，「安排面试」消失，面试记录卡片出现「再安排一轮」。
4. 在 390×844 视口分别点击面试状态和 `+N` 跳到对应卡片。两处计算出的 `scroll-margin-top` 均为 72px（顶栏 56 + 16），标题命中测试均返回 `H2`。
5. 取消该场面试后，面试状态消失，「安排面试」重新出现，卡片不重复提供同一个入口。
6. 打开「投递其他职位」，候选人已投岗位的 ID 不在可选项中。
7. 同一位候选人一条投递已入职、另一条仍在流程中时，排期弹窗只使用可安排的投递。提交后通过接口核对新面试已保存到正确的投递记录。

## 5. 截图与视觉核对

截图覆盖已入职、已拒绝、零投递及已排期等状态。已入职或全部投递已拒绝、且没有可排期投递时，头部不显示「安排面试」。已入职和已拒绝的截图采自上一版，当前版本统一使用「投递其他职位」作为有投递记录时的追加入口。

截图位于 `screenshots/`，均为整页、deviceScaleFactor 2。

| 页面 | 1440 | 1440 深色 | 390 |
| --- | --- | --- | --- |
| 工作台 `/` | `dashboard-1440.png` | `dashboard-1440-dark.png` | `dashboard-390.png` |
| 职位 `/jobs` | `jobs-1440.png` | — | `jobs-390.png` |
| 职位详情 `/jobs/:id` | `job-detail-1440.png` | — | — |
| 流程看板 `/jobs/:id/board` | `board-1440.png` | `board-1440-dark.png` | `board-390.png` |
| 候选人 `/candidates` | `candidates-1440.png` | — | `candidates-390.png` |
| 候选人详情 `/candidates/:id` | `candidate-detail-1440.png` | `candidate-detail-1440-dark.png` | `candidate-detail-390.png` |
| 面试 `/interviews` | `interviews-1440.png` | `interviews-1440-dark.png` | `interviews-390.png` |
| 设置 `/settings` | `settings-1440.png` | `settings-1440-dark.png` | — |

候选人多样的状态各截一张（1440）：`candidate-detail-hired-1440.png`（已入职）、`candidate-detail-rejected-1440.png`（已拒绝）、`candidate-detail-no-application-1440.png`（零投递，由 `smoke:heading` 生成）。本轮另测了 768 / 1024 / 1200 三个宽度（`candidate-detail-{768,1024,1200}.png`），确认状态 chip 变长后头部不会把姓名挤成竖排。

另外用独立的空数据库（`HIRELOOP_DATA_DIR` 指向临时目录）截了四张首屏空状态：`screenshots/empty/empty-{dashboard,jobs,candidates,interviews}-1440.png`，确认没有数据时页面仍然可读、有明确下一步（例如「还没有职位，先开一个」「还没有安排面试」）。

已核对要点：

- 「流动带」三处一致：看板列头 2px 阶段色带、职位卡/详情按人数成比例的阶段轨道、面试日程左侧竖线与刻度；无其它装饰性色块。
- 排版：数字使用等宽字距对齐，薪资、计数、时间不跳动；中文字体回退 PingFang SC → 系统字体。
- 深色模式：背景 `#0e1412`、面板 `#161d1a`，阶段色在深色下仍可区分，看板卡片与已拒绝横条对比度足够。
- 390 宽度：侧栏收起为抽屉（菜单按钮可用），KPI 两列、漏斗/职位进度单列，看板列可横向滚动但页面本身不溢出，候选人表保留「候选人 / 当前职位 / 流程」三列。
- 空状态与加载：看板空列「还没有候选人」、候选人面试记录空的紧凑空状态带「安排面试」入口、列表骨架屏、错误态带重试按钮。
- 焦点可见：全局 `:focus-visible` 外环使用品牌色；`prefers-reduced-motion` 下过渡时长归零。
- 本轮头部状态区：职位 chip 与面试 chip 都是 `--surface` + `--line` 的中性描边容器，没有新增装饰性色块；阶段色只出现在 `StageBadge` 里。chip 高 34、圆角 6 与既有按钮对齐，`.profile-actions` 右对齐（`margin-left:auto`）后与标题基线一致；1200/1440 下两个 chip + 「投递其他职位」一行放下，1024 及以下换行但仍右对齐，390 下职位 chip 与面试 chip 各占一行、职位名用 13ch 省略号截断（图标按钮与职位 chip 同行，略松散但不溢出，见 §6.1 的 L6）。深色下 chip 用 `--surface`/`--line` 自动切换，时间用 `tabular-nums` 对齐不跳动；`+N` 悬停变深并出现下划线。
- 锚点：`+N` 与面试 chip 分别跳到 `#applications` / `#interviews`，两处卡片用 `--topbar-h` 预留顶栏高度（实测 `scroll-margin-top: 72px`），落点标题不会被 sticky 顶栏盖住；chip 内的链接与整块可点击区域互不嵌套（嵌套 `<a>` 计数为 0）。

## 6. 独立评审

邀请独立评审者（只读）完成了一轮代码与接口评审，产出 16 条发现，其中 1 条 critical（简历文件可按上传者声明的 Content-Type 回放，存在存储型 XSS）、4 条 high（注册接口开放、成员可删除资源、可把最后一名管理员降级、已入职状态可被回退/拒绝）。以上 16 条已全部修复，并补了 10 个后端用例与两条浏览器冒烟路径覆盖。

**修复后的二次独立复评没有拿到结果**：先后尝试 4 次（两个角色、含只读审计员），子代理的运行均因模型限流/回合错误中断，没有产出报告。因此第 7 节的接口探测是**作者自测**，可以作为证据留档，但不等于独立结论。这一点在交付说明中也写明了。

## 6.1 本轮头部改动的独立评审（只读子代理）

独立评审者在隔离库和 Chrome 上复现了 3 条中等、6 条低风险发现。锚点和排期修复已加回归覆盖。当前版由另一位评审者只读复核，任务 `task-1` 已完成。复核范围包括投递计数、排期资格、岗位去重和手机端锚点断言，未发现阻塞性源码问题。该复核沿用本节的执行记录，复核者未单独执行浏览器检查或类型检查。

| 发现 | 现象（评审实测） | 处理 |
| --- | --- | --- |
| M1 锚点被 sticky 顶栏遮住 | 390 宽点 `+1` / 面试 chip 后卡片 `top=24`、`h2.top=45`，`elementFromPoint` 命中 `.topbar`（底 56），标题上半行压在毛玻璃栏下 | 新增 `--topbar-h: 56px` 令牌并让 `.topbar` 用它；`#applications/#interviews` 改为 `scroll-margin-top: calc(var(--topbar-h) + var(--sp-4))`（实测 72px），并断言 `margin ≥ 顶栏高 + 8` 且标题命中 `H2` |
| M2 排期弹窗默认选中已入职投递 | 候选人「hired + 另一条 active」时头部给「安排面试」，弹窗下拉包含已入职那条且默认选中，点「安排」立刻被后端 400「该候选人已入职，不再安排面试」 | 弹窗入参改用与头部相同的谓词 `status === "active" && stage !== "hired"`；新增断言「排期下拉只剩可安排的投递」+「直接提交不会被后端拒绝」（把修复临时回退后这两条确实变红：6/8） |

一并处理的 low：

- L1 `scripts/heading-state.mjs` 退出时先 `kill` 再立刻删 Chrome profile，会残留 `/tmp/hl-heading-profile-*`：改为等 `once(chrome, 'exit')`（上限 5s）后再删，并加 `maxRetries`；已清理历史残留。
- L2 `+N` 没有 hover 反馈、点击区只有文字：加 `a.status-chip-more:hover`（变深 + 下划线）与 `padding: 0 var(--sp-1)`；`aria-label` 补充可见的「+N」，满足 label-in-name。
- L3 面试 chip 的 `aria-label` 漏掉可见的「共 N 场」：拼进 `aria-label`。
- L4 头部「安排面试」与卡片「再安排一轮」在只剩已取消面试时同时出现：卡片入口条件从 `interviews.length > 0` 收紧为 `nextInterview && hasScheduleableApplication`，无待进行场次时只由头部提供入口（回归断言覆盖 `reround === false`）。
- L6 未改：390 下图标按钮与职位 chip 同行的排布略松散，但不溢出、不影响操作，留作后续微调。

评审**未验证**的部分沿用其原话：像素级视觉比对、暗色主题截图、Chrome 之外的浏览器、真实 Tab 序列、以及「全部投递已拒绝」分支（该分支仅代码阅读与 1440 截图核对）。本轮我自己补了暗色与 390/768/1024/1200 截图（见 §5）。

## 7. 未覆盖 / 已知边界

- 视觉回归靠截图人工核对，没有像素级 diff 基线；未做多浏览器对比（仅 Chrome）。
- 候选人详情已采集 768 / 1024 / 1200 截图。设置页与职位详情未采集 390 截图。
- 本轮独立评审见 §6.1。常规冒烟的面试状态断言依赖当前演示候选人，固定面试场景由隔离用例覆盖。超过预约时间但仍标为待进行的面试继续按记录状态显示。
- `coding_inspect acceptance` 因工作区指纹不完整而判 `ready:false`（见第 3 节说明），这是工具口径问题，不代表检查没跑。
- 未验证真实飞书租户联调：登录、消息发送、日历创建均为预留位，未接真实凭据。
- 简历解析为规则匹配（不调用模型）：扫描版 PDF（无文本层）与旧版 `.doc` 不支持，后者返回明确的 415 提示；复杂版式简历的字段可能漏识别，界面会显示「没识别到：…」。
- 无邮件发送（SMTP）、无 offer 生成与电子签、无多轮面试批量排期、无行级数据隔离（后续接飞书时随身份映射一起做）。
- SQLite 单实例：适合几十人团队，不适合多副本部署。
- 未做骨架屏之外的真实弱网模拟，未做压力测试。

## 8. v3.1 招聘流程复核

以上为上一版记录。本轮沿用暖纸底、深青色和看板阶段色带。设计上下文指纹为 `2425bb62f7e021d9f600b2c61657d1de22fc78f2cf6ecfa75a0c48890e77168f`。使用隔离测试库、Chrome 和生产构建 `index-DLK5IeeY.js` / `index-DdYOWRWf.css` 核对。

- 类型检查、生产构建和 32 项后端测试通过。独立复核了旧库重复启动迁移、跳过复试、登录与角色限制，以及用测试模型验证的 AI 证据与过期结果处理。
- `npm run flow -- --no-llm` 跑通两轮面试、谈薪、Offer 和入职。11 项候选人详情头部检查通过，覆盖切换另一条投递后将面试保存到正确记录、排期取消和手机端锚点。
- Chrome 24 项检查通过，覆盖新建职位、筛选推进、初试和复试、排期弹窗 Esc 关闭与焦点恢复、谈薪、Offer、本地入职记录、已入职与流程中人数分开计数、DOCX 解析和空模型设置。看板在 390、768、1440 px 验证页面无横向溢出，候选人详情和设置页也检查了 390 px。深色模式切换后刷新页面仍保留主题，减少动态效果时页面无入场动画。
- 截图见 [桌面看板](screenshots/recruitment-v31/board-1440.png)、[平板看板](screenshots/recruitment-v31/board-768.png)、[手机看板](screenshots/recruitment-v31/board-390.png)、[深色看板](screenshots/recruitment-v31/board-dark-1440.png)、[手机候选人详情](screenshots/recruitment-v31/candidate-hired-390.png)和[手机设置](screenshots/recruitment-v31/settings-390.png)。
- 等待配置真实 DeepSeek 后，用获准的候选人材料检查画像、筛选理由、两轮摘要和综合评估质量。当前浏览器证据来自 Chrome，AI 生成中的界面和错误重试尚未用真实模型走查。
- 工作区为普通目录，验证平台无法获取变更清单和完整源码指纹。检查命令有执行结果，平台仍显示 `ready:false`。

## 9. DeepSeek 设置页复核

在设计上下文 `e21461eb97036d53b5c969eed884340316efad142df9481a7364f39628608229` 下保留现有卡片和文本链接样式。前端构建为 `index-BcpV8ogB.js`，Chrome 使用隔离数据验证默认官方地址、模型 ID、版本、两个链接目的地和未配置状态。浏览器冒烟 27 项通过，390 px 与 1440 px 无横向溢出。两档截图均已核对，见[手机设置](screenshots/deepseek-settings/settings-390.png)和[桌面设置](screenshots/deepseek-settings/settings-1440.png)。真实模型连通性待使用实际密钥验证。

## 10. 岗位画像与简历筛选复核

沿用设计上下文 `e21461eb97036d53b5c969eed884340316efad142df9481a7364f39628608229`。2026-11-25 在隔离的本地生产服务上验证 `index-ZEnlehWO.js` 和 `index-BSb0lA_G.css`。

- Chrome 冒烟 38 项通过，覆盖键盘从职位详情进入待筛选列、空列表入口、筛选中自动刷新、候选人结果显示画像版本、返回对应画像，以及后续面试和 Offer 流转。390、768、1440 px 的三个页面均无横向溢出。截图见[手机职位详情](screenshots/screening-profile/job-screening-390.png)、[平板看板](screenshots/screening-profile/board-768.png)、[桌面简历筛选](screenshots/screening-profile/candidate-screening-1440.png)。
- 独立检查通过 36 项后端用例。覆盖新草稿保留当前已确认画像、确认新版后刷新评分、失败时隐藏旧结果、旧请求晚到及归档恢复。另一标签页已打开的看板在下次请求时获取变更，看板显示「正在筛选」时会自动刷新。
- 岗位画像曾在现有职位验证过真实 DeepSeek 输出。本轮筛选使用隔离样例，真实简历和面试逐字稿待提供。工作区指纹仍为 `source-incomplete`，平台无法给出正式验收结论。

## 11. 岗位简历直传复核

2026-11-25 在 Chrome 和临时数据库中验证职位详情、看板上传区与候选人筛选面板。设计上下文为 `e21461eb97036d53b5c969eed884340316efad142df9481a7364f39628608229`，生产构建为 `index-Cel0WDoF.js` 和 `index-2SPuJlu7.css`。

- 浏览器冒烟 47 项全部通过。覆盖未确认画像时的提示、拖放高亮、一次拖入多份文件的提示、空格键打开文件选择、导入后定位筛选结果、重复简历回到原记录以及人工归档。浏览器控制台无错误。
- 检查了 390、768、1440 px 下的上传区和看板、深色模式及减少动态效果。截图见[手机上传区](screenshots/resume-import/resume-import-390.png)、[平板上传区](screenshots/resume-import/resume-import-768.png)、[桌面上传区](screenshots/resume-import/resume-import-1440.png)和[深色看板](screenshots/resume-import/board-dark-1440.png)。
- 类型检查、生产构建和 37 项后端测试通过。独立复核也通过 37 项，覆盖按当前已确认画像筛选、重复导入、格式校验和人工决策。后端使用模拟模型核对引用与版本，浏览器使用隔离测试资料。真实简历和面试逐字稿的全流程联调仍待测试材料。

## 12. 工作台今日行动折叠

2026-11-25 使用隔离数据的 Chrome 复核工作台。设计上下文为 `e21461eb97036d53b5c969eed884340316efad142df9481a7364f39628608229`，验证构建为 `index-DhHerwo9.js` 和 `index-LgBpIp2B.css`。

- 浏览器冒烟 55 项通过，控制台无错误。实测默认收起、数量可见、空格展开、点击标题收起，以及展开后的原待办链接。另用隔离浏览器模拟待办加载、失败后重试和零项空状态。
- 检查了 390 和 1440 px 的布局、键盘焦点和深色模式下的状态反馈。截图见[桌面收起](screenshots/today-disclosure/today-collapsed-1440.png)、[手机收起](screenshots/today-disclosure/today-collapsed-390.png)及[手机展开](screenshots/today-disclosure/today-expanded-390.png)。
- 类型检查、生产构建与 37 项后端测试通过。当前工作区源码指纹为 `source-incomplete`，平台未生成正式验收结论。

## 13. 简历总结优先

2026-11-25 在隔离 Chrome 和测试数据库里验证候选人筛选。设计上下文为 `e21461eb97036d53b5c969eed884340316efad142df9481a7364f39628608229`，验证构建为 `index-D-EwDhon.js` 和 `index-B9kc1tXV.css`。

- 浏览器冒烟 61 项通过，控制台无错误。检查了 390、768、1440 px 的候选人筛选布局、总结生成中和生成完成后的状态、键盘展开岗位画像评分、原简历入口及人工推进初试。截图见[手机筛选](screenshots/resume-summary/candidate-screening-390.png)与[桌面筛选](screenshots/resume-summary/candidate-screening-1440.png)。
- 类型检查、生产构建、38 项后端测试和独立复验均通过。回归覆盖完整解析正文后段、职责限定语、歧义引句、联系信息与旧结果。测试使用合成简历和模拟模型响应。工作区源码指纹为 `source-incomplete`，平台暂无法确认正式验收。

## 14. 职位工作台六子模块

2026-11-25 在隔离 Chrome 和临时数据目录复核。设计上下文沿用 `e21461eb97036d53b5c969eed884340316efad142df9481a7364f39628608229`，验证构建为 `index-DLyfWWLH.js` 和 `index-9fQXy-4W.css`。

- 一级导航为工作台、职位、候选人、面试、设置五项；职位旧地址 `/jobs/:id` 与旧看板书签 `/jobs/:id/board` 会先显示内容再把地址换成 `/overview`、`/screening`，未知子模块地址落到概览，书签仍可用。
- 职位详情改为「概览 → 岗位画像 → 简历筛选 → 面试 → 谈薪 → 入职」六个带序号和人数徽章的子模块，右上只有「编辑职位」一个操作。概览只做导航：给出「下一步」建议、四个数字、今日待办、最近进入流程和招聘进度。
- 曾按方案加过一个「数据」页（漏斗、渠道、周期、AI 用量），但工作台首屏已经展示同一批数字，重复呈现反而增加负担，按用户要求整体移除：删除 `web/src/pages/AnalyticsPage.tsx`、`server/src/services/analytics.ts`、`GET /api/analytics`、对应类型与样式，以及它的浏览器断言与截图；旧地址 `/analytics` 现在回落到工作台首页。
- 浏览器冒烟 68 项通过，控制台无错误。覆盖五入口导航、六子模块切换、键盘 Enter 从概览进入简历筛选、旧书签跳转、未知子模块落点、筛选生成中自动刷新到结果、深色主题、减少动态效果。
- 检查了 390、768、1440 px 的概览、简历筛选与暗色筛选页，均无横向溢出。截图见[手机概览](screenshots/job-workspace/job-overview-390.png)、[桌面概览](screenshots/job-workspace/job-overview-1440.png)与[平板概览](screenshots/job-workspace/job-overview-768.png)。
- 类型检查、生产构建、38 项后端用例和标题冒烟 11 项通过；离线全流程脚本 5 步通过。
- 独立复核提出的两点已修：概览今日待办改为 `/api/workspace/today?jobId=` 在服务端先按职位过滤再取前五条（此前取全局五条再前端过滤，冷门职位会被截断成「今天没事」）；旧看板地址 `/jobs/:id/board` 首屏直接按「简历筛选」渲染，不再先闪一次概览。
- 已知边界：跨职位的候选人列表可新建/编辑候选人资料、面试总览可改期取消看总结；候选人详情是人员记录页，仍可就地推进与归档。流程推进以职位子模块为主，但确实存在两处可操作入口，后续若要彻底收敛需要把队列行动搬到子模块内。
- 独立复核（task-12，rev16）结论：三处入口在替换地址前已选对页面；两职位内存 SQLite 验证另一职位占满全局五条时本岗待办仍可见；旧 `BoardPage`/`JobDetailPage` 无残留引用。该轮回执 test `279e9377-b3e6-42e6-b97e-cb2998801bd6`（39/39）、typecheck `d5f8b4d3-c2b4-4718-b2c7-7699f43b0758`、build `e822c1e2-c495-420e-a3b7-d17397cbdc28` 对应移除数据页之前的源码。
- 工作区源码指纹仍为 `source-incomplete`，平台不生成正式验收结论。

## 15. 子模块就地操作与队列批量

2026-11-26 在隔离 Chrome 和临时数据目录验证。设计上下文沿用 `e21461eb97036d53b5c969eed884340316efad142df9481a7364f39628608229`，验证构建为 `index-CDpG7ram.js` 和 `index-Cdp_1_Rw.css`。

- 四个子模块从索引变成本地工作面：简历筛选与谈薪/入职用同一个行内抽屉复用候选人页的 `ScreeningPanel`、`OfferPanel`，面试直接打开 `InterviewDrawer`，页面里不再出现「去候选人记录完成」。工作台的抽屉、面试详情、排期、编辑职位共用一份弹窗状态，任何时刻只开一个，慢网下先发起、后返回的请求不会叠开第二个弹窗。
- 抽屉关闭按动作是否把人移出当前列判断：筛选在推进或归档后关；谈薪在 Offer 记录已发出后关（人转入待入职）；入职页在接受后仍留在原处，确认入职后才关；拒绝和归档都会关。行内动作先刷新外层数据再关闭。危险动作的二次确认沿用项目既有的全局确认框，它叠在抽屉之上并已处理焦点与 Esc，因此本页最多一层业务抽屉加既有确认框。
- 简历导入改为多份：一次可选或拖入多份，按顺序逐份提交，每份独立显示成功、重复或失败，重复简历给「打开已有记录」链接而不是整批报错；导入完成后不再自动跳转，候选人直接出现在当前筛选队列。
- 筛选队列支持搜索（姓名、当前职位、公司）、全选、批量推进初试和批量归档。批量归档统一取工具条里的原因；批量按 3 并发逐条调用既有的单条接口，不新增批量接口，个别失败逐条列出，已成功的不回滚。
- 面试子模块可以在本页约初试/复试、贴逐字稿、看 AI 总结、定去留；面试列表随页面刷新重新拉取，排期后立刻出现「贴逐字稿」入口。
- 顺手修掉两个问题：`InterviewsTab` 原先只在 `cards.length` 变化时拉取面试列表，排期后按钮不出现，改为跟随页面 `revision` 刷新；职位页描述里的「在流程中」人数改用 `Math.max(0, active - hired)`。
- 浏览器冒烟 71 项通过，控制台无错误。覆盖多份导入逐份结果并停留原页、键盘打开文件选择、重复简历定位原记录、抽屉里看总结并推进且推进后抽屉自动关闭、未选归档原因时批量归档不可点、选好原因后批量归档、面试子模块内两轮约面与定去留、谈薪抽屉保存草稿、发出 Offer 后转入待入职再确认入职，全程断言地址停在职位页。
- 检查了 390、768、1440 px 的导入区与筛选抽屉，均无横向溢出；深色主题与减少动态效果保持有效。截图见[手机筛选抽屉](screenshots/job-inline/candidate-screening-390.png)、[桌面筛选抽屉](screenshots/job-inline/candidate-screening-1440.png)、[桌面筛选队列](screenshots/job-inline/resume-import-1440.png)与[手机筛选队列](screenshots/job-inline/resume-import-390.png)。
- 类型检查、生产构建、38 项后端用例、标题冒烟 11 项与离线全流程 5 步通过。测试使用合成简历和模拟模型响应，未调用真实模型。
- 已知边界：批量导入是串行提交，十几份会持续几十秒；关闭页面会中断剩余文件，已成功的部分保留。批量只有「推进初试」和「归档」，没有跨阶段批量。候选人详情页仍保留同一套面板，从候选人库可直接操作。确认框与抽屉同时存在时 DOM 里会有两层 `role="dialog"`，这是既有确认系统的设计，键盘焦点与 Esc 已限定在最上层。面试列表首次读取完成前，排队人员的排期按钮显示「读取中」并禁用，避免把已约好的人误当未约。
- 补回删页面时丢掉的归档恢复入口：批量归档之后要能撤回。上一轮把独立看板页换成就地抽屉时，连同那里唯一的「恢复」按钮一起删掉了，确认框却还写着「仍可从看板恢复」。现在「已归档」折叠区每行在可写权限下有一个「恢复」按钮，调用既有的 `POST /api/applications/:id/reopen`，人回到原阶段并刷新队列；恢复中该行显示进行中、其余行禁用，失败在折叠区顶部逐行报错。确认框文案同时改成指向职位内的「已归档」。
- 加恢复入口后浏览器冒烟 74 项通过，控制台无错误。新增断言覆盖「已归档行提供恢复入口」「点恢复后先从已归档区移除、再回到待筛选队列，且仍停在筛选页」。这里踩过一个坑：待筛选队列和已归档列表都用 `.queue-row .queue-name` 渲染人名，第一版等待条件被已归档那一行自己满足了，导致断言提前通过；改用卡片作用域（只有待筛选卡片才有 `.queue-tools`）后才真正验证到刷新完成。
- 工作区源码指纹现为完整（项目已建 Git 仓库并有提交），平台仍不生成正式验收结论。

## 16. 岗位画像标准版升级

2026-11-26 在隔离 Chrome 和临时数据目录验证。设计上下文沿用 `e21461eb97036d53b5c969eed884340316efad142df9481a7364f39628608229`，基线提交 `91ab9f51e12062880b56ce8f422501d299044241`，验证构建为 `index-5zRy8sAR.js` 和 `index-CqXo0rFs.css`。

- 按岗位画像标准版升级数据结构、AI 生成提示词、无模型兜底规则与前端工作台展示/编辑体验：新增岗位档案元数据（部门归类代码 `XS/YF/CP/YY/SC/CW/RS/XZ/GL`、画像编码、能级 `L1–L6`、行业、工作地点）、核心岗位职责（最多 8 条）、职业特质匹配（八类特质 `A–H` 及主辅性格与适配理由）、门槛红线/黑线谨慎项（兼容既有 `not_wanted`）/加分项（各最多 8 条）、四指标灵活权重（合计 100%）与每指标 3–6 个岗位专属标签及 `E/D/C/B/A` 五档具体标准、合格判定口径速查（`<80` / `80–120` / `>120`）。
- 服务端读取职位完整字段（部门、地点、职级、工作方式、雇佣类型、薪资区间、描述、要求、技能）注入 AI 画像生成与兜底规则，不同岗位（研发/销售/财务/管理等）输出差异化四维权重、岗位标签与职业特质；仅标题建岗时仍严格保持硬性条件与红线为空、不编造，所有新增字段均走合规改写与脱敏校验。
- 持久层与编辑保存校验（`profileSchema`）兼容历史 1–2 个标签与无新增可选字段的旧版画像 JSON，同时 AI 生成校验（`generatedLabels`）保持 3–6 个标签标准版要求。
- 前端画像页升级为「档案概览 → 职责与职业特质 → 门槛/红线/谨慎项/加分项 → 四维权重占比条 → 五档能力矩阵（C 档达标列高亮）→ 判定口径速查」，支持完整在线编辑、权重整数钳制 `[0, 100]`、四维与维度内标签权重失配实时告警、特质切换自动切换默认理由及必填拦截。
- 浏览器冒烟 80/80 通过，控制台无错误。覆盖岗位画像只读各区块渲染、在线编辑行业并保存为第 2 版草稿再确认、以及 390/768/1440 px 浅色与 1440 px 深色主题零横向溢出。截图见[桌面画像](screenshots/portrait-review/job-profile-1440.png)、[深色桌面画像](screenshots/portrait-review/job-profile-dark-1440.png)、[平板画像](screenshots/portrait-review/job-profile-768.png)与[手机画像](screenshots/portrait-review/job-profile-390.png)。
- 独立复核（`reviewer`）初审指出 5 项缺陷（2 High：旧版 1–2 标签兼容及编辑器删除下限与后端不一致；2 Medium：部门归类选回未指定残留旧部门、权重非整数/维度内失配缺实时告警；1 Low：切换特质未替换旧默认理由且未拦截空理由），均已修复并经独立复查全部更新为 `resolved`；后端单测增至 42/42 全通过（含历史 2 标签画像读取 → 编辑保存 → 确认 → 下游筛选完整链路），`coding_inspect sweep` 为 0 项问题。
- 验证命令：`npm run check`（通过）、`npm run build`（通过）、`npm run test`（42/42 通过）、`HIRELOOP_SMOKE_SHOTS=screenshots/portrait-review npm run smoke`（80/80 通过）。注：本轮末期平台内置 `coding_check` 工具在工作区运行序号达到 1000 后返回工具错误 `Error: The coding operation could not be completed`，因此最终源码指纹的通过证据以本地命令输出与独立复核为准，平台自动验收状态暂为 `ready: false`（需在后续会话中重置或重跑 `coding_check`）。

## 17. 飞书阶段二扫码登录与身份映射（含阶段一评审加固）

2026-11-26 在隔离 Chrome 与临时数据库中验证。设计上下文沿用 `e21461eb97036d53b5c969eed884340316efad142df9481a7364f39628608229`，基线提交 `835249a3dde705add5f49c419b150e7da3c0c87c`，验证构建为 `index-Dii2cjtJ.js` 和 `index-DRsjmD7S.css`。

- **核心能力**：
  - 数据库启动迁移新增 `idx_users_feishu_open_id` 与 `idx_users_feishu_union_id` 两个局部唯一索引，防同一飞书身份重复绑给多个账号。
  - 后端实现飞书 OIDC 网页授权闭环（`GET /api/auth/feishu/start`、`GET /api/auth/feishu/callback`、`POST /api/auth/feishu/unbind`、`GET /api/bootstrap` 返回 `feishuLoginEnabled`），采用一次性随机 `state` + `HttpOnly; SameSite=Lax` Cookie + `timingSafeEqual` 防 CSRF/重放；调用官方 `app_access_token` → `oidc/access_token` → `user_info` 接口换取 `open_id` / `union_id` / 邮箱。
  - 扫码登录按 `open_id → union_id → 企业邮箱/邮箱` 匹配已有成员并签发既有 `hl_session`；未匹配成员按选项 A 拦截返回 `account_not_found`（不自动建号）；邮箱命中但已绑定其他飞书身份时拒绝覆盖（`email_bound_other`）。已登录成员可在设置页绑定/解绑本人飞书，管理员可解绑任意成员。
  - 一并修复阶段一评审问题与安全加固：`skipPendingFeishuNotifications` 避开在途投递且单条跳过幂等不覆盖失败原因；飞书外发请求强制 `redirect: 'error'`；Webhook 校验拒绝 query/hash；诊断脱敏遮蔽已保存密钥、`a-` 应用令牌与一次性 `code`；设置页支持清空已保存可选配置项并同步出站箱与状态卡计数；服务端统一通过 `resolveFeishuPublicOrigin` 生成 `callbackUrl` 并同步展示在设置页支持一键复制。
- **浏览器与视觉验证**：
  - `npm run smoke`（80/80 通过）与 `npm run smoke:permissions`（9/9 通过），控制台零错误。
  - 专项隔离 Chrome 验证覆盖登录页飞书扫码入口与 `account_not_found` 错误横幅、URL 参数清理、设置页回调地址展示与一键复制、清空已保存密钥并保存、成员列表飞书绑定徽章与绑定按钮；1440 / 768 / 390 px 及浅色/深色模式下均零横向溢出。截图见[桌面登录页](screenshots/feishu-stage2/stage2-login-1440.png)、[设置页飞书配置](screenshots/feishu-stage2/stage2-settings-feishu-1440-light.png)、[设置页团队绑定](screenshots/feishu-stage2/stage2-settings-team-1440-light.png)与[手机深色设置页](screenshots/feishu-stage2/stage2-settings-390-dark.png)。
- **独立复核与收口**：
  - 独立评审 `reviewer-stage2` 初审提出 1 High、3 Medium、4 Low 共 8 项问题（反代头默认信任与松散 Host 校验、回调先清 Cookie/删 state 再验 CSRF、`bindFeishuToUser` 换绑保留旧 `union_id`、`useState` 初始化调用 `replaceState` 在 `<StrictMode>` 下吞掉提示、邮箱匹配 `union_id=null` 守卫、设置页 `callbackUrl` 未同步 `HIRELOOP_PUBLIC_ORIGIN`、`a-` 令牌与 `code` 脱敏补齐、清空按钮无障碍属性及管理员解绑他人测试）。8 项已全部修复并补充完整回归测试，经 `reviewer-stage2` 独立复查全部批准并将 4 项登记的 `coding_review` 发现全部更新为 `resolved`。
- **验证命令与边界说明**：
  - `npm run check`（通过）、`npm run build`（通过）、`npm test`（52/52 通过）、`npm run smoke`（80/80 通过）、`npm run smoke:permissions`（9/9 通过）。
  - 真实飞书客户端扫码回调需在飞书开放平台「安全设置 → 重定向 URL」登记工作台设置页展示的回调地址后由用户实机触发验证。
  - 平台内置 `coding_check` 工具仍受该工作区既有故障影响返回 `Error: The coding operation could not be completed`，因此平台自动验收 `ready` 暂为 `false`，本轮交付以本地实跑命令、浏览器冒烟与独立评审通过作为完整证据。

## 18. 飞书阶段三：面试日历自动同步、自动生成会议链接与面试官私信（含独立评审修复）

2026-11-26 在隔离 Chrome 与临时数据库验证。基线提交 `e91cb79b161b93571fea86f5610a55a1df4d88a2`（阶段一+阶段二本地提交），验证构建为 `index-ExJ-b35F.js` 和 `index-Woku0cJR.css`，截图目录 `screenshots/stage3-verify/`。

- **交付范围**：
  - 数据库启动迁移沿用 `ensureColumn` 增量补列：`interviews.calendar_sync_status`（默认 `none`）、`calendar_sync_error`、`calendar_synced_at`、`calendar_attendees_json`（默认 `'[]'`），旧库平滑升级。
  - 飞书共享日历：设置页「一键创建招聘日历」（建完自动回填 `calendar_id`）与「测试日历连接」，均仅管理员可用（非管理员 403 并留审计）。
  - 面试日程同步：安排/改期/取消面试在事务提交后异步同步飞书日程（`PATCH` 失败回退 `POST` 重建），取消走删除；视频面试未手填 `meeting_url` 时开启飞书自动生成视频会议链接并回写 `interviews.meeting_url`；未手填时提示语明确「将自动生成飞书视频会议链接」。
  - 参与人：仅邀请已绑定 `feishu_open_id` 的面试官；改期换人时添加新面试官、移除旧面试官，已邀请名单持久化在 `calendar_attendees_json`，重试时据此补做移除。
  - 面试官私信：新增 `POST /open-apis/im/v1/messages?receive_id_type=open_id` 私信通道，与站内、群机器人三路并行入队；取消面试补齐站内与群机器人通知；出站箱徽标区分「面试官私信 · 姓名」与「群机器人」。
  - 手动重试：`POST /api/interviews/:interviewId/sync-calendar`，面试页日程徽标与抽屉同步条均可重试，失败原因直接可见。
- **失败处理边界**：未配置应用凭证/日历时不发任何飞书请求；同步失败绝不阻塞业务流转；删除日程失败保留 `external_calendar_event_id` 以便再次删除；初次同步即失败后又取消的面试回落 `none`，不会永久停在失败态。
- **取消语义**：删除飞书日程成功后状态回落 `none`（不再显示「已同步飞书日历」），并清空 `calendar_synced_at`；取消后同步条与会议链接一并隐藏。
- **独立评审与修复**：独立评审 `reviewer-stage3` 提出 4 Medium + 4 Low 共 8 项缺陷（初次同步失败后取消失去恢复路径、抽屉与列表选中态不跟随刷新、形式切换残留会议链接与 `COALESCE` 覆盖手填链接、单通道配置时出站箱批量按钮死锁、仅换面试官不通知、`.interview-sync-bar` 误用未定义 CSS 令牌、旧面试官移除不可重试且 `batch_delete` 失败被吞、`meeting_url` 未校验协议即渲染为链接）。8 项已全部修复：新增持久化参与人列与统一状态写回、模式切换清理互斥字段、非视频形式写 `vchat.vc_type='no_meeting'`、`sendablePending/sendableFailed` 驱动出站箱按钮、`safeMeetingUrl` 与后端 `meetingUrlSchema` 双向校验，并补新增回归用例覆盖上述行为。第二轮独立复核（`reviewer-stage3b`）确认 8 项均已修复，同时新提出 2 Medium + 3 Low（现场改视频后飞书远端残留旧地点、创建日程在途时取消会留下孤儿日程、删除成功后仍显示已同步、已有手填链接被误称「回填」、`workflow.css` 残留未定义 `--surface-2`），也已全部修复：同步成功后重读状态并在发现已取消时补一次删除、删除成功写 `none`、提示文案改为比较同步前后链接、令牌改回 `--surface-sunken`，并新增「创建在途时取消自动补删」竞态用例。第三轮复核又指出「发空 `location` 清空地点」不符合飞书契约（`location.name` 要求 1–512 字符，不传即不更新），且 `isCalendarEventNotFound` 把 `190002`（参数错误）、`191003`（日历已删除）、`191004`（日历类型不合法）都当成「日程不存在」，会让参数错误触发 `PATCH→POST` 重建、让删除失败被当作成功而清掉事件引用。第四轮复核对残留路径继续收口，最终实现为：
  - 「日程不存在」只认错误码 `193001`（event not found）；飞书 404 集合里的 `190007`（应用 bot 不存在）、`191000`（共享日历不存在）、`195100`（用户已退出/不在租户）都不代表事件已消失，一律保留事件引用并报错，不再触发重建或误判删除成功。远端返回 `193003`（event is deleted）时删除按幂等成功处理、更新改走新建，避免事件 ID 永久卡死；`191000/191001/191002/191003/191004` 这类日历级错误统一提示「日历不可用，请在设置页检查或重新创建招聘日历」，不让人误以为重试有用。
  - 飞书 `PATCH` 无「清空地点」语义，因此需要清掉远端旧会议室时改为「删旧建新」，重建请求不携带 `location`。触发条件有两类：现场改视频/电话；现场面试把地点清空（形式不变）。
  - 重建意图持久化在新增列 `interviews.calendar_recreate_required`（启动迁移补列，默认 `0`），因此「删除旧日程失败 → 状态 failed → 点重试」仍会先删再建，而不是只 `PATCH` 旧日程把旧会议室留在飞书上；重建成功（或远端已无事件）后自动清标记，后续普通改期只发 `PATCH`。
  - 创建/取消竞态的补删条件放宽：不再要求本次同步返回成功，只要行已取消且拿到事件 ID 就补删，覆盖「新建成功但添加面试官失败」导致孤儿日程的边界；手动重试与自动同步共用同一条补删链，因此「重试创建在途时取消」也不会留下已取消面试的日程。
  - 重建标记的清零条件收窄为「本次同步确实会把具体地点写进远端日程」（现场形式且有地点）：删除失败后用户再改时长/标题/时间不会把标记冲掉，重建意图一直保留到删旧建新真正完成为止；重新填回地点时只发 `PATCH`（带 `location`）并清标记，不再多删一次日程。
  - **已知残余风险（不做幂等键）**：删除旧日程成功后新建请求已到达飞书、但响应在网络上丢失时，本地拿不到新事件 ID，重试会再建一条，可能留下一条无引用的远端日程。彻底解决需要「先按摘要+时间查询再建」或幂等 token，本轮不引入；普通创建、改期共用同一 at-least-once 语义，出现概率低，且不影响本地数据一致性。
- **验证结果**：
  - `npm run check`（通过）、`npm run build`（通过，`index-ExJ-b35F.js` 410.10 kB / `index-Woku0cJR.css` 73.46 kB）、`npm run test`（61/61 通过；阶段三回归用例覆盖「现场改视频删旧建新」「现场清空地点删旧建新」「重建删除失败后重试仍删旧建新」「重建完成后改期不再删建」「现场编辑不丢重建意图」「手动重试在途取消自动补删」，错误码用例覆盖「`190002`/`191000`/`195100` 不触发重建」「`190007` 删除失败保留引用」「`193003` 删除幂等、更新走新建」「`193001` 删除按成功、更新只重建一次」「`191003` 在删除与更新路径都提示日历配置」「现场填回地点只 `PATCH` 且带 `location`」）、`npm run smoke`（80/80 通过，控制台零错误）、`node /tmp/verify-stage3.mjs`（ALL STAGE 3 BROWSER CHECKS PASSED，含抽屉同步条成功/失败两态与聚焦检查）。
  - 隔离 Chrome 专项验证（临时数据目录 + 真实飞书配置与排队通知）通过：设置页「一键创建招聘日历」「测试日历连接」按钮、日历就绪徽标、出站箱「私信 · 姓名 / 群机器人」徽标；面试页「已同步飞书日历」「日历同步失败」徽标、失败行的「重试同步日历」按钮可聚焦；面试抽屉同步条在同步成功时展示徽标 + 打开会议链接（`https://` 校验通过）+ 同步时间 + 重新同步按钮，失败时展示失败原因与可聚焦重试按钮。390/768/1440 px 与浅/深色主题均零横向溢出。截图见[面试抽屉同步条](screenshots/stage3-verify/interview-drawer-1440.png)、[面试日程](screenshots/stage3-verify/interviews-1440-light.png)、[深色面试日程](screenshots/stage3-verify/interviews-1440-dark.png)、[手机面试日程](screenshots/stage3-verify/interviews-390-light.png)、[设置页飞书配置](screenshots/stage3-verify/settings-feishu-1440-light.png)与[手机设置页](screenshots/stage3-verify/settings-390-light.png)。
  - 真实飞书租户的日历写入与私信投递需用户在自己租户内实机触发确认（本轮以测试桩与本地模拟响应验证契约）。
  - **测试有效性（变异验证）**：把 `server/src/services/interviews.ts:533` 的 `canClearRecreateFlag` 临时改为 `false` 后，`npm run test` 变为 60/61、失败用例正是「清空地点后重建失败，现场编辑不丢重建意图，重试仍删旧建新」；还原后复跑 61/61。证明该用例能真正证伪错误实现，而不是依赖既有状态假通过。
  - **终审结论**：独立评审 `reviewer-stage3d` 先后指出 R1（响应丢失重复建）与 T1/T2/T3（测试缺口），本轮补齐 193001 正例、现场填回地点清标记用例、时长编辑失败态与无新建断言，并明确记录 R1 为残余风险；其最终结论为「F1–F4、T1、T2、T3 均已闭环，唯一保留的是已记录的 R1 残余，可以交付」。
  - 平台内置 `coding_check` 在本工作区仍返回 `Error: The coding operation could not be completed`（沿用第 16、17 节记录的既有故障），因此自动验收 `ready` 仍为 `false`，本轮交付证据以本地实跑命令、变异验证、隔离浏览器验证与独立评审为准。

## 19. 候选人按流程阶段分类（含独立评审修复）

2026-11-27 在 `http://127.0.0.1:8790`（`PORT=8790 npm start`，生产构建 `index-C6b_IcNF.js` / `index-DslrMm0o.css`）与隔离 Chrome（`--headless`，DPR 2/3）验证。基线提交 `444758a`。用户反馈：候选人全挤在一张平铺表里，没有分类，每次都得一行行找。

- **交付范围**：
  - 服务端 `GET /api/candidates` 增加 `group` 参数与 `groupCounts`：分类口径 = 候选人「在流程中最靠后的那条投递」，与服务端 `FURTHEST_STAGE_ORDER` 和前端 `workflowStage()` 对齐，七类为 `screening`（待筛选，含 `new`）、`interview`、`negotiation`（offer 但 `negotiating`）、`pending`（offer 且 `sent`/`accepted`）、`hired`、`rejected`（无在流程投递但有被拒记录）、`none`（从未投递）。
  - `groupCounts` 按当前 `q`/`skill`/`tag` 统计，因此分类人数始终等于叠加筛选后的真实条数；`pages` 与 `total` 只统计所选分类，`group` 与 `q`/`skill` 可叠加；未知 `group` 退化为「全部」而不是报 400。
  - 前端 `web/src/pages/CandidatesPage.tsx` 在搜索行上方加入分类 Tabs（全部 + 七类，各带人数），分类栏在有数据、已选分类或有关键词/技能筛选时保留，避免零命中时分类入口消失。
  - 行内「流程」徽标改由 `candidateStageBadge()` 走同一个 `workflowStage({ stage, offer_status })`，修掉了此前「已发 offer 但未答复」显示成「谈薪」的不一致；列表主投递排序与服务端一致补 `id` 兜底。
  - 共享 `web/src/components/ui.tsx` 的 `Tabs` 升级为 roving tabindex + 左右/Home/End 键，并支持 `label` 传入 `aria-label`；上下方向键不接管，留给页面滚动。职位页、面试页共用这一组件。
  - `web/src/styles/app.css`：`.group-tabs .tabs { max-width: 100%; flex-wrap: wrap }`，任何宽度下分类不会被横向滚动藏起来；<700px 时 tab 等宽铺满、自然换行成两行。
- **已知边界**：`FURTHEST_STAGE_ORDER` 在同权重同 `updated_at` 时按 `a.id DESC` 兜底，保证 `furthest_stage` 与 `furthest_offer_status` 取自同一条投递；`applications` 目前只有 `(candidate_id)` 与 `(job_id, stage, updated_at)` 索引，候选人量级上万时可评估加 `(candidate_id, status, stage, updated_at)` 覆盖索引。
- **独立评审与修复**：独立评审 `reviewer2`（只读 `git diff`）初判「暂不建议交付」，提出 3 Medium + 4 Low，已全部修复：
  1. Medium 搜索防抖窗口内旧响应仍会落地（改关键词后 220ms 内新请求还没发，旧 `seq` 仍匹配）→ `useEffect` 里条件一变先 `requestSeq.current += 1` 作废在途请求。
  2. Medium 共享 `Tabs` 新增的键盘自动激活会放大职位页的请求乱序 → `JobsPage` 补 `requestSeq` 守卫（success/error/finally 三处早退）。
  3. Medium 分组用例「总量 = 七组之和」是同一份推导自证，抓不住 offer/hired 分支写错 → 重写用例（见下）。
  4. Low 搜索零命中时分类栏消失、空态却说「换个分类」→ 渲染条件补 `query.trim() || skill`，空态描述按关键词/分类分别给文案。
  5. Low `Tabs` 缺分组名称、抢了上下方向键 → 加 `aria-label`，只处理左右/Home/End。
  6. Low >700px 但容器变窄时仍靠横向滚动隐藏分类 → 改为始终换行。
  7. Low 列表与详情的主投递排序在「同秒两条 offer」时可能不一致 → 前端 `pickPrimaryApplication` 补 `id` 兜底。
- **测试有效性**：`server/test/api.test.ts` 的 `候选人按流程阶段分组，计数与筛选结果一致` 用真实接口与 SQL 造 8 位候选人，覆盖七个分类全部可达（待入职刻意造 `sent` 与 `accepted` 两条），断言 `groupCounts.all` 等于 `SELECT COUNT(*) FROM candidates` 的独立口径、每组等于「基线 + 增量」、每组包含本组样本且**不包含其他组样本**、待入职只含 `sent/accepted`、谈薪只含 `negotiating`、`group=pending&pageSize=1` 的 `pages === total` 且翻页取到不同记录、`group=none&q=…&skill=Go` 三者叠加命中 1 条、`group=bogus` 退化。**变异验证**：把 `server/src/services/candidates.ts:83` 的 `IN ('sent', 'accepted')` 临时改成 `IN ('accepted')`，该用例立即失败（`AssertionError`），还原后复跑 62/62 通过。
- **验证结果**：
  - `npm run check`（通过）、`npm run build`（通过，`index-C6b_IcNF.js` 411.56 kB / `index-DslrMm0o.css` 73.66 kB）、`npm test`（62/62 通过）、`npm run smoke`（80/80 通过，LOG 无控制台错误；首跑曾出现 79/80 且未定位到具体断言，随后连续三次 80/80）。
  - 浏览器专项（`node /tmp/verify2.mjs http://127.0.0.1:8790`，0 项失败）：接口计数 `{"all":17,"screening":3,"interview":8,"negotiation":3,"pending":0,"hired":2,"rejected":1,"none":0}`；1440/1024/800 三档分类栏单行、8 个分类零隐藏、零横向滚动、`aria-label` 生效、「全部」计数与接口一致；390px 换行成 2 行、8 个分类全部可见；点「待筛选」后列表说明「「待筛选」3 位」且 3 行徽标全为本阶段，点「未投递」显示该分类空态，点「全部」恢复 17 行；键盘 ArrowRight 切到下一分类且焦点跟随、`roving tabindex` 只有 1 个、ArrowDown 不改变分类、End/Home 跳到末/首分类；搜索零命中时分类栏仍在（8 个）、表格为空、空态为「没有匹配的候选人」；职位页 ArrowRight 切换标签正常无报错；`console errors: none`。
  - 截图：[1440 浅色](screenshots/candidates-fixed-1440.png)、[1024](screenshots/candidates-fixed-1024.png)、[800](screenshots/candidates-fixed-800.png)、[390 两行](screenshots/candidates-fixed-390.png)、[待筛选](screenshots/candidates-fixed-screening-1440.png)、[未投递空态](screenshots/candidates-fixed-none-1440.png)、[全部](screenshots/candidates-fixed-all-1440.png)、[键盘切换](screenshots/candidates-fixed-keyboard-1440.png)、[零命中](screenshots/candidates-fixed-nohit-1440.png)、[深色](screenshots/candidates-1440-dark.png)。
  - 平台内置 `coding_check` 在本工作区仍返回 `Error: The coding operation could not be completed`（沿用第 16–18 节既有故障），自动验收 `ready` 仍为 `false`；本轮交付证据为本地实跑命令、变异验证、隔离浏览器专项与独立评审。

### 19.1 第二轮评审修复（2026-11-27）

`reviewer2` 对第一轮修复做只读复核，判「不建议交付」，提出 5 项。逐条处理如下：

| # | 问题 | 处理 | 证据 |
|---|------|------|------|
| 1 | 改关键词后 220ms 防抖窗口内仍显示旧关键词的列表与人数，还能对旧结果翻页 | `CandidatesPage.tsx` 调度 effect 条件一变就 `setLoading(true)`，只把「发请求」延后 220ms；表格与 `.pagination` 只在 `!loading` 时渲染 | 浏览器实测：输入「林」后 120ms 采样 `rows=0`、`pagination=false`、`skeleton=true`；700ms 后只剩「林晨」、`筛出 1 位` |
| 2 | 删除职位完成后调用的 `load()` 捕获了点击时的旧分类，会覆盖当前 Tab 的正确结果 | `JobsPage.tsx` 引入 `reloadKey`，调度 effect 依赖 `[load, query, reloadKey]`；删除与保存完成只 `setReloadKey(v => v + 1)`，刷新必定走「最新筛选」那次调度 | 竞态脚本（`Network.emulateNetworkConditions` latency 1200ms）：在「在招」点删除 → 250ms 内切「已暂停」→ 6s 后 `active=已暂停`、`cards=0`。**反向验证**：把 `setReloadKey` 换回 `load()` 重新构建后同一脚本失败（`active=已暂停` 但渲染 8 张「在招」卡片），改回后 PASS |
| 3 | 测试缺口：待筛选样本被接口写成 `screening`（`new` 未测）、`q` 唯一命中使 `skill` 可被忽略、每人只有一条投递 | 见下「测试有效性补强」 | 三次变异验证均失败（`new` 映射、`skill` 筛选、阶段优先级反向），还原后 62/62 |
| 4 | 纯空格关键词时空态/「添加候选人」按钮与接口口径不一致 | 统一改用 `query.trim()` 判断有无关键词（清空按钮、`list-note`、空态 title/description、空态内按钮） | 实测输入三个空格：17 行、`共 17 位候选人`、不出现「没有匹配的候选人」 |
| 5 | 职位页/面试页 `Tabs` 无 `aria-label`；三页均未关联 `aria-controls`/`tabpanel` | 两页补 `label`（`按职位状态筛选` / `按面试状态筛选`）；`aria-controls`/`tabpanel` **本轮未做**，见「未覆盖」 | 实测三个 `tablist` 的 `aria-label` 均正确 |

- **测试有效性补强**（`server/test/api.test.ts`）：`apply()` 支持指定职位；待筛选样本显式 `UPDATE applications SET stage = 'new'` 并断言 `stage === 'new'`；新增第二位未投递样本（技能 Python），`group=none&q=…` 期望 2 条、`groupCounts.none/all` 都是 2，再加 `&skill=Go` 期望 1 条且 `groupCounts` 收敛到 1；新增多投递用例（把已入职候选人再投一个职位），断言 `groupCounts.hired/screening` 不变、hired 分类仍包含他且 screening 不含。
- **变异验证（三次，均先备份后还原）**：`IN ('new', 'screening')` → `IN ('screening')` 失败；`if (options.skill)` → `if (false && options.skill)` 失败；`CASE … END DESC` → `END ASC` 失败。每次失败后还原，最终 `npm test` 62/62。
- **复跑结果**：`npm run check` 通过、`npm test` 62/62、`npm run build` 通过（`index-BcKp_FxP.js` 411.71 kB / `index-DslrMm0o.css` 73.66 kB）、`npm run smoke` 80/80（LOG 无控制台错误）、浏览器专项 `node /tmp/verify3.mjs http://127.0.0.1:8790` 与 `node /tmp/verify-race.mjs http://127.0.0.1:8790` 均 0 项失败。截图新增 [防抖中](screenshots/candidates-fixed-debounce-1440.png)、[纯空格关键词](screenshots/candidates-fixed-spaces-1440.png)、[删除后列表](screenshots/jobs-after-delete-1440.png)。

### 19.1.1 第三轮评审修复：候选人保存后的刷新也改用当前筛选（阻塞项）

`reviewer2` 第三次复核判「不建议交付」，指出与职位页同源的缺陷：在「待筛选」打开「添加候选人」，提交后趁请求未完成点「取消」再切到「已入职」，保存成功时 `CandidateFormModal` 里异步续体持有的 `onSaved` 仍会调用打开弹窗那次渲染的 `load()`（闭包里的 `group` 是「待筛选」），它拿到最新请求序号，于是「已入职」选中的状态下渲染出「待筛选」的列表，直到用户再切一次条件。

- 修复：`CandidatesPage.tsx` 同样引入 `reloadKey`，调度 effect 依赖 `[load, query, reloadKey]`；`CandidateFormModal` 的 `onSaved` 改为 `setCreating(false)` + `setReloadKey(v => v + 1)`，刷新一律由调度 effect 用当前 `query/skill/group/page` 发起。至此列表页里不再有任何直接调用 `load()` 的写操作路径（`ErrorState` 的重试按钮除外，它同步触发，不存在跨渲染闭包）。
- 实测（`/tmp/verify-save-race.mjs`，`Network.emulateNetworkConditions` latency 1200ms）：切「待筛选」→ 添加候选人 → 点「添加」→ 250ms 内点「取消」→ 切「已入职」→ 7s 后 `active=已入职2`、2 行徽标全为「已入职」。
- **反向验证**：把 `onSaved` 换回 `load()` 并去掉 `reloadKey` 重新构建后，同一脚本失败：`active=已入职` 但渲染 3 行「待筛选」。改回修复版后重新构建，三个浏览器脚本（`verify3`、`verify-race`、`verify-save-race`）全部 0 项失败。

### 19.2 上轮遗留事项

- 三页标签与结果区的关联、候选人加载和失败时的旧人数，以及职位删除期间切换分类的自动化回归，已在[第 20 节](#20-分类结果区可访问性和人数更新)补齐。
- 候选人详情页（`CandidateDetailPage`）按 id 刷新，不涉及列表筛选。
- `applications` 的覆盖索引属于候选人量级上万时的独立性能评估。

## 20. 分类结果区可访问性和人数更新

目标页面为 `/candidates`、`/jobs`、`/interviews`。基线提交 `444758a`，验证的是其上本轮工作树的构建产物 `index-DwwKe_Pc.js` 与 `index-fZgjvUuY.css`。沿用 Hireloop 的颜色、排版与筛选组件。设计契约指纹为 `90d6a10e18e8aba9b4b4f50a75a301dd9a68be688811d16a8e902997460def11`，本轮样式 SHA-256 为 `2f78d53cce99255b1e6d2e34060cfe36eb2a2011c3678265fe5f0ecdabb2fdd2`。

- 三页各分类标签的 `aria-controls` 对应稳定的结果面板，面板用 `aria-labelledby` 引用原标签。只有选中的面板可见并进入 Tab 顺序。方向键同步移动焦点，Tab 键可以进入结果区。
- 候选人分类、关键词、技能、页码变化以及添加后刷新时，立即撤下旧结果、旧人数和分页。加载期间提示「正在加载…」。失败后保留分类入口和重试按钮，成功返回空结果时显示 `0`。在途旧响应不得覆盖当前结果。
- 独立源码复核提出两处问题。重试和翻页会丢失焦点，面板包装会改变结果块的间距。修复后复核通过。重试和翻页前先把焦点移到当前面板，并恢复面板内部间距。
- `npm run build` 通过，构建中包含前后端类型检查。`npm test` 通过 62/62。隔离 Chrome 通过 96/96 项冒烟断言，无控制台错误。回归覆盖三页的标签与结果区、候选人 503 后键盘重试、加载和空结果、迟到响应、键盘翻页，以及职位删除完成后刷新当前分类。
- 目视检查了候选人页的 390 px 和 1440 px 浅色布局以及 1440 px 深色布局。窄屏分类完整显示，浅色截图可见进入结果区的键盘焦点环。减少动态效果由浏览器断言验证。屏幕阅读器实机未测。[手机浅色](screenshots/candidate-tabs-followup/candidate-groups-390.png)、[桌面浅色](screenshots/candidate-tabs-followup/candidate-groups-1440.png)、[桌面深色](screenshots/candidate-tabs-followup/candidate-groups-dark-1440.png)。
- `coding_check` 仍返回 `Error: The coding operation could not be completed`，平台验收修订 26 缺少当前运行回执。工作树扫描的四条相似代码提醒对应候选人页的导入列表和共享面板的参数列表，人工核对没有重复逻辑。

## 21. 候选人按投递职位筛选

候选人页的「全部技能」已换成「全部职位」。选择职位后，列表、流程阶段与人数都以该职位的投递记录为准。关键词、流程阶段与职位可以叠加使用。「清空筛选」恢复全部候选人。职位选项包含暂停和关闭的职位，便于查询历史投递。

- 目标页面为 `/candidates`。设计上下文指纹为 `94c83d0d49d9b0b09abb287dfcdb378798bd99b2d7018408bb66ed0b5f87b9b8`。基于 `444758a` 工作树构建了 `index-2v_yWQCe.js` 和 `index-CeYIZ4GV.css`，样式 SHA-256 为 `3e8635ef3e1b18ef28d851bae49f0213f99d3f04309fd65a96b5c177b9001f60`。
- `npm run build` 和前后端类型检查通过。`npm test` 通过 65/65。接口回归覆盖多职位投递的状态隔离、历史拒绝、叠加搜索、分页和空职位。
- 隔离 Chrome 冒烟检查通过 104/104，控制台无错误。实测选项加载失败和重试、无投递空态、真实投递后的职位及流程筛选、与关键词叠加、清空筛选及键盘焦点。独立源码复核确认「重试」与「清空筛选」激活后焦点移回搜索框。
- 目视检查了 390 px 和 1440 px 浅色界面以及 1440 px 深色界面。浏览器验证了窄屏布局与减少动态效果。屏幕阅读器实机未测。[手机组合筛选](screenshots/candidate-job-filter/candidate-job-filter-390.png) · [桌面组合筛选](screenshots/candidate-job-filter/candidate-job-filter-1440.png) · [桌面深色](screenshots/candidate-job-filter/candidate-groups-dark-1440.png)。
- `coding_check` 返回 `Error: The coding operation could not be completed`。平台验收修订 27 缺少当前运行回执，命令行验证结果见上。
