import { all, run, transaction } from '../db/index.ts';
import { now, toJson } from '../lib/util.ts';
import { audit } from './audit.ts';
import { storedBitableConfig, deleteBitableRecords } from '../integrations/bitable.ts';
import { queueEntity, flushBitableQueue, tableFor } from './bitable-sync.ts';

/**
 * 演示/联调数据：一次性往库里灌一批「看起来像真招聘」的投递与面试，再把它们推到多维表格，
 * 用来直观看到同步效果。所有行都用 `seed_` 前缀，清理时按前缀删除，不会碰到真实数据。
 */
const DEMO_PREFIX = 'seed_';
const JOB_ID = `${DEMO_PREFIX}job_1`;

const CANDIDATES: Array<{
  name: string;
  title: string;
  company: string;
  years: number;
  skills: string[];
  source: string;
  note: string;
}> = [
  { name: '林一舟', title: '高级后端工程师', company: '某电商平台', years: 7, skills: ['Go', 'MySQL', 'Kafka'], source: '内推', note: '系统设计扎实，沟通偏谨慎。' },
  { name: '周心怡', title: '数据产品经理', company: '某出行公司', years: 5, skills: ['指标体系', 'SQL', 'A/B'], source: '猎头', note: '对业务指标拆解很清楚。' },
  { name: '许嘉言', title: '前端工程师', company: '某 SaaS 创业公司', years: 4, skills: ['TypeScript', 'React', '工程化'], source: '官网投递', note: '工程化经验比预期强。' },
  { name: '钱亦宁', title: 'HRBP', company: '某制造集团', years: 6, skills: ['组织发展', '招聘', '员工关系'], source: 'Boss 直聘', note: '对制造业用工场景很熟。' },
  { name: '沈知白', title: '产品负责人', company: '某教育科技', years: 9, skills: ['产品规划', '增长', '团队管理'], source: '内推', note: '带过 10 人团队，节奏偏快。' },
  { name: '唐婉清', title: '招聘专员', company: '某互联网医疗', years: 3, skills: ['技术招聘', '面试组织'], source: '内推', note: '执行细致，量还不错。' },
  { name: '苏行舟', title: '测试开发工程师', company: '某金融科技', years: 5, skills: ['自动化测试', 'Python'], source: '猎头', note: '自动化框架自研过。' },
  { name: '顾斯年', title: '算法工程师', company: '某短视频团队', years: 4, skills: ['推荐系统', 'PyTorch'], source: '官网投递', note: '推荐链路经验对口。' },
  { name: '白露凝', title: '用户运营经理', company: '某消费品品牌', years: 6, skills: ['用户增长', '社群'], source: 'Boss 直聘', note: '私域案例讲得有细节。' },
  { name: '傅长青', title: '技术总监', company: '某传统软件公司', years: 12, skills: ['架构', '团队管理', '成本控制'], source: '猎头', note: '偏管理，动手意愿一般。' },
  { name: '梁澈', title: 'AI 应用工程师', company: '某大模型创业公司', years: 3, skills: ['LLM', 'RAG', 'TypeScript'], source: '内推', note: '做过简历解析类产品。' },
  { name: '温故', title: '招聘运营', company: '某连锁零售', years: 4, skills: ['流程优化', '数据分析'], source: '官网投递', note: '对漏斗数据很敏感。' },
];

interface Plan {
  stage: 'new' | 'screening' | 'interview' | 'offer' | 'hired';
  status?: 'active' | 'rejected';
  rated?: number;
  rejectReason?: string;
  nextStep?: string;
  followUpInDays?: number;
  note?: string;
}

const PLANS: Plan[] = [
  { stage: 'new' },
  { stage: 'screening', rated: 4, nextStep: '安排初面', followUpInDays: 2 },
  { stage: 'interview', rated: 4, nextStep: '等一面反馈', followUpInDays: 1, note: '一面约在周四下午。' },
  { stage: 'interview', rated: 5, nextStep: '安排二面', followUpInDays: 3 },
  { stage: 'offer', rated: 5, nextStep: '发 offer 待确认', followUpInDays: 1 },
  { stage: 'hired', rated: 5, note: '已入职，试用期三个月。' },
  { stage: 'screening', status: 'rejected', rejectReason: '岗位方向不匹配：偏测试开发，团队需要前端。' },
  { stage: 'new', rated: 3 },
  { stage: 'interview', rated: 4, nextStep: '二面已定', followUpInDays: 2 },
  { stage: 'offer', rated: 4, nextStep: '谈薪中', followUpInDays: 2 },
  { stage: 'screening', status: 'rejected', rejectReason: '薪资预期高出预算 30%，暂缓。' },
  { stage: 'hired', rated: 5, note: '已入职，负责招聘运营看板。' },
];

interface InterviewPlan {
  appIndex: number;
  round: number;
  title: string;
  daysAgo: number;
  status: 'scheduled' | 'completed' | 'cancelled';
  score?: number;
  recommendation?: 'strong_yes' | 'yes' | 'no' | 'strong_no';
  decision?: 'advance' | 'negotiate' | 'reject';
  advance?: 'yes' | 'hold' | 'no';
  feedback?: string;
  headline?: string;
  highlights?: string[];
  concerns?: Array<{ point: string; quote: string; at: string }>;
  unanswered?: string[];
}

const INTERVIEWS: InterviewPlan[] = [
  {
    appIndex: 3,
    round: 1,
    title: '第 1 轮面试',
    daysAgo: 3,
    status: 'completed',
    score: 5,
    recommendation: 'strong_yes',
    decision: 'advance',
    advance: 'yes',
    feedback: '技术深度和业务理解都在线，可以直接推二面。',
    headline: '基础扎实，业务理解到位，建议直接进二面',
    highlights: ['能讲清楚缓存穿透的取舍', '对自己做过的小程序项目有量化的收益复盘'],
    concerns: [{ point: '换工作的动机还需要再确认', quote: '现在团队挺稳定的，就是想看看机会。', at: '00:12:40' }],
    unanswered: ['离职后空窗期的安排'],
  },
  {
    appIndex: 4,
    round: 1,
    title: '第 1 轮面试',
    daysAgo: 2,
    status: 'completed',
    score: 4,
    recommendation: 'yes',
    decision: 'advance',
    advance: 'yes',
    feedback: '产品思路清楚，案例有细节；薪资预期略高，先看看团队意见。',
    headline: '产品思路清楚，缺少从 0 到 1 的经验',
    highlights: ['能把指标拆到可执行的动作', '会主动核对数据口径'],
    concerns: [{ point: '没有主导过 0 到 1 的产品', quote: '新业务我参与得比较少。', at: '00:08:05' }],
    unanswered: ['如果团队只有一个人，优先做什么'],
  },
  {
    appIndex: 9,
    round: 1,
    title: '第 1 轮面试',
    daysAgo: 1,
    status: 'completed',
    score: 4,
    recommendation: 'yes',
    decision: 'negotiate',
    advance: 'yes',
    feedback: '管理经验完整，但对一线的技术动手意愿一般，建议走管理岗谈薪。',
    headline: '偏管理，技术细节追问时深度不足',
    highlights: ['带过 40 人团队，成本控制有方法'],
    concerns: [{ point: '对一线编码兴趣不高', quote: '这几年主要是带团队。', at: '00:19:20' }],
  },
  {
    appIndex: 10,
    round: 1,
    title: '第 1 轮面试',
    daysAgo: 4,
    status: 'completed',
    score: 4,
    recommendation: 'strong_yes',
    decision: 'advance',
    advance: 'yes',
    feedback: '做过简历解析和 RAG，工程落地经验对口。',
    headline: '做过简历解析与 RAG，落位快',
    highlights: ['做过简历解析到结构化，处理过脏数据', '自己搭过评测集'],
    concerns: [{ point: '对模型选型的成本考虑不多', quote: '先保证效果，成本再优化。', at: '00:14:10' }],
  },
  {
    appIndex: 3,
    round: 2,
    title: '第 2 轮面试',
    daysAgo: -2,
    status: 'scheduled',
    feedback: '',
  },
  {
    appIndex: 9,
    round: 2,
    title: '第 2 轮面试',
    daysAgo: 0,
    status: 'cancelled',
    feedback: '',
  },
];

const BASE_TIME = Date.parse('2026-09-01T10:00:00+08:00');
const DAY = 24 * 60 * 60 * 1000;

function iso(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

export interface SeedResult {
  applications: number;
  interviews: number;
  pushed: number;
  failed: number;
}

export async function seedDemoRecords(actorId: string): Promise<SeedResult> {
  transaction(() => {
    const stamp = now();
    run(
      `INSERT OR REPLACE INTO jobs (id, title, department, location, work_mode, employment_type, level, headcount,
         salary_min, salary_max, currency, description, requirements, skills, status, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        JOB_ID,
        '演示岗位 · 全栈工程师',
        '技术中心',
        '上海',
        'hybrid',
        'full_time',
        'P6',
        3,
        40000,
        60000,
        'CNY',
        '这个岗位是「多维表格演示数据」用的，方便在表格里看到完整的招聘链路，随时可以一键清掉。',
        '5 年以上后端或全栈经验；能独立负责一个模块；对 AI 应用有好奇心。',
        toJson(['TypeScript', 'Node.js', 'SQL']),
        'open',
        actorId,
        stamp,
        stamp,
      ],
    );

    CANDIDATES.forEach((candidate, index) => {
      const plan = PLANS[index]!;
      const suffix = String(index + 1).padStart(2, '0');
      const candidateId = `${DEMO_PREFIX}cand_${suffix}`;
      const applicationId = `${DEMO_PREFIX}app_${suffix}`;
      const appliedAt = iso(-(30 - index) * DAY);
      run(
        `INSERT OR REPLACE INTO candidates (id, name, email, phone, location, current_company, current_title,
           years_experience, education, school, major, skills, tags, source, summary, notes, parsed, owner_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          candidateId,
          candidate.name,
          `demo${suffix}@example.com`,
          `1380000${suffix}00`,
          '上海',
          candidate.company,
          candidate.title,
          candidate.years,
          '本科',
          '演示大学',
          '计算机科学与技术',
          toJson(candidate.skills),
          toJson(['演示数据']),
          candidate.source,
          candidate.note,
          candidate.note,
          '{}',
          actorId,
          appliedAt,
          stamp,
        ],
      );
      run(
        `INSERT OR REPLACE INTO applications (id, job_id, candidate_id, stage, status, owner_id, source, rating,
           rejection_reason, rejected_at, applied_at, updated_at, next_step, next_follow_up_at, bitable_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          applicationId,
          JOB_ID,
          candidateId,
          plan.stage,
          plan.status ?? 'active',
          actorId,
          candidate.source,
          plan.rated ?? null,
          plan.rejectReason ?? null,
          plan.status === 'rejected' ? iso(-5 * DAY) : null,
          appliedAt,
          stamp,
          plan.nextStep ?? null,
          plan.followUpInDays ? iso(plan.followUpInDays * DAY) : null,
          plan.note ?? null,
        ],
      );
    });

    INTERVIEWS.forEach((plan, index) => {
      const suffix = String(plan.appIndex).padStart(2, '0');
      const interviewId = `${DEMO_PREFIX}itv_${String(index + 1).padStart(2, '0')}`;
      const scheduledAt = iso(plan.daysAgo * DAY);
      const summary = plan.headline
        ? {
            headline: plan.headline,
            highlights: plan.highlights ?? [],
            concerns: plan.concerns ?? [],
            unanswered: plan.unanswered ?? [],
            indicators_checked: [
              { indicator: '业务理解', label: '业务理解', evidence: '能复述业务目标与取舍' },
              { indicator: '技术深度', label: '技术深度', evidence: '追问到实现细节仍能回答' },
            ],
            suggested: plan.decision === 'reject' ? '不推进' : '进下一轮',
            reason: plan.feedback ?? '',
            dropped: [],
          }
        : null;
      run(
        `INSERT OR REPLACE INTO interviews (id, application_id, round, title, mode, scheduled_at, duration_minutes,
           location, meeting_url, interviewer_id, status, score, feedback, recommendation, created_by,
           created_at, updated_at, completed_at, decision, transcript, transcript_source, summary_json,
           summary_status, summary_model, summarized_at, advance_recommended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          interviewId,
          `${DEMO_PREFIX}app_${suffix}`,
          plan.round,
          plan.title,
          'video',
          scheduledAt,
          45,
          null,
          null,
          actorId,
          plan.status,
          plan.score ?? null,
          plan.feedback || null,
          plan.recommendation ?? null,
          actorId,
          scheduledAt,
          stamp,
          plan.status === 'completed' ? scheduledAt : null,
          plan.decision ?? null,
          plan.status === 'completed' ? '（演示数据：这是逐字稿占位，方便看到摘要是怎么来的。）' : null,
          plan.status === 'completed' ? 'demo' : null,
          summary ? toJson(summary) : null,
          summary ? 'manual' : 'none',
          summary ? 'demo-seed' : null,
          summary ? scheduledAt : null,
          plan.advance ?? null,
        ],
      );
    });
  });

  for (let index = 1; index <= CANDIDATES.length; index += 1) {
    queueEntity('application', `${DEMO_PREFIX}app_${String(index).padStart(2, '0')}`);
  }
  for (let index = 1; index <= INTERVIEWS.length; index += 1) {
    queueEntity('interview', `${DEMO_PREFIX}itv_${String(index).padStart(2, '0')}`);
  }
  const outcome = await flushBitableQueue(60);
  const { pushed, failed } = outcome;

  audit({
    actorId,
    action: 'bitable.demo_seed',
    entityType: 'bitable',
    entityId: null,
    detail: { applications: CANDIDATES.length, interviews: INTERVIEWS.length, pushed, failed },
  });

  return { applications: CANDIDATES.length, interviews: INTERVIEWS.length, pushed, failed };
}

export interface ClearResult {
  deleted: number;
  remoteDeleted: number;
  failed: number;
}

export async function clearDemoRecords(actorId: string): Promise<ClearResult> {
  const config = storedBitableConfig();
  let remoteDeleted = 0;
  let failed = 0;

  for (const entityType of ['interview', 'application'] as const) {
    const tableId = tableFor(entityType);
    if (!config.appToken || !tableId) continue;
    const links = listDemoLinks(entityType);
    if (!links.length) continue;
    const removal = await deleteBitableRecords(config.appToken, tableId, links.map((link) => link.record_id));
    if (removal.ok) remoteDeleted += links.length;
    else failed += links.length;
    for (const link of links) {
      run('DELETE FROM bitable_records WHERE entity_type = ? AND entity_id = ?', [entityType, link.entity_id]);
    }
  }

  let deleted = 0;
  transaction(() => {
    deleted = Number(run(`DELETE FROM interviews WHERE id LIKE '${DEMO_PREFIX}itv_%'`).changes);
    deleted += Number(run(`DELETE FROM applications WHERE id LIKE '${DEMO_PREFIX}app_%'`).changes);
    deleted += Number(run(`DELETE FROM candidates WHERE id LIKE '${DEMO_PREFIX}cand_%'`).changes);
    deleted += Number(run(`DELETE FROM jobs WHERE id = ?`, [JOB_ID]).changes);
  });

  audit({
    actorId,
    action: 'bitable.demo_clear',
    entityType: 'bitable',
    entityId: null,
    detail: { deleted, remoteDeleted, failed },
  });

  return { deleted, remoteDeleted, failed };
}

function listDemoLinks(entityType: 'interview' | 'application'): Array<{ entity_id: string; record_id: string }> {
  const prefix = entityType === 'interview' ? `${DEMO_PREFIX}itv_` : `${DEMO_PREFIX}app_`;
  return all<{ entity_id: string; record_id: string }>(
    `SELECT entity_id, record_id FROM bitable_records
     WHERE entity_type = ? AND entity_id LIKE ? AND record_id IS NOT NULL`,
    [entityType, `${prefix}%`],
  );
}
