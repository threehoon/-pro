# AI 优化交接清单

面向接手「AI 连接速度 + AI 生成内容质量」的同学。看完这一页就能独立开工，不需要先读完整仓库。

## 1. 先把环境跑起来

```bash
git clone https://github.com/threehoon/-pro.git
cd -- -pro            # 仓库名就叫 -pro，cd 需要 -- 才认
npm ci
npm run dev           # API 8787 + 前端 5173
```

配置模型：登录后在「设置 → 模型」填 base URL、模型名和 API Key（只存库，界面只显示尾 4 位）。也可以用环境变量 `LLM_API_KEY`（仅对官方 `api.deepseek.com` 生效）。

## 2. 数据隔离，别互相拷库

- 每人一份 `server/data/hireloop.db`，已在 `.gitignore`。**不要把别人的库拷过来**，配置与账号会串，表现为「配置明明保存了却显示未配置」。
- 端口错开：框架侧 8787 / 5173，你这边用 8791。
- 测试里不要触发真实外发（飞书）与真实计费调用。

## 3. 你的文件范围

| 文件 | 内容 |
| --- | --- |
| `server/src/services/ai/prompts.ts` | 提示词文案、统一约束 `POLICY`、`PROMPT_VERSIONS` |
| `server/src/services/recruitment-evidence.ts` | 模型输出的结构契约与硬校验（字段上限、`quote` 必须原文、禁用词、指标对齐） |

分工调整（2026-11-27，第二次收敛）：你的范围就是这两个文件——**AI 提示词优化**。之前给你的 `JobWorkspacePage.tsx`、`components/workflow/*`、`routes/recruitment-ai.ts`、`resume-parser.ts` 已交回框架侧：界面、接口形状、调度与预算是框架的活，避免你改提示词时被界面和接口牵扯。

**不要动**：`server/src/integrations/llm.ts`（传输与速度）、`server/src/services/recruitment-ai.ts`（队列、预算、缓存、成本）、`server/src/routes/recruitment-ai.ts`（接口形状）、`server/src/db/*` 的加列顺序、`web/src/**`。需要改就提 issue 或在 PR 里说，由框架侧改。

改提示词时注意：

- 版本号：改了文案或输出结构就把 `PROMPT_VERSIONS` 里对应项递增（如 `interview-summary-v2` → `v3`），这样 `ai_runs.prompt_version` 能把新旧结果分开对比，24h 缓存也会自然失效重算。
- 加字段要和 `recruitment-evidence.ts` 的 zod schema 同步改，否则模型多给的字段会被丢掉、少给的字段会直接判失败。
- `quote` 字段必须是原文逐字包含，否则 `validateSummary`/`validateScreening` 会丢弃该条证据——这是「不许编造」的底线，不要为了通过率放宽。
- 一个 PR 只动一层（要么改文案，要么改校验），别混着提。

## 4. 从哪读起

1. `server/src/services/recruitment-ai.ts` 的 `generate()`（约 190 行）：一次生成怎么发、怎么重试、怎么记 `ai_runs`。
2. `server/src/services/ai/prompts.ts`：五类提示词与版本号。
3. `server/src/integrations/llm.ts` 的 `requestJson()`（约 172 行）：真实的网络路径。
4. `docs/下一阶段开发文档.md` 第 4.0 节：统一约定（引用必须原文、禁用词、超时 45s、截断长度、24h 缓存）。

## 5. 干活前先量一次

```bash
npm run bench                      # 3~5 次最小请求，量连接开销
npm run bench -- --runs 10         # p95 更稳
npm run bench -- --job <jobId>     # 跑一次完整画像生成（耗 token，按需）
npm run bench -- --json            # 整段贴进 PR
```

连接复用已开启（2026-11-27）：同进程内后续请求不再重建 DNS + TCP + TLS。独立测量本机到 `api.deepseek.com` 的建连耗时从约 **110–240ms** 降到约 **82–88ms**，首个请求仍要建连。

端到端 ping 的耗时主要由模型这次输出了多长决定，单次 p50 波动很大（同样 5 次可能 700ms 也可能 1041ms）。所以比较时看**最小值、失败数、以及 `ai_runs` 里的 `duration_ms` 分布**，不要用一次 p50 下结论。

**任何优化 PR 都要贴改动前后的数字。** 没有数字的「感觉快多了」不进 dev。

## 6. 一次只改一层

- **改传输**（`llm.ts`）：keep-alive、DNS 缓存、连接复用等。只影响耗时。**框架侧负责。**
- **改提示词**（`prompts.ts`）：文案、结构、示例。影响质量与长度。
- **改校验**（`recruitment-evidence.ts`）：引用匹配的松紧。影响通过率。

混在一起提交，耗时和质量同时变，就说不清是谁的功劳，也没法回滚单层。**一个 PR 只动一层。**

## 7. 质量怎么算「变好了」

不要凭感觉。用 `ai_runs` 说话，尤其是 `prompt_version` 这一列（每次生成都会写下当次版本号）：

```sql
-- 各版本的表现
SELECT kind, prompt_version, COUNT(*) n, ROUND(AVG(duration_ms)) avg_ms,
       SUM(error IN ('malformed_json','truncated_response')) bad,
       ROUND(AVG(tokens_out)) avg_out
FROM ai_runs GROUP BY kind, prompt_version ORDER BY kind, prompt_version;

-- 最近的失败分布
SELECT kind, error, COUNT(*) n FROM ai_runs
WHERE error IS NOT NULL AND created_at >= datetime('now','-7 day')
GROUP BY kind, error ORDER BY n DESC;
```

三个可用指标：

1. **耗时**：各 kind 的 p50 / p95（`duration_ms`）。
2. **稳定性**：`malformed_json` + `truncated_response` + `empty_response` 的占比，目标 < 2%。
3. **质量**：画像生成后**没有被人工修改**就直接通过的比例——这是唯一不需要主观打分的质量信号。

改了一版提示词，就把 `PROMPT_VERSIONS` 里对应值加 1（如 `interview-summary-v2`），数据才会分到新版本上。

### 成本：钱花在输出上

真实库 50 次调用的实测均值（token）：

| 任务 | 输入 | 输出 | 说明 |
| --- | --- | --- | --- |
| `composite` 复合评价 | 5521 | **7489** | 输出最大，单价也最高 |
| `summary` 面试总结 | 4912 | **7940** | 输出最大，单价也最高 |
| `screening` 简历筛选 | 5875 | 3359 | 单人一次；批量导入会成倍放大 |
| `questions` 面试题 | 4052 | 2036 | 每轮面试一次 |
| `profile` 岗位画像 | 1702 | 2670 | 每个职位版本一次 |

按一个职位 + 一位候选人 + 一轮面试走完，约 **4.5 万 token**。输出占一半以上，而输出单价通常是输入的数倍——**省 token 优先省输出**，也就是少要字段、少要复述、少要枚举。

另一半浪费在失败重试上：历史上有 9 次画像生成失败（`invalid_profile_structure` 5 次、`invalid_response` 3 次、`malformed_json` 1 次），白花约 2 万 token。失败一次还会自动重试一次，等于双倍。**先把通过率做上去，比压长度更省钱。**

命中率怎么看（框架侧会在命中时写一条 `error='cache_hit'`、`status='skipped'` 的记录，不计费）：

```sql
SELECT kind,
       SUM(error = 'cache_hit') hits,
       SUM(status = 'ok') ok,
       SUM(status = 'failed') failed
FROM ai_runs WHERE created_at >= datetime('now','-7 day') GROUP BY kind;
```

`hits` 高说明重复点击被拦住了；`failed` 高说明提示词结构不稳。

## 8. 红线（改了就退回）

- `llm.ts` 里 `isPublicAddress` / `selectLlmAddress` 的判定强度不能为了跑通代理而放宽；
- `containsSecret` 对上游回显 key 的检查必须保留；
- `LlmFailure` 的错误码分类不能改语义，前端文案依赖它（`reasonMessages`）；
- API Key 不进代码、日志、`ai_runs`，只记尾 4 位；
- 提示词里不能出现性别、年龄、婚育、户籍等歧视条件。

## 9. 提 PR

```bash
git switch dev && git pull
git switch -c feat/ai-summary-tune
# 改完
npm run check && npm test
git commit -m "feat(ai): 面试总结压缩输入并收紧 max_tokens"
git push -u origin feat/ai-summary-tune
```

PR 目标填 `dev`，模板里「怎么验证的」必须包含：bench 前后数字、`ai_runs` 的失败率对比、以及你手动点过的页面。CI 绿了就可以合，我这边会看有没有碰红线。

## 10. 想知道谁该看哪块

`docs/协作规范.md` 有完整分工与冲突约定，PR 会自动按 `.github/CODEOWNERS` 指派评审人。
