import { z } from 'zod';
import { REJECTION_REASONS } from '../constants.ts';

const text = z.string().trim().min(1).max(800);
const promptIdentifier = (max: number) => text.max(max).regex(/^[^\u0000-\u001f\uD800-\uDFFF"\\]+$/u);
const labelName = promptIdentifier(48);
const conditionText = promptIdentifier(96);
const rawQuote = z.string().min(1).max(1200).nullish();
const forbiddenAttribute = /性别|男性|女性|限男|限女|男士|女士|女生|男生|[男女]\s*优先|年龄|\d{1,3}\s*岁|未婚|已婚|婚育|婚姻|生育|怀孕|备孕|籍贯|户籍|民族|健康|残疾|gender|\bage\b|ethnicity|marital|pregnan|disabilit/i;
const forbiddenDecision = /(?:建议|推荐|不予|不宜|应当|直接|不建议)\s*(?:录用|淘汰|聘用|雇用)|(?:评分|得分|总分|排名|匹配度)\s*[:：]?\s*\d|\d+(?:\.\d+)?\s*[%％]\s*(?:匹配|符合)|\d+\s*[分档]\s*(?:匹配|达标)|\b(?:hire|reject)\s+(?:this|the)\s+candidate/i;

function permitted(value: string): boolean {
  return !forbiddenAttribute.test(value) && !forbiddenDecision.test(value);
}

export const DIMENSIONS = ['背景度', '心态度', '专业度', '组织度'] as const;
export const DEPARTMENT_CODES = [
  { code: 'XS', label: '销售营销岗' },
  { code: 'YF', label: '研发技术岗' },
  { code: 'SC', label: '生产制造岗' },
  { code: 'CG', label: '采购岗' },
  { code: 'CW', label: '财务岗' },
  { code: 'RS', label: '人事岗' },
  { code: 'XZ', label: '行政岗' },
  { code: 'PZ', label: '品质管理岗' },
  { code: 'CC', label: '仓储计划岗' },
  { code: 'GL', label: '管理高管岗' },
] as const;
export const JOB_LEVELS = [
  { code: 'L1', name: '操作岗', tagline: '初级听令做小事' },
  { code: 'L2', name: '执行岗', tagline: '熟练按规做常事' },
  { code: 'L3', name: '实施岗', tagline: '实战经验管难事' },
  { code: 'L4', name: '策略岗', tagline: '精通领域管繁事' },
  { code: 'L5', name: '经营岗', tagline: '系统创造扛公事' },
  { code: 'L6', name: '决策岗', tagline: '方向决策扛险事' },
] as const;
export const CAREER_TRAITS = [
  { code: 'A', name: '前进者', combo: '主力量型 · 辅完美型', strength: '拿到未来结果' },
  { code: 'B', name: '现实者', combo: '主力量型 · 辅稳健型', strength: '拿到当下结果' },
  { code: 'C', name: '交际者', combo: '主交流型 · 辅稳健型', strength: '处理一对一关系' },
  { code: 'D', name: '宣扬者', combo: '主交流型 · 辅完美型', strength: '处理一对多关系' },
  { code: 'E', name: '感知者', combo: '主稳健型 · 辅交流型', strength: '收集人的信息' },
  { code: 'F', name: '事实者', combo: '主稳健型 · 辅力量型', strength: '收集事的信息' },
  { code: 'G', name: '分析者', combo: '主完美型 · 辅交流型', strength: '策划与系统分析' },
  { code: 'H', name: '人性者', combo: '主完美型 · 辅力量型', strength: '探索人的可能性' },
] as const;

export type DepartmentCode = (typeof DEPARTMENT_CODES)[number]['code'];
export type JobLevelCode = (typeof JOB_LEVELS)[number]['code'];
export type CareerTraitCode = (typeof CAREER_TRAITS)[number]['code'];

const departmentCodeMap = new Map<string, (typeof DEPARTMENT_CODES)[number]>(DEPARTMENT_CODES.map((item) => [item.code, item]));
const jobLevelMap = new Map<string, (typeof JOB_LEVELS)[number]>(JOB_LEVELS.map((item) => [item.code, item]));
const careerTraitMap = new Map<string, (typeof CAREER_TRAITS)[number]>(CAREER_TRAITS.map((item) => [item.code, item]));

const optText = (max: number) => z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  text.max(max).optional(),
);
const optIdentifier = (max: number) => z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  promptIdentifier(max).optional(),
);
const departmentCodeEnum = z.enum(['XS', 'YF', 'SC', 'CG', 'CW', 'RS', 'XZ', 'PZ', 'CC', 'GL']);
const jobLevelEnum = z.enum(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
const careerTraitEnum = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);

const profileMetaSchema = z.object({
  code: optIdentifier(32),
  industry: optText(80),
  department_code: z.preprocess((value) => typeof value === 'string' && !value.trim() ? undefined : value, departmentCodeEnum.optional()),
  department: optText(60),
  level: z.preprocess((value) => typeof value === 'string' && !value.trim() ? undefined : value, jobLevelEnum.optional()),
  level_name: optText(40),
  level_tagline: optText(60),
  location: optText(80),
});

const traitMatchSchema = z.object({
  code: careerTraitEnum,
  name: optText(40),
  combo: optText(60),
  reason: text,
});

export const levels = z.enum(['E', 'D', 'C', 'B', 'A', 'unknown']);
const tiersSchema = z.object({ E: text, D: text, C: text, B: text, A: text });
const weight = z.number().int().min(0).max(100);
export const profileSchema = z.object({
  meta: profileMetaSchema.optional(),
  positioning: text,
  responsibilities: z.array(text).max(8).optional(),
  hard_gates: z.array(z.object({ condition: conditionText, how: text })).max(8),
  indicators: z.array(z.object({
    name: z.enum(DIMENSIONS), weight,
    labels: z.array(z.object({ name: labelName, weight, tiers: tiersSchema })).min(1).max(6),
  })).length(DIMENSIONS.length),
  trait_match: traitMatchSchema.optional(),
  redlines: z.array(conditionText).max(8),
  bonus: z.array(text).max(8),
  not_wanted: z.array(text).max(8),
  weights_adjusted: z.boolean().optional(),
  compliance_rewritten: z.boolean().optional(),
});
export type ProfileMeta = z.infer<typeof profileMetaSchema>;
export type ProfileTraitMatch = { code: CareerTraitCode; name: string; combo: string; reason: string };
export type Profile = Omit<z.infer<typeof profileSchema>, 'trait_match'> & { trait_match?: ProfileTraitMatch };

function distribute(total: number, count: number, index: number): number {
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}

function compactMeta(meta?: ProfileMeta): ProfileMeta | undefined {
  if (!meta) return undefined;
  const dept = meta.department_code ? departmentCodeMap.get(meta.department_code) : undefined;
  const lvl = meta.level ? jobLevelMap.get(meta.level) : undefined;
  const next: ProfileMeta = {
    code: meta.code ?? (meta.department_code && meta.level ? `${meta.department_code}-${meta.level}` : undefined),
    industry: meta.industry,
    department_code: meta.department_code,
    department: meta.department ?? dept?.label,
    level: meta.level,
    level_name: meta.level_name ?? lvl?.name,
    level_tagline: meta.level_tagline ?? lvl?.tagline,
    location: meta.location,
  };
  const defined = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as ProfileMeta;
  return Object.keys(defined).length ? defined : undefined;
}

export function normalizeProfile(value: unknown, jd = '', generated = false): Profile | undefined {
  const { data } = profileSchema.safeParse(value);
  if (!data || new Set(data.indicators.map(({ name }) => name)).size !== DIMENSIONS.length) return;
  let weightsAdjusted = data.weights_adjusted === true;
  let complianceRewritten = data.compliance_rewritten === true || forbiddenAttribute.test(jd);
  const clean = (input: string, replacement: string) => {
    if (permitted(input)) return input;
    complianceRewritten = true;
    return replacement;
  };
  const average = data.indicators.reduce((total, item) => total + item.weight, 0) !== 100;
  if (average) weightsAdjusted = true;
  const indicators = DIMENSIONS.map((dimension) => {
    const item = data.indicators.find(({ name }) => name === dimension)!;
    const target = average ? 25 : item.weight;
    const redistribute = average || item.labels.reduce((total, label) => total + label.weight, 0) !== target;
    if (redistribute) weightsAdjusted = true;
    return {
      name: dimension, weight: target,
      labels: item.labels.map((label, index) => ({
        name: clean(label.name, `${dimension}岗位能力 ${index + 1}`),
        weight: redistribute ? distribute(target, item.labels.length, index) : label.weight,
        tiers: {
          E: clean(label.tiers.E, objectiveTiers.E), D: clean(label.tiers.D, objectiveTiers.D),
          C: clean(label.tiers.C, objectiveTiers.C), B: clean(label.tiers.B, objectiveTiers.B),
          A: clean(label.tiers.A, objectiveTiers.A),
        },
      })),
    };
  });
  if (indicators.some(({ labels }) => new Set(labels.map(({ name }) => name)).size !== labels.length)) return;
  const metaStrings = data.meta ? Object.values(data.meta).filter((entry): entry is string => typeof entry === 'string') : [];
  const traitStrings = data.trait_match ? [data.trait_match.name, data.trait_match.combo, data.trait_match.reason].filter((entry): entry is string => typeof entry === 'string') : [];
  const allManualStrings = [
    data.positioning,
    ...metaStrings,
    ...(data.responsibilities ?? []),
    ...traitStrings,
    ...data.hard_gates.flatMap(({ condition, how }) => [condition, how]),
    ...data.redlines,
    ...data.bonus,
    ...data.not_wanted,
    ...data.indicators.flatMap(({ labels }) => labels.flatMap(({ name, tiers }) => [name, ...Object.values(tiers)])),
  ];
  if (!generated && !allManualStrings.every(permitted)) return;
  const filterItems = (items: string[]) => items.filter((item) => {
    if (permitted(item)) return true;
    complianceRewritten = true;
    return false;
  });
  const positioning = clean(data.positioning, '依据职责与岗位能力要求完成工作');
  const hardGates = data.hard_gates.filter(({ condition }) => filterItems([condition]).length > 0)
    .map(({ condition, how }) => ({ condition, how: clean(how, '核对简历及可核实的工作经历') }));
  if (new Set(hardGates.map(({ condition }) => condition)).size !== hardGates.length) return;
  const cleanMetaField = (input?: string) => input && permitted(input) ? input : (input ? (complianceRewritten = true, undefined) : undefined);
  const meta = compactMeta(data.meta ? {
    code: cleanMetaField(data.meta.code),
    industry: cleanMetaField(data.meta.industry),
    department_code: data.meta.department_code,
    department: cleanMetaField(data.meta.department),
    level: data.meta.level,
    level_name: cleanMetaField(data.meta.level_name),
    level_tagline: cleanMetaField(data.meta.level_tagline),
    location: cleanMetaField(data.meta.location),
  } : undefined);
  const responsibilities = data.responsibilities ? filterItems(data.responsibilities) : undefined;
  const traitDef = data.trait_match ? careerTraitMap.get(data.trait_match.code) : undefined;
  const traitMatch: ProfileTraitMatch | undefined = data.trait_match && traitDef ? {
    code: traitDef.code,
    name: traitDef.name,
    combo: traitDef.combo,
    reason: clean(data.trait_match.reason, `该岗位核心工作方式与${traitDef.name}特质相匹配`),
  } : undefined;
  return {
    ...(meta ? { meta } : {}),
    positioning,
    ...(responsibilities && responsibilities.length ? { responsibilities } : {}),
    hard_gates: hardGates,
    indicators,
    ...(traitMatch ? { trait_match: traitMatch } : {}),
    redlines: filterItems(data.redlines),
    bonus: filterItems(data.bonus),
    not_wanted: filterItems(data.not_wanted),
    get weights_adjusted() { return weightsAdjusted || undefined; },
    get compliance_rewritten() { return complianceRewritten || undefined; },
  };
}

function parseDepartmentCode(value: unknown): DepartmentCode | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  const match = upper.match(/\b(XS|YF|SC|CG|CW|RS|XZ|PZ|CC|GL)\b/);
  return match ? match[1] as DepartmentCode : undefined;
}

function parseJobLevel(value: unknown): JobLevelCode | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().toUpperCase().match(/L([1-6])/);
  return match ? `L${match[1]}` as JobLevelCode : undefined;
}

function parseTraitCode(value: unknown): CareerTraitCode | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().toUpperCase().match(/^([A-H])(?:\b|[\s·\-—]|[\u4e00-\u9fa5])/);
  return match ? match[1] as CareerTraitCode : (value.trim().toUpperCase().match(/^([A-H])$/)?.[1] as CareerTraitCode | undefined);
}

const generatedLabel = z.tuple([labelName, weight, text, text, text, text, text]);
const generatedLabels = z.array(generatedLabel).min(3).max(6);
const generatedProfileSchema = profileSchema.pick({
  positioning: true, hard_gates: true, redlines: true, bonus: true, not_wanted: true,
}).extend({
  meta: z.record(z.string(), z.unknown()).optional(),
  responsibilities: z.array(z.unknown()).max(12).optional(),
  trait_match: z.record(z.string(), z.unknown()).optional(),
  weights: z.tuple([weight, weight, weight, weight]),
  background: generatedLabels,
  attitude: generatedLabels,
  technical: generatedLabels,
  collaboration: generatedLabels,
});

export function normalizeGeneratedProfile(value: unknown, jd: string, titleOnly: boolean): Profile | undefined {
  const parsed = generatedProfileSchema.safeParse(value);
  if (!parsed.success) return;
  const { meta: rawMeta, responsibilities: rawResp, trait_match: rawTrait, weights, background, attitude, technical, collaboration, hard_gates, redlines, ...content } = parsed.data;
  const groups = [background, attitude, technical, collaboration] as const;
  const strOrUndef = (item: unknown, max: number) => typeof item === 'string' && item.trim() ? item.trim().slice(0, max) : undefined;
  const meta = rawMeta ? compactMeta({
    code: strOrUndef(rawMeta.code, 32)?.replace(/["\\]/g, ''),
    industry: strOrUndef(rawMeta.industry, 80),
    department_code: parseDepartmentCode(rawMeta.department_code ?? rawMeta.department),
    department: strOrUndef(rawMeta.department, 60),
    level: parseJobLevel(rawMeta.level),
    level_name: strOrUndef(rawMeta.level_name, 40),
    level_tagline: strOrUndef(rawMeta.level_tagline, 60),
    location: strOrUndef(rawMeta.location, 80),
  }) : undefined;
  const responsibilities = rawResp
    ?.map((entry) => typeof entry === 'string' ? entry.trim().slice(0, 800) : '')
    .filter(Boolean)
    .slice(0, 8);
  const traitCode = rawTrait ? parseTraitCode(rawTrait.code ?? rawTrait.name) : undefined;
  const traitReason = rawTrait ? strOrUndef(rawTrait.reason, 800) : undefined;
  const traitDef = traitCode ? careerTraitMap.get(traitCode) : undefined;
  const trait_match = traitDef && traitReason ? {
    code: traitDef.code,
    name: traitDef.name,
    combo: traitDef.combo,
    reason: traitReason,
  } : undefined;
  return normalizeProfile({
    ...(meta ? { meta } : {}),
    ...content,
    ...(responsibilities?.length ? { responsibilities } : {}),
    hard_gates: titleOnly ? [] : hard_gates,
    redlines: titleOnly ? [] : redlines,
    ...(trait_match ? { trait_match } : {}),
    indicators: DIMENSIONS.map((name, index) => ({
      name,
      weight: weights[index],
      labels: groups[index]!.map(([name, weight, E, D, C, B, A]) => ({ name, weight, tiers: { E, D, C, B, A } })),
    })),
  }, jd, true);
}

const objectiveTiers = {
  E: '明确未具备该能力', D: '具备部分基础，执行仍需帮助', C: '能独立完成岗位日常工作',
  B: '能处理复杂场景并复盘改进', A: '能建立方法并指导他人',
};

const EDU = /博士|硕士|研究生|本科|大专|专科|中专|高中|初中/g;
const EDU_RANK: Record<string, number> = { 初中: 0, 高中: 1, 中专: 1, 专科: 2, 大专: 2, 本科: 3, 研究生: 4, 硕士: 4, 博士: 5 };
const minimumYears = /(?:至少\s*)?(\d{1,2})\s*年\s*(?:及以上|以上|起|\+)|(?:不少于|至少|最低)\s*(\d{1,2})\s*年/;

export interface FallbackJobMeta {
  department?: string | null;
  location?: string | null;
  level?: string | null;
  workMode?: string | null;
  employmentType?: string | null;
  description?: string | null;
  requirements?: string | null;
}

function inferDepartment(title: string, department?: string | null, jd = ''): DepartmentCode {
  const source = `${department ?? ''} ${title}`.trim();
  const full = `${source} ${jd.slice(0, 400)}`;
  if (/研发|技术|开发|工程|架构|算法|前端|后端|全栈|测试|运维|数据|软件|硬件|嵌入式|产品经理|产品|UI|UX|设计|程序|IT/i.test(source)) return 'YF';
  if (/销售|营销|市场|运营|商务|客户|客服|渠道|推广|增长|电销|新媒体|品牌|公关|直播|电商|投放|BD/i.test(source)) return 'XS';
  if (/品质|质量|质检|品控|QC|QA|体系|ISO/i.test(source)) return 'PZ';
  if (/采购|供应链|供应商|寻源|SQE/i.test(source)) return 'CG';
  if (/财务|会计|出纳|审计|税务|成本|预算|总账|资金/i.test(source)) return 'CW';
  if (/人事|人力|招聘|培训|薪酬|绩效|HR|OD|员工关系/i.test(source)) return 'RS';
  if (/仓储|物流|计划|物控|仓管|发货|库存|调度|PMC/i.test(source)) return 'CC';
  if (/生产|制造|车间|工艺|产线|装配|设备|维修|普工|拉长|班组/i.test(source)) return 'SC';
  if (/行政|前台|文员|后勤|总务|秘书/i.test(source)) return 'XZ';
  if (/总经理|总裁|CEO|COO|VP|副总裁|总监|董事长|合伙人|厂长/i.test(source)) return 'GL';
  if (/代码|系统|接口|数据库|前端|后端|开发/.test(full)) return 'YF';
  if (/业绩|成交|获客|转化|客户跟进|渠道/.test(full)) return 'XS';
  return 'XZ';
}

function inferLevel(title: string, level?: string | null): JobLevelCode {
  const direct = parseJobLevel(level ?? title);
  if (direct) return direct;
  const source = `${level ?? ''} ${title}`;
  if (/董事长|总裁|CEO|实控人|首席科学家/i.test(source)) return 'L6';
  if (/总经理|副总|副总裁|总监|VP|CFO|CTO|CHO|COO|总工|首席/i.test(source)) return 'L5';
  if (/经理|高级|资深|专家|架构师|负责人|大客|主管经理|Lead|Leader|P7|P8/i.test(source)) return 'L4';
  if (/工程师|主管|会计|审计|店长|督导|策划|面销|顾问|分析师|设计师|开发|测试|运维|产品|P6/i.test(source)) return 'L3';
  if (/实习|普工|文员|前台|保安|发货|分拣|学徒/i.test(source)) return 'L1';
  if (/助理|专员|跟单|客服|出纳|美工|质检|仓管|电销|拉长|组长|初级|P5/i.test(source)) return 'L2';
  return 'L3';
}

function inferTrait(dept: DepartmentCode, level: JobLevelCode, title: string): { code: CareerTraitCode; reason: string } {
  if (level === 'L5' || level === 'L6' || /经理|总监|负责人|主管/.test(title)) {
    return { code: 'A', reason: '需要统筹目标与阶段计划，在复杂场景下保持全局判断并推动结果落地' };
  }
  if (dept === 'XS') {
    if (/市场|品牌|推广|策划|投放|活动|新媒体/.test(title)) {
      return { code: 'E', reason: '需要敏锐捕捉用户与市场反馈，统筹宣传、活动执行与多方协作' };
    }
    if (/培训|讲师|公关|主播|主持|内容/.test(title)) {
      return { code: 'D', reason: '需要清晰感染力的公开表达与说服能力，面向多方对象传递价值' };
    }
    return { code: 'C', reason: '需要高频一对一客户沟通，主动建立信任、捕捉需求并温和推进转化' };
  }
  if (dept === 'YF') {
    if (/架构|产品|数据|算法|分析|策略/.test(title)) {
      return { code: 'G', reason: '需要系统化的逻辑分析与方案抽象能力，能从复杂问题中提炼清晰架构' };
    }
    return { code: 'F', reason: '需要实事求是、依据事实和数据定位问题，按工程标准严谨交付' };
  }
  if (dept === 'CW' || dept === 'PZ') {
    return { code: 'F', reason: '需要高度严谨的事实核查与合规意识，以准确数据和客观标准把关' };
  }
  if (dept === 'RS') {
    if (/培训|讲师/.test(title)) return { code: 'D', reason: '需要良好的一对多沟通与感染力，推动培训落地和团队赋能' };
    return { code: 'H', reason: '需要以人为本的洞察力与同理心，平衡组织诉求与员工体验' };
  }
  if (dept === 'SC' || dept === 'CC' || dept === 'CG') {
    return { code: 'B', reason: '需要务实高效的执行力，关注现场、周期与交付细节，快速拿到当下结果' };
  }
  return { code: 'E', reason: '需要细致敏感的服务意识与跨部门协作能力，稳妥承接日常事务与信息流转' };
}

const DEPT_WEIGHTS: Record<DepartmentCode, [number, number, number, number]> = {
  YF: [20, 20, 40, 20],
  XS: [20, 25, 30, 25],
  GL: [25, 20, 25, 30],
  CW: [25, 25, 35, 15],
  PZ: [20, 25, 35, 20],
  SC: [20, 25, 35, 20],
  CG: [20, 25, 30, 25],
  CC: [20, 25, 35, 20],
  RS: [25, 25, 25, 25],
  XZ: [25, 25, 25, 25],
};

type LabelPreset = { name: string; tiers: { E: string; D: string; C: string; B: string; A: string } };

function departmentTechLabels(dept: DepartmentCode): LabelPreset[] {
  switch (dept) {
    case 'YF':
      return [
        { name: '核心技术实现', tiers: { E: '无法独立完成模块开发', D: '可在指导下修改常规代码', C: '能独立完成需求设计与代码交付', B: '能攻克复杂技术难点并优化性能', A: '能主导核心架构设计并指导团队' } },
        { name: '质量与故障排查', tiers: { E: '缺少自测习惯，难定位线上异常', D: '能复现常见缺陷并在协助下修复', C: '能编写常规测试并独立定位常见故障', B: '能排查跨模块疑难故障并做根因复盘', A: '能建立质量规范、监控与防故障机制' } },
        { name: '工程工具与效率', tiers: { E: '不熟悉版本控制与研发协作流程', D: '能按步骤使用常用研发工具', C: '熟练使用代码仓库、评审与常规提效工具', B: '能借助自动化或 AI 工具显著提升交付效率', A: '能沉淀工程模板与工具链带动团队提效' } },
      ];
    case 'XS':
      return [
        { name: '客户开发与推进', tiers: { E: '不敢触达客户或无有效跟进', D: '能完成基础触达但转化推进弱', C: '能独立挖掘客户需求并按流程推进成交', B: '能突破重点客户并持续提升转化率', A: '能搭建客户开发与复购方法并带教新人' } },
        { name: '方案表达与异议处理', tiers: { E: '无法准确介绍产品核心价值', D: '能照本宣科说明基础卖点', C: '能结合客户场景清晰阐述方案并回应常见异议', B: '能定制差异化方案促成复杂商务谈判', A: '能提炼行业打法与话术体系供团队复用' } },
        { name: '数据复盘与工具运营', tiers: { E: '不记录客户台账与跟进节点', D: '需提醒才更新 CRM 或表格数据', C: '规范维护客户线索台账并按周期复盘漏斗', B: '能通过数据分析识别流失环节并优化动作', A: '能建立可复制的精细化运营与数据看板' } },
      ];
    case 'CW':
      return [
        { name: '账务处理与核算', tiers: { E: '不熟悉基础做账与凭证规范', D: '能在复核下完成常规单据录入', C: '能独立完成日常核算、对账与报表编制', B: '能处理复杂账务并及时识别财务风险', A: '能完善核算体系并支持经营决策分析' } },
        { name: '税务与合规把控', tiers: { E: '不了解基础税法与内控要求', D: '能按既定模板完成常规申报', C: '熟练遵守财税政策并按期准确申报', B: '能识别税务风险并提出合规筹划建议', A: '能搭建财务内控规范并应对专项审计' } },
        { name: '财务软件与表格分析', tiers: { E: '仅会基础表格录入', D: '会用财务系统完成单一模块操作', C: '熟练使用财务软件与函数工具输出标准报表', B: '能搭建自动化核对表与经营分析模型', A: '能推动业财系统联动并带教团队' } },
      ];
    case 'RS':
      return [
        { name: '模块实务操作', tiers: { E: '不了解对应人事模块基础流程', D: '可在指导下执行单一事务操作', C: '能独立按流程完成招聘、入转调离或绩效等模块工作', B: '能结合业务痛点优化模块流程并提升效率', A: '能统筹多模块联动并搭建标准化制度' } },
        { name: '劳动合规与风险意识', tiers: { E: '忽视人事合规与签字留痕要求', D: '了解常见规定但易遗漏细节', C: '严格执行人事合规清单，关键节点留痕完整', B: '能提前识别用工风险并妥善化解争议', A: '能完善企业人事合规体系并培训业务管理者' } },
        { name: '办公与数据台账工具', tiers: { E: '台账混乱、统计易出错', D: '能维护基础花名册与表格', C: '熟练使用办公软件与招聘/人事系统维护准确台账', B: '能通过人效与漏斗数据输出业务建议', A: '能沉淀数字化人事工具与知识库' } },
      ];
    default:
      return [
        { name: '岗位核心业务技能', tiers: { E: '未具备岗位核心操作能力', D: '具备基础认知，关键动作需专人指导', C: '能独立按标准流程高质量完成日常任务', B: '能处理复杂或异常业务并总结优化方法', A: '能制定业务标准并指导团队提升产出' } },
        { name: '工具与软件熟练度', tiers: { E: '不熟悉岗位必备软件或系统', D: '能完成基础录入与简单操作', C: '熟练运用岗位常用办公、业务系统及提效工具', B: '能通过模板或工具自动化显著提升效率', A: '能优化工具流程并组织内部带教' } },
        { name: '问题分析与落地执行', tiers: { E: '遇到异常即停滞、缺少解决思路', D: '能反馈问题但依赖他人给出方案', C: '能按SOP排查常见问题并推动闭环落地', B: '能提前预判风险并提出可行改进方案', A: '能系统性根治高频问题并沉淀最佳实践' } },
      ];
  }
}

function extractResponsibilities(description?: string | null, requirements?: string | null): string[] {
  const source = description?.trim() || requirements?.trim() || '';
  if (!source) return [];
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[0-9一二三四五六七八九十]+[.、)）]|[-*•·])\s*/, '').trim())
    .filter((line) => line.length >= 6 && line.length <= 160 && permitted(line));
  return [...new Set(lines)].slice(0, 8);
}

export function fallbackProfile(title: string, jd: string, skills: string[], jobMeta?: FallbackJobMeta): Profile {
  const cleanTitle = permitted(title) && title.trim() ? title.trim().slice(0, 120) : '该岗位';
  const education = [...jd.matchAll(/(?:博士|硕士|研究生|本科|大专|专科|中专|高中|初中)(?:及)?(?:以上|起)/g)][0]?.[0];
  const years = jd.match(minimumYears)?.[0];
  const skillsToUse = [...new Set(skills.map((skill) => skill.trim().slice(0, 48)).filter((skill) => permitted(skill) && labelName.safeParse(skill).success))].slice(0, 3);
  const gates = [education, years].filter((item): item is string => Boolean(item));
  const deptCode = inferDepartment(cleanTitle, jobMeta?.department, jd);
  const deptDef = departmentCodeMap.get(deptCode)!;
  const levelCode = inferLevel(cleanTitle, jobMeta?.level);
  const levelDef = jobLevelMap.get(levelCode)!;
  const traitInfo = inferTrait(deptCode, levelCode, cleanTitle);
  const traitDef = careerTraitMap.get(traitInfo.code)!;
  const weights = levelCode === 'L4' || levelCode === 'L5' || levelCode === 'L6'
    ? (deptCode === 'YF' ? [20, 20, 35, 25] : DEPT_WEIGHTS.GL)
    : DEPT_WEIGHTS[deptCode];

  const location = jobMeta?.location?.trim() && permitted(jobMeta.location.trim()) ? jobMeta.location.trim().slice(0, 80) : undefined;
  const department = jobMeta?.department?.trim() && permitted(jobMeta.department.trim()) ? jobMeta.department.trim().slice(0, 60) : deptDef.label;

  const extractedResp = extractResponsibilities(jobMeta?.description, jobMeta?.requirements);
  const responsibilities = extractedResp.length >= 2 ? extractedResp : [
    `承担${cleanTitle}的核心业务推进与日常高质量交付`,
    `按${levelDef.name}标准落实工作计划、节点跟进与结果复盘`,
    '维护工作台账与过程文档，确保交付口径一致、信息可追溯',
    '协同上下游团队高效对接，及时同步进展并预警关键风险',
    '结合业务反馈持续优化工作方法与工具效率',
  ];

  const bgLabels: LabelPreset[] = [
    {
      name: '学历与专业基础',
      tiers: {
        E: '缺少岗位所需基础知识储备',
        D: '具备部分基础但与岗位方向偏差较大',
        C: education ? `达到${education}及对应岗位专业基础（达标）` : '具备胜任岗位所需的教育或专业知识基础（达标）',
        B: '专业背景高度对口，理论与实务结合扎实',
        A: '具备系统化专业深度并能跨领域迁移应用',
      },
    },
    {
      name: '经验与业务相关性',
      tiers: {
        E: '无相关岗位实践经历',
        D: '仅参与过边缘协助，未独立承接核心事务',
        C: years ? `具备${years}相关实战经验并能独立上岗（达标）` : `有与${cleanTitle}高度相关的实战交付经历（达标）`,
        B: '有同类复杂项目完整交付成果与可验证业绩',
        A: '在同行业具备标杆项目经验并能沉淀体系方法',
      },
    },
    {
      name: `职业特质（${traitDef.code} ${traitDef.name}）`,
      tiers: {
        E: '工作风格与岗位核心特质明显冲突',
        D: '偶有符合表现，压力场景下不够稳定',
        C: `契合${traitDef.name}特质，能稳定发挥「${traitDef.strength}」优势（达标）`,
        B: '特质优势突出，能在复杂情境下主动发挥价值',
        A: '兼具特质优势与圆融调节力，可带动周边成员',
      },
    },
  ];

  const attLabels: LabelPreset[] = levelCode === 'L1' || levelCode === 'L2'
    ? [
        { name: '上进心与学习力', tiers: { E: '不愿学习新工具或新流程', D: '仅在明确要求下被动学习', C: '主动学习岗位技能并按要求持续精进（达标）', B: '自驱钻研业务并能举一反三提效', A: '持续超前学习并能整理经验分享团队' } },
        { name: '守规与执行担当', tiers: { E: '经常忽视流程、推诿扯皮', D: '偶有漏项或情绪化抱怨，需反复提醒', C: '遵守流程纪律，按质按时完成交代任务（达标）', B: '主动闭环并关注下游衔接质量', A: '以高标准自我要求并主动发现流程隐患' } },
        { name: '职业成熟度', tiers: { E: '依赖全程盯办，抗压能力薄弱', D: '能完成常规事务，遇变化易慌乱', C: '情绪稳定、边界清晰，能独立应对日常波动（达标）', B: '面对压力能理性拆解问题并主动汇报方案', A: '成熟稳重、结果导向，具备向上补位意识' } },
      ]
    : [
        { name: '结果导向与担当', tiers: { E: '只关注过程动作、回避结果责任', D: '目标感较弱，遇到阻力容易放缓', C: '围绕岗位核心目标持续推进并按期交付（达标）', B: '面对高难度目标主动攻坚、拿得出硬结果', A: '敢扛关键指标，能在不确定中开拓局面' } },
        { name: '复盘改进与学习力', tiers: { E: '同类问题反复出现，不愿接受反馈', D: '接受反馈但较少转化为后续改进', C: '能定期复盘交付得失并迭代工作方法（达标）', B: '主动吸收行业新方法与 AI 工具提升产出', A: '将个人经验沉淀为组织机制与复用规范' } },
        { name: '抗压与职业稳定度', tiers: { E: '压力下易情绪化或中断协作', D: '常态稳定但紧急场景下节奏易乱', C: '节奏稳健，在多任务和变化下保持专业判断（达标）', B: '高压场景下冷静协调并稳定团队预期', A: '具备强韧性与长期主义，持续创造复利价值' } },
      ];

  const skillPresets: LabelPreset[] = skillsToUse.map((skill) => ({
    name: skill,
    tiers: {
      E: `未实际使用过 ${skill}`,
      D: `了解 ${skill} 基础概念，需指导完成任务`,
      C: `能在日常工作中独立熟练运用 ${skill} 完成交付（达标）`,
      B: `能用 ${skill} 解决复杂问题并优化质量或效率`,
      A: `精通 ${skill} 体系化应用并能制定规范指导他人`,
    },
  }));
  const techLabels = [...skillPresets, ...departmentTechLabels(deptCode)]
    .filter((item, idx, arr) => arr.findIndex((other) => other.name === item.name) === idx)
    .slice(0, 6);

  const colLabels: LabelPreset[] = [
    { name: '沟通与信息同步', tiers: { E: '被动沟通，关键异常不主动通报', D: '能回复询问但表述不够聚焦清晰', C: '主动同步进度与风险，信息表达准确高效（达标）', B: '能跨角色对齐目标并推动多方达成共识', A: '能搭建高效沟通机制，显著降低协作摩擦' } },
    { name: '计划与节点推进', tiers: { E: '缺少工作计划，频繁临期延误', D: '有大致安排但缺少拆解与跟进', C: '制定清晰周/月计划，关键节点按期闭环（达标）', B: '善于统筹多线程任务并提前化解卡点', A: '能主导跨部门复杂项目排期与落地' } },
    { name: '流程规范与协作意识', tiers: { E: '忽视规范，个人习惯影响上下游', D: '提醒后可按规范配合协作', C: '自觉遵守协作规范，及时交付可复用文档/产物（达标）', B: '主动补位协助团队并持续优化交接流程', A: '以身作则推动团队规范落地与协同提效' } },
  ];

  const allGroups = [bgLabels, attLabels, techLabels, colLabels] as const;

  return {
    meta: compactMeta({
      code: `${deptCode}-${levelCode}`,
      department_code: deptCode,
      department,
      level: levelCode,
      level_name: levelDef.name,
      level_tagline: levelDef.tagline,
      location,
    }),
    positioning: `${cleanTitle}（${levelDef.code} ${levelDef.name}）：负责${department}核心职责落实、专业交付与跨角色协作，确保关键业务目标按期达成。`,
    responsibilities,
    hard_gates: gates.map((condition) => ({ condition, how: '核对简历中的明确资料' })),
    indicators: DIMENSIONS.map((name, index) => {
      const targetWeight = weights[index]!;
      const group = allGroups[index]!;
      return {
        name,
        weight: targetWeight,
        labels: group.map((preset, position) => ({
          name: preset.name,
          weight: distribute(targetWeight, group.length, position),
          tiers: { ...preset.tiers },
        })),
      };
    }),
    trait_match: {
      code: traitDef.code,
      name: traitDef.name,
      combo: traitDef.combo,
      reason: traitInfo.reason,
    },
    redlines: [],
    bonus: [],
    not_wanted: [],
    compliance_rewritten: forbiddenAttribute.test(jd) || undefined,
  };
}

const gate = z.object({ condition: text, result: z.enum(['pass', 'fail', 'unknown']), quote: rawQuote });
const label = z.object({ indicator: text, label: text, level: levels, quote: rawQuote });
const point = z.object({ point: text, quote: rawQuote });
const redline = z.object({ condition: text, quote: rawQuote });
const resumeExcerpt = z.object({ quote: z.string().trim().min(4).max(280) });
const forbiddenSummaryText = /(?:推进|进入|安排|通过|拒绝|跳过)(?:到)?(?:初试|复试|面试|筛选)|(?:建议|推荐|应该|不宜)\s*(?:约面|面试|推进|归档|拒绝|通过)/;
const contactDetails = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?<!\d)1[3-9]\d(?:[ ().-]*\d){8}(?!\d)|(?:联系方式|联系电话|手机号码|电话|手机|微信|邮箱|\b(?:phone|mobile|tel(?:ephone)?|e-?mail|wechat))\s*:/i;
const aiScreening = z.object({
  resume_excerpts: z.unknown().optional(),
  gates: z.array(z.unknown()).max(80).default([]), labels: z.array(z.unknown()).max(80).default([]),
  redlines: z.array(z.unknown()).max(20).default([]), concerns: z.array(z.unknown()).max(30).default([]),
  top_reason: z.unknown().optional(), reject_reason: z.unknown().optional(),
});
export type Label = z.infer<typeof label>;
type Gate = z.infer<typeof gate>;
export interface ScreeningDetail {
  mode: 'ai' | 'fallback';
  gates: Gate[];
  labels: Label[];
  redlines: z.infer<typeof redline>[];
  concerns: z.infer<typeof point>[];
  top_reason: string | null;
  reject_reason: (typeof REJECTION_REASONS)[number] | null;
  dropped: number;
  skill_matches?: { matched: number; total: number };
  resume_excerpts?: string[];
}

const quoteExists = (quote: string | null | undefined, source: string): quote is string =>
  Boolean(quote?.trim() && permitted(quote) && source.includes(quote));
const keyOf = (indicator: string, labelName: string) => JSON.stringify([indicator, labelName]);
export const profileLabels = (profile: Profile) => profile.indicators.flatMap(({ name, labels }) =>
  labels.map((item) => ({ indicator: name, label: item.name, weight: item.weight })));

export function validateScreening(value: unknown, profile: Profile, resume: string, approved: boolean): ScreeningDetail | undefined {
  const { data } = aiScreening.safeParse(value);
  if (!data) return;
  let dropped = 0;
  const validGates = new Map<string, Gate>();
  const validLabels = new Map<string, Label>();
  const allowedGates = new Set(profile.hard_gates.map(({ condition }) => condition));
  const allowedLabels = new Set(profileLabels(profile).map((item) => keyOf(item.indicator, item.label)));
  for (const raw of data.gates) {
    const item = gate.safeParse(raw).data;
    if (!item || !allowedGates.has(item.condition) || validGates.has(item.condition)
      || (item.result !== 'unknown' && !quoteExists(item.quote, resume))
      || (item.quote != null && !quoteExists(item.quote, resume))) { dropped++; continue; }
    validGates.set(item.condition, { ...item, quote: item.quote ?? null });
  }
  for (const raw of data.labels) {
    const item = label.safeParse(raw).data;
    const key = item && keyOf(item.indicator, item.label);
    if (!item || !key || !approved || !allowedLabels.has(key) || validLabels.has(key)
      || (item.level !== 'unknown' && !quoteExists(item.quote, resume))
      || (item.quote != null && !quoteExists(item.quote, resume))) { dropped++; continue; }
    validLabels.set(key, { ...item, quote: item.quote ?? null });
  }
  const redlines = data.redlines.flatMap((raw) => {
    const item = redline.safeParse(raw).data;
    if (!item || !profile.redlines.includes(item.condition) || !quoteExists(item.quote, resume)) { dropped++; return []; }
    return [item];
  });
  const concerns = data.concerns.flatMap((raw) => {
    const item = point.safeParse(raw).data;
    if (!item || !permitted(item.point) || !quoteExists(item.quote, resume)) { dropped++; return []; }
    return [item];
  });
  const selectedExcerpts = z.array(z.unknown()).max(4).safeParse(data.resume_excerpts).data;
  if (data.resume_excerpts !== undefined && !selectedExcerpts) dropped++;
  const excerpts = new Set<string>();
  if (selectedExcerpts?.length) {
    const sentences = new Set(resume.split(/(?<=[。！？!?])|(?<=\.)(?=\s|$)(?![ \t]*\d)|[\r\n]+/u).map((part) => part.trim()));
    for (const raw of selectedExcerpts) {
      const item = resumeExcerpt.safeParse(raw).data;
      const matches = item ? [...sentences].filter((sentence) => sentence.includes(item.quote)) : [];
      const sentence = matches.length === 1 ? matches[0] : undefined;
      const normalized = sentence?.normalize('NFKC');
      // Recover the whole sentence so a short selection cannot omit a qualifier such as “assisted”.
      if (!sentence || !normalized || sentence.length > 280 || !permitted(normalized)
        || forbiddenSummaryText.test(normalized) || contactDetails.test(normalized) || excerpts.has(sentence)) {
        dropped++;
        continue;
      }
      excerpts.add(sentence);
    }
  }
  // Derive the displayed reason from a verified profile item and its source text.
  const strongest = [...validLabels.values()].find((item) => item.level === 'A' || item.level === 'B')
    ?? [...validLabels.values()].find((item) => item.level !== 'unknown')
    ?? [...validGates.values()].find((item) => item.result !== 'unknown');
  if (typeof data.top_reason === 'string' && !permitted(data.top_reason)) dropped++;
  return {
    mode: 'ai', dropped, redlines, concerns, resume_excerpts: [...excerpts],
    gates: profile.hard_gates.map(({ condition }) => validGates.get(condition) ?? { condition, result: 'unknown', quote: null }),
    labels: approved ? profileLabels(profile).map(({ indicator, label: labelName }) =>
      validLabels.get(keyOf(indicator, labelName)) ?? { indicator, label: labelName, level: 'unknown', quote: null }) : [],
    top_reason: strongest?.quote ?? null,
    reject_reason: [...validGates.values()].some(({ result }) => result === 'fail') || redlines.length
      ? z.enum(REJECTION_REASONS).safeParse(data.reject_reason).data ?? null : null,
  };
}

export function fallbackScreening(profile: Profile, resume: string, education: string | null, years: number | null, skills: string[]): ScreeningDetail {
  const gates = profile.hard_gates.map(({ condition }): Gate => {
    const requiredYears = condition.match(minimumYears);
    const requiredEducation = condition.match(EDU)?.[0];
    const educationOnly = /^(?:[\u4e00-\u9fa5]{2,4})(?:及)?(?:以上|起)(?:学历)?$/.test(condition);
    let result: Gate['result'] = 'unknown';
    let quote: string | null = null;
    if (requiredYears && requiredYears[0] === condition) {
      const explicitYears = resume.match(/(\d{1,2})(?:\.\d+)?\s*年(?:以上)?(?:的)?(?:工作经验|工作经历|工作年限)/);
      if (explicitYears) quote = explicitYears[0];
      const actualYears = explicitYears ? Number(explicitYears[0].match(/\d+(?:\.\d+)?/)?.[0]) : years;
      if (actualYears !== null) result = actualYears >= Number(requiredYears[1] ?? requiredYears[2]) ? 'pass' : 'fail';
    } else if (requiredEducation && educationOnly) {
      const actual = education?.match(EDU)?.[0] ?? resume.match(/(?:最高学历|学历)\s*[:：]?\s*(博士|硕士|研究生|本科|大专|专科|中专|高中|初中)/)?.[1];
      if (actual && EDU_RANK[actual] !== undefined) {
        result = EDU_RANK[actual] >= EDU_RANK[requiredEducation]! ? 'pass' : 'fail';
        if (resume.includes(actual)) quote = actual;
      }
    }
    return { condition, result, quote };
  });
  const keywords = [...new Set(skills.filter((item) => item.trim() && permitted(item)))];
  const matched = keywords.filter((skill) => resume.toLowerCase().includes(skill.toLowerCase())).length;
  const parts = [`技能命中 ${matched}/${keywords.length}`];
  if (years !== null) parts.push(`${years} 年`);
  if (gates.some((item) => item.result === 'pass' && item.condition.match(EDU))) parts.push('学历达标');
  return { mode: 'fallback', gates, labels: [], redlines: [], concerns: [], dropped: 0, top_reason: parts.join(' · '), reject_reason: null,
    skill_matches: { matched, total: keywords.length } };
}

const coefficients = { E: 0, D: 0.5, C: 1, B: 1.5, A: 2 };
export function scoreScreening(detail: ScreeningDetail, profile: Profile) {
  let weightedScore = 0;
  let knownWeight = 0;
  let unknownWeight = 0;
  if (detail.mode === 'ai' && detail.labels.length) {
    for (const item of profileLabels(profile)) {
      const level = detail.labels.find((row) => row.indicator === item.indicator && row.label === item.label)?.level;
      if (!level || level === 'unknown') unknownWeight += item.weight;
      else {
        knownWeight += item.weight;
        weightedScore += item.weight * coefficients[level];
      }
    }
  }
  const missingGates = detail.gates.filter(({ result }) => result !== 'pass').map(({ condition }) => condition);
  const redlineHit = [...new Set(detail.redlines.map(({ condition }) => condition))];
  const score = knownWeight ? Math.round(weightedScore / knownWeight * 100) : null;
  const verdict = missingGates.length || redlineHit.length ? 'mismatch' : score === null ? null
    : score < 80 ? 'mismatch' : score > 120 ? 'overqualified' : 'match';
  return { score, verdict, unknownWeight, missingGates, redlineHit };
}

export const suggestedDecision = z.enum(['advance', 'negotiate', 'reject']);
const checkedLabel = z.object({ indicator: text, label: text, evidence: z.enum(['strong', 'weak', 'none']), quote: rawQuote });
const summaryPoint = point.extend({ at: z.string().regex(/^\d{1,2}:\d{2}(?::\d{2})?$/).nullish().catch(null) });
const summarySchema = z.object({
  headline: text, highlights: z.array(z.unknown()).max(30).default([]), concerns: z.array(z.unknown()).max(30).default([]),
  unanswered: z.array(z.unknown()).max(30).default([]), indicators_checked: z.array(z.unknown()).max(80).default([]),
  suggested: suggestedDecision.nullish().catch(null), reason: text.nullish().catch(null),
});
export interface SummaryData {
  headline: string;
  highlights: z.infer<typeof summaryPoint>[];
  concerns: z.infer<typeof summaryPoint>[];
  unanswered: string[];
  indicators_checked: Omit<z.infer<typeof checkedLabel>, 'quote'>[];
  suggested: z.infer<typeof suggestedDecision> | null;
  reason: string | null;
  dropped: number;
}

export function validateSummary(value: unknown, transcript: string, profile: Profile): SummaryData | undefined {
  const { data } = summarySchema.safeParse(value);
  if (!data) return;
  let dropped = 0;
  const checkPoints = (items: unknown[]) => items.flatMap((raw) => {
    const item = summaryPoint.safeParse(raw).data;
    if (!item || !permitted(item.point) || !quoteExists(item.quote, transcript)) { dropped++; return []; }
    return [{ ...item, at: item.at && transcript.includes(item.at) ? item.at : null }];
  });
  const highlights = checkPoints(data.highlights);
  const concerns = checkPoints(data.concerns);
  const unanswered = data.unanswered.flatMap((raw) => {
    const item = text.safeParse(raw).data;
    if (!item || !permitted(item)) { dropped++; return []; }
    return [item];
  });
  const acceptedQuotes = [...highlights, ...concerns].map((item) => item.quote);
  const allowed = new Map(profileLabels(profile).map((item) => [keyOf(item.indicator, item.label), item]));
  const checked = new Map<string, z.infer<typeof checkedLabel>>();
  for (const raw of data.indicators_checked) {
    const item = checkedLabel.safeParse(raw).data;
    const key = item && keyOf(item.indicator, item.label);
    if (!item || !key || !allowed.has(key) || checked.has(key)
      || (item.evidence !== 'none' && (!quoteExists(item.quote, transcript) || !acceptedQuotes.includes(item.quote)))) { dropped++; continue; }
    checked.set(key, item);
  }
  const hasEvidence = acceptedQuotes.length > 0;
  if (!permitted(data.headline)) dropped++;
  if (data.reason && !permitted(data.reason)) dropped++;
  return {
    headline: hasEvidence && permitted(data.headline) ? data.headline : '本轮暂无可核实的面试结论',
    highlights, concerns, unanswered,
    indicators_checked: [...allowed].map(([key, item]) => ({
      indicator: item.indicator, label: item.label, evidence: checked.get(key)?.evidence ?? 'none',
    })),
    suggested: hasEvidence ? data.suggested ?? null : null,
    reason: hasEvidence && data.reason && permitted(data.reason) ? data.reason : null,
    dropped,
  };
}

const question = z.object({ question: text, listen_for: text, follow_up: text });
export function validatePlan(value: unknown) {
  const parsed = z.object({ questions: z.array(question).length(5) }).safeParse(value).data;
  if (parsed && parsed.questions.every((item) => Object.values(item).every(permitted))) return parsed;
}

const round = z.union([z.literal(1), z.literal(2)]);
const comparativePoint = z.object({ point: text, from: z.union([z.tuple([z.literal(1)]), z.tuple([z.literal(2)]), z.tuple([z.literal(1), z.literal(2)])]),
  evidence: z.array(z.object({ round, quote: z.string().max(1200) })).min(1).max(4) });
const compositeSchema = z.object({
  headline: text, confirmed: z.array(z.unknown()).max(30).default([]), conflicts: z.array(z.unknown()).max(30).default([]),
  recommendation: z.enum(['proceed', 'reject']).nullish().catch(null), reason: text.nullish().catch(null),
});
export function validateComposite(value: unknown, profile: Profile, summaries: [SummaryData, SummaryData], transcripts: [string, string]) {
  const { data } = compositeSchema.safeParse(value);
  if (!data) return;
  let dropped = 0;
  const quotes = summaries.map((summary) => [...summary.highlights, ...summary.concerns].map(({ quote }) => quote));
  const points = (items: unknown[]) => items.flatMap((raw) => {
    const item = comparativePoint.safeParse(raw).data;
    if (!item || !permitted(item.point) || item.from.some((round) => !item.evidence.some((entry) => entry.round === round))
      || item.evidence.some(({ round, quote }) => !item.from.some((ref) => ref === round)
        || !quotes[round - 1]?.includes(quote) || !quoteExists(quote, transcripts[round - 1] ?? ''))) { dropped++; return []; }
    return [item];
  });
  const confirmed = points(data.confirmed);
  const conflicts = points(data.conflicts);
  const hasEvidence = confirmed.length > 0 || conflicts.length > 0;
  if (!permitted(data.headline)) dropped++;
  if (data.reason && !permitted(data.reason)) dropped++;
  const covered = new Set(summaries.flatMap(({ indicators_checked }) => indicators_checked
    .filter(({ evidence }) => evidence !== 'none').map(({ indicator, label }) => keyOf(indicator, label))));
  return {
    headline: hasEvidence && permitted(data.headline) ? data.headline : '两轮面试暂无可核实的综合结论',
    confirmed, conflicts,
    uncovered: profileLabels(profile).flatMap(({ indicator, label }) => covered.has(keyOf(indicator, label))
      ? [] : [{ indicator, label, why: '两轮均无已验证证据' }]),
    recommendation: hasEvidence ? data.recommendation ?? null : null,
    reason: hasEvidence && data.reason && permitted(data.reason) ? data.reason : null,
    dropped,
  };
}
