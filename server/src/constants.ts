export const STAGES = ['new', 'screening', 'interview', 'offer', 'hired'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new: '新简历',
  screening: '筛选中',
  interview: '面试中',
  offer: '待录用',
  hired: '已入职',
};

export const STAGE_HINTS: Record<Stage, string> = {
  new: '刚进入流程，等待初筛',
  screening: '已排入初筛，等待结论',
  interview: '面谈进行中，可安排多轮',
  offer: '已通过面试，等待答复',
  hired: '已接受并入职',
};

export const STAGE_ORDER: Record<Stage, number> = {
  new: 0,
  screening: 1,
  interview: 2,
  offer: 3,
  hired: 4,
};

export const REJECTION_REASONS = [
  '经验不匹配',
  '技能不匹配',
  '薪资期望不符',
  '学历/资质不达标',
  '流程中主动放弃',
  '岗位已关闭',
  '其他',
] as const;

export const INTERVIEW_MODES = ['onsite', 'video', 'phone'] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export const INTERVIEW_MODE_LABELS: Record<InterviewMode, string> = {
  onsite: '现场',
  video: '视频',
  phone: '电话',
};

export const RECOMMENDATION_LABELS: Record<string, string> = {
  strong_yes: '强烈推荐',
  yes: '推荐',
  no: '不推荐',
  strong_no: '明确否决',
};

export const APPLICATION_STATUS = ['active', 'rejected'] as const;
export const JOB_STATUS = ['open', 'paused', 'closed'] as const;
export const WORK_MODE_LABELS: Record<string, string> = {
  onsite: '坐班',
  hybrid: '混合',
  remote: '远程',
};
export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  full_time: '全职',
  part_time: '兼职',
  intern: '实习',
  contract: '合同制',
};
export const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  recruiter: '招聘',
  hiring_manager: '用人经理',
};

export const RESUME_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
export const RESUME_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'text/plain': 'txt',
  'text/markdown': 'md',
};
export const RESUME_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt', '.md'];
/** 下载时按扩展名决定 Content-Type，绝不采信客户端声明，避免把 HTML 当简历回放。 */
export const DOWNLOAD_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
export const RESUME_ACCEPT = '.pdf,.docx,.txt,.md';