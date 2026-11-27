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

1. `server/src/services/ai/prompts.ts`：`POLICY`（所有任务共用、要求「只返回指定 JSON」）、五类 instruction（画像 / 筛选 / 面试总结 / 面试题 / 综合评估）、`PROMPT_VERSIONS`。
2. `server/src/services/recruitment-evidence.ts`：模型输出的 zod schema 与硬校验（`validateSummary`、`quoteExists`、禁用词、指标对齐）——提示词要求什么，这里就必须收得下；这里放开或收紧，直接决定模型输出能不能被采纳。
3. `docs/下一阶段开发文档.md` 第 4.0 节：统一约定（引用必须原文、禁用词、超时 45s、截断长度、24h 缓存）。
4. 只读参考：`server/src/services/recruitment-ai.ts` 的 `generate()` 负责把 `POLICY + instruction` 拼成一次请求、下发输出预算与超时、失败重试、写 `ai_runs`。**这层归框架侧，你只读不改。**

## 5. 干活前先量一次

改提示词不是改文案，是改结果分布，所以先取基线再动手：

```sql
-- 各任务最近的耗时与 token 分布（看输出长度，不看输入）
SELECT kind, prompt_version, COUNT(*) n, ROUND(AVG(tokens_in)) tin, ROUND(AVG(tokens_out)) tout,
       ROUND(AVG(duration_ms)) ms, SUM(status = 'failed') failed
FROM ai_runs WHERE created_at > datetime('now', '-14 days') GROUP BY kind, prompt_version;

-- 某一份面试的总结版本对比
SELECT prompt_version, status, error, tokens_out, duration_ms, created_at
FROM ai_runs WHERE kind = 'summary' AND subject_id = ? ORDER BY created_at DESC;

-- 缓存命中（命中不计费，新增版本后应看到重新计算）
SELECT DATE(created_at) day, SUM(COALESCE(error,'') = 'cache_hit') hits FROM ai_runs GROUP BY day;
```

对比时固定同一份输入（同一个面试转写 / 同一份简历），只换提示词版本，把 `PROMPT_VERSIONS` 递增后各跑一次，用 `ai_runs` 里的 `tokens_out` 与 `duration_ms` 说话。

`npm run bench`（`--runs`、`--job`、`--json`）量的是传输与连接开销，用来验证框架侧的改动，**不要**拿它当提示词质量的证据。

**任何提示词 PR 都要贴改动前后的 `ai_runs` 数字，以及 3~5 份样本的人工质量对照。** 没有数字的「感觉更准了」不进 dev。

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
