/* 演示数据：3 个团队成员、5 个职位、15 位候选人、投递分布在各阶段、若干面试。
   重复执行会跳过已存在的数据（按邮箱/职位标题判断）。 */
import { mkdir, writeFile } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { getDb, getRow, all, run, closeDb, uploadDir } from './index.ts';
import { id, now, sha256, toJson } from '../lib/util.ts';
import { parseResume } from '../services/resume-parser.ts';
import { applyParsedFields } from '../services/candidates.ts';
import { registerUser } from '../auth.ts';
import { createJob } from '../services/jobs.ts';
import { createCandidate, updateCandidate } from '../services/candidates.ts';
import { createApplication, decideScreening, rejectApplication, addNote } from '../services/applications.ts';
import { createInterview, decideInterview } from '../services/interviews.ts';
import { decideOffer, updateOffer } from '../services/offers.ts';
import type { Stage } from '../constants.ts';
import type { JobInput } from '../services/jobs.ts';

getDb();

async function ensureUser(name: string, email: string, password: string, role?: 'admin' | 'recruiter' | 'hiring_manager') {
  const existing = getRow<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return existing.id;
  const user = await registerUser({ name, email, password, role });
  return user.id;
}

const admin = await ensureUser('林悦', 'hr@hireloop.cn', 'hireloop123', 'admin');

/* 演示账号：登录用 123 / 123。账号名与邮箱等价（两种都能登），密码是直接写哈希，
   产品界面里新建成员、修改密码仍然要求 8 位以上。 */
const DEMO_ACCOUNT = '123';
const DEMO_PASSWORD = '123';
const adminRow = getRow<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [admin]);
if (adminRow) {
  run('UPDATE users SET username = ? WHERE id = ?', [DEMO_ACCOUNT, admin]);
  if (!(await bcrypt.compare(DEMO_PASSWORD, adminRow.password_hash))) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(DEMO_PASSWORD, 10), admin]);
  }
}
const recruiter = await ensureUser('周航', 'zhou.hang@hireloop.cn', 'hireloop123', 'recruiter');
const manager = await ensureUser('陈可', 'chen.ke@hireloop.cn', 'hireloop123', 'hiring_manager');

function ensureJob(title: string, input: Omit<JobInput, 'title'>) {
  const existing = getRow<{ id: string }>('SELECT id FROM jobs WHERE title = ?', [title]);
  if (existing) return existing.id;
  return createJob({ ...input, title }, admin).id;
}

const jobs = [
  ensureJob('高级前端工程师', {
    department: '产品研发',
    location: '上海',
    work_mode: 'hybrid',
    employment_type: 'full_time',
    level: 'P6',
    headcount: 3,
    salary_min: 30000,
    salary_max: 45000,
    description: '负责招聘工作台的前端架构与体验，搭建可复用的组件体系。',
    requirements: '5 年以上前端经验，精通 React / TypeScript，有设计系统落地经验。',
    skills: ['React', 'TypeScript', 'Vite', 'CSS 架构', '性能优化'],
    owner_id: recruiter,
  }),
  ensureJob('后端工程师（Node）', {
    department: '产品研发',
    location: '上海',
    work_mode: 'remote',
    employment_type: 'full_time',
    level: 'P6',
    headcount: 2,
    salary_min: 28000,
    salary_max: 42000,
    description: '负责招聘平台 API 与数据层，保证流程可靠与服务稳定。',
    requirements: '熟悉 Node.js / SQL，理解关系建模与 API 设计，有 ATS 或 SaaS 经验优先。',
    skills: ['Node.js', 'SQL', 'TypeScript', 'API 设计'],
    owner_id: recruiter,
  }),
  ensureJob('产品经理（招聘方向）', {
    department: '产品',
    location: '北京',
    work_mode: 'onsite',
    employment_type: 'full_time',
    level: 'P5',
    headcount: 1,
    salary_min: 25000,
    salary_max: 35000,
    description: '梳理招聘业务需求，设计候选人流程与协作规范。',
    requirements: '3 年以上 B 端产品经验，理解招聘流程与协作角色。',
    skills: ['需求分析', 'B 端产品', '流程设计', '数据分析'],
    owner_id: manager,
  }),
  ensureJob('招聘专员', {
    department: '人力资源',
    location: '上海',
    work_mode: 'onsite',
    employment_type: 'full_time',
    level: 'P4',
    headcount: 2,
    salary_min: 12000,
    salary_max: 18000,
    description: '负责职位发布、简历筛选与面试安排。',
    requirements: '1 年以上招聘经验，沟通清晰，细致耐心。',
    skills: ['招聘', '人才寻访', '面试安排', '沟通'],
    owner_id: admin,
  }),
  ensureJob('设计实习生', {
    department: '设计',
    location: '远程',
    work_mode: 'remote',
    employment_type: 'intern',
    level: '实习',
    headcount: 1,
    salary_min: 4000,
    salary_max: 6000,
    description: '协助招聘工作台的界面与交互设计。',
    requirements: '视觉基础扎实，熟悉 Figma，有作品集。',
    skills: ['Figma', '视觉设计', '交互设计'],
    owner_id: manager,
  }),
];

interface SeedCandidate {
  name: string;
  email: string;
  phone?: string;
  location?: string;
  company?: string;
  title?: string;
  years?: number;
  education?: string;
  school?: string;
  skills: string[];
  jobIndex: number;
  stage: Stage;
  rejected?: string;
  rating?: number;
  /** 来源渠道，默认官网投递；混着给几个不同的值，工作台的来源分布才有意义 */
  source?: string;
}

const candidates: SeedCandidate[] = [
  { name: '李思远', email: 'siyuan.li@example.com', phone: '13800138001', location: '上海', company: '蔚来汽车', title: '高级前端工程师', years: 6, education: '本科', school: '同济大学', skills: ['React', 'TypeScript', '性能优化'], jobIndex: 0, stage: 'interview', rating: 4 },
  { name: '王梦琪', email: 'mengqi.wang@example.com', phone: '13800138002', location: '杭州', company: '阿里巴巴', title: '前端技术专家', years: 8, education: '硕士', school: '浙江大学', skills: ['React', 'Vue', '设计系统'], jobIndex: 0, stage: 'offer', rating: 5, source: '内部推荐' },
  { name: '赵一鸣', email: 'yiming.zhao@example.com', phone: '13800138003', location: '上海', company: '哔哩哔哩', title: '前端工程师', years: 4, education: '本科', school: '华东师范大学', skills: ['JavaScript', 'Vue', 'CSS 架构'], jobIndex: 0, stage: 'screening', source: '招聘会' },
  { name: '何雨桐', email: 'yutong.he@example.com', phone: '13800138004', location: '上海', company: '小红书', title: '前端开发', years: 3, skills: ['React', 'TypeScript'], jobIndex: 0, stage: 'new' },
  { name: '刘子谦', email: 'ziqian.liu@example.com', phone: '13800138005', location: '北京', company: '字节跳动', title: 'Node 工程师', years: 5, education: '本科', school: '北京邮电大学', skills: ['Node.js', 'SQL', 'Redis'], jobIndex: 1, stage: 'hired', rating: 5, source: '猎头推荐' },
  { name: '孙嘉禾', email: 'jiahe.sun@example.com', phone: '13800138006', location: '上海', company: '携程', title: '后端工程师', years: 6, education: '硕士', school: '上海交通大学', skills: ['Node.js', 'PostgreSQL', 'API 设计'], jobIndex: 1, stage: 'interview', rating: 4, source: '内部推荐' },
  { name: '周若曦', email: 'ruoxi.zhou@example.com', phone: '13800138007', location: '深圳', company: '腾讯', title: '后台开发', years: 7, skills: ['Java', 'SQL', 'Kubernetes'], jobIndex: 1, stage: 'screening' },
  { name: '吴梓涵', email: 'zihan.wu@example.com', phone: '13800138008', location: '北京', company: '美团', title: '产品经理', years: 5, education: '本科', school: '中国人民大学', skills: ['需求分析', '数据分析', 'B 端产品'], jobIndex: 2, stage: 'interview', rating: 4, source: '猎头推荐' },
  { name: '郑晓彤', email: 'xiaotong.zheng@example.com', phone: '13800138009', location: '北京', company: '京东', title: '高级产品经理', years: 7, education: '硕士', school: '清华大学', skills: ['流程设计', 'B 端产品'], jobIndex: 2, stage: 'screening' },
  { name: '冯浩宇', email: 'haoyu.feng@example.com', phone: '13800138010', location: '北京', company: '滴滴', title: '产品经理', years: 3, skills: ['需求分析', '用户研究'], jobIndex: 2, stage: 'new' },
  { name: '许安然', email: 'anran.xu@example.com', phone: '13800138011', location: '上海', company: '猎聘', title: '招聘专员', years: 3, education: '本科', school: '上海大学', skills: ['招聘', '人才寻访', '面试安排'], jobIndex: 3, stage: 'offer', rating: 4, source: '内部推荐' },
  { name: '邓子墨', email: 'zimo.deng@example.com', phone: '13800138012', location: '上海', company: 'BOSS 直聘', title: '招聘顾问', years: 2, skills: ['招聘', '沟通'], jobIndex: 3, stage: 'screening', source: '招聘会' },
  { name: '曹语桐', email: 'yutong.cao@example.com', phone: '13800138013', location: '南京', company: '应届生', title: '视觉设计', years: 0, education: '本科', school: '南京艺术学院', skills: ['Figma', '视觉设计'], jobIndex: 4, stage: 'new', source: '校招' },
  { name: '袁沐辰', email: 'muchen.yuan@example.com', phone: '13800138014', location: '杭州', company: '网易', title: '交互设计师', years: 1, education: '本科', school: '中国美术学院', skills: ['Figma', '交互设计', '用户研究'], jobIndex: 4, stage: 'screening', source: '校招' },
  { name: '谢知微', email: 'zhiwei.xie@example.com', phone: '13800138015', location: '上海', company: '自由职业', title: '前端工程师', years: 2, skills: ['Vue', 'JavaScript'], jobIndex: 0, stage: 'new', rejected: '技能不匹配' },
];

const UPCOMING_SLOTS = [
  { day: 0, hour: 15, mode: 'video', minutes: 45, interviewer: 'manager' },
  { day: 1, hour: 10, mode: 'onsite', minutes: 60, interviewer: 'recruiter' },
  { day: 3, hour: 16, mode: 'video', minutes: 45, interviewer: 'manager' },
] as const;
const PAST_SLOTS = [
  { day: -1, hour: 11, mode: 'video', minutes: 45, interviewer: 'manager' },
  { day: -2, hour: 15, mode: 'onsite', minutes: 60, interviewer: 'recruiter' },
] as const;
let upcomingSlotIndex = 0;
let pastSlotIndex = 0;

for (const item of candidates) {
  let candidateId = getRow<{ id: string }>('SELECT id FROM candidates WHERE email = ?', [item.email])?.id;
  if (!candidateId) {
    const candidate = createCandidate(
      {
        name: item.name,
        email: item.email,
        phone: item.phone,
        location: item.location,
        current_company: item.company,
        current_title: item.title,
        years_experience: item.years,
        education: item.education,
        school: item.school,
        skills: item.skills,
        source: item.source ?? '官网投递',
        owner_id: recruiter,
      },
      admin,
    );
    candidateId = candidate.id;
    updateCandidate(candidateId, { tags: item.rating ? ['重点跟进'] : [] }, admin);
  }

  const jobId = jobs[item.jobIndex]!;
  const existing = getRow<{ id: string }>('SELECT id FROM applications WHERE job_id = ? AND candidate_id = ?', [
    jobId,
    candidateId,
  ]);
  const applicationId =
    existing?.id ??
    createApplication({ jobId, candidateId, actorId: admin, source: item.source ?? '官网投递', ownerId: recruiter }).id;

  // 播种过就跳过：否则重复执行会给同一投递再加面试、再推阶段，演示数据会乱
  if (existing) continue;

  if (item.rejected) {
    rejectApplication({ applicationId, reason: item.rejected, note: '初筛后确认不匹配', actorId: admin });
    continue;
  }

  // 先安排并完成面试，再推进到待录用/已入职：入职是最终状态，不允许再排面试
  if (item.stage === 'interview' || item.stage === 'offer' || item.stage === 'hired') {
    decideScreening({ applicationId, actorId: recruiter, decision: 'advance' });
    const upcoming = item.stage === 'interview';
    // 面试时间打散到本周，方便演示周视图和今日日程
    const slot = upcoming
      ? UPCOMING_SLOTS[upcomingSlotIndex++ % UPCOMING_SLOTS.length]!
      : PAST_SLOTS[pastSlotIndex++ % PAST_SLOTS.length]!;
    const when = new Date();
    when.setDate(when.getDate() + slot.day);
    when.setHours(slot.hour, 0, 0, 0);
    const interview = createInterview({
      applicationId,
      scheduledAt: when.toISOString(),
      actorId: recruiter,
      interviewerId: slot.interviewer === 'manager' ? manager : recruiter,
      mode: slot.mode,
      durationMinutes: slot.minutes,
      location: slot.mode === 'onsite' ? '上海市徐汇区漕河泾 12 号楼 3F 会议室 B' : null,
      meetingUrl: slot.mode === 'video' ? 'https://meeting.feishu.cn/demo-room' : null,
    });
    if (!upcoming) {
      run(`UPDATE interviews SET summary_status = 'manual', summary_json = ?, summarized_at = ? WHERE id = ?`,
        [toJson({ conclusion: '已完成岗位相关技能沟通，进入后续流程。' }), now(), interview.id]);
      decideInterview({ interviewId: interview.id, decision: 'negotiate', actorId: recruiter });
      updateOffer(applicationId, recruiter, { expected_salary: 20000 });
      if (item.stage === 'hired') {
        const startDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
        updateOffer(applicationId, recruiter, { final_salary: 19500, start_date: startDate, reply_deadline: startDate });
        for (const action of ['send', 'accept', 'hire'] as const) {
          decideOffer({ applicationId, actorId: recruiter, action });
        }
      }
    }
  }

  addNote({ applicationId, note: '沟通顺畅，作品集与岗位要求匹配度较高。', actorId: recruiter });
}

const summary = all<{ n: number }>('SELECT COUNT(*) AS n FROM applications')[0];
/* 给演示候选人挂一份真实简历文件，方便体验下载与解析结果展示 */
const RESUME_FOR = 'siyuan.li@example.com';
const RESUME_TEXT = `李思远
高级前端工程师 · 上海
手机：13800138001　邮箱：siyuan.li@example.com
6 年前端开发经验，关注性能与工程化。
工作经历
2021-2025　蔚来汽车　高级前端工程师
负责车主端 Web 与小程序，主导构建体系升级，首屏时间下降 38%。使用 React、TypeScript、Vite。
2019-2021　携程　前端工程师
负责机票频道重构，落地组件库与埋点规范。
教育背景
2015-2019　同济大学　软件工程　本科
技能
React、TypeScript、性能优化、Webpack、Node.js、Figma
`;

const resumeTarget = getRow<{ id: string; resume_file_id: string | null }>(
  'SELECT id, resume_file_id FROM candidates WHERE email = ?',
  [RESUME_FOR],
);
if (resumeTarget && !resumeTarget.resume_file_id) {
  const filename = '李思远-高级前端工程师.txt';
  const buffer = Buffer.from(RESUME_TEXT, 'utf8');
  const fileId = id('file');
  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, `${fileId}.txt`), buffer);
  run(
    `INSERT INTO files (id, filename, mime, size, sha256, storage_path, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [fileId, filename, 'text/plain', buffer.length, sha256(buffer), `${fileId}.txt`, admin, now()],
  );
  const parsed = await parseResume({ buffer, filename });
  applyParsedFields(resumeTarget.id, fileId, { ...parsed }, admin);
  run('UPDATE candidates SET resume_text = ? WHERE id = ?', [parsed.text, resumeTarget.id]);
  run('UPDATE files SET resume_parse_json = ? WHERE id = ?', [toJson(parsed), fileId]);
  console.log(`已为演示候选人挂上简历：${filename}`);
}

/* 让工作台的「需要跟进」有内容：把两条还停在初筛的投递回拨几天 */
const STALE_DAYS = [7, 9];
const staleTargets = all<{ id: string }>(
  `SELECT a.id FROM applications a JOIN candidates c ON c.id = a.candidate_id
   WHERE a.status = 'active' AND a.stage IN ('new', 'screening')
   ORDER BY a.applied_at ASC LIMIT ?`,
  [STALE_DAYS.length],
);
staleTargets.forEach((row, index) => {
  const days = STALE_DAYS[index] ?? 6;
  const stamp = new Date(Date.now() - days * 86_400_000).toISOString();
  run('UPDATE applications SET updated_at = ? WHERE id = ?', [stamp, row.id]);
});

console.log(`演示数据已就绪：${jobs.length} 个职位，${candidates.length} 位候选人，${summary?.n ?? 0} 条投递。`);
console.log('登录账号：123 / 123（管理员 林悦，也可以用 hr@hireloop.cn / hireloop123）');
closeDb();