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
| `server/src/services/ai/prompts.ts` | 提示词、统一约束、`PROMPT_VERSIONS` |
| `server/src/integrations/llm.ts` | 传输层：DNS、TLS、超时、错误码 |
| `server/src/services/recruitment-evidence.ts` | 输出校验与原文引用匹配 |
| `web/src/pages/JobWorkspacePage.tsx` | 生成状态的展示 |
| `web/src/components/workflow/*` | 画像、筛选、面试总结面板 |

**不要动**：`server/src/services/recruitment-ai.ts` 的队列与状态机、`server/src/db/*` 的加列顺序、`web/src/styles/*`。需要改就提 issue 或在 PR 里说，由框架侧改。

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

当前基线（deepseek-flash，3 次）：最小 786ms / p50 845ms / p95 1442ms，失败 0。

**任何优化 PR 都要贴改动前后的这两行数字。** 没有数字的「感觉快多了」不进 dev。

## 6. 一次只改一层

- **改传输**（`llm.ts`）：keep-alive、DNS 缓存、连接复用等。只影响耗时。
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
