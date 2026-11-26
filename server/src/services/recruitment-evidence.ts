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
export const levels = z.enum(['E', 'D', 'C', 'B', 'A', 'unknown']);
const tiersSchema = z.object({ E: text, D: text, C: text, B: text, A: text });
const weight = z.number().int().min(0).max(100);
export const profileSchema = z.object({
  positioning: text,
  hard_gates: z.array(z.object({ condition: conditionText, how: text })).max(6),
  indicators: z.array(z.object({
    name: z.enum(DIMENSIONS), weight,
    labels: z.array(z.object({ name: labelName, weight, tiers: tiersSchema })).min(3).max(6),
  })).length(DIMENSIONS.length),
  redlines: z.array(conditionText).max(3),
  bonus: z.array(text).max(3),
  not_wanted: z.array(text).max(3),
  weights_adjusted: z.boolean().optional(),
  compliance_rewritten: z.boolean().optional(),
});
export type Profile = z.infer<typeof profileSchema>;

function distribute(total: number, count: number, index: number): number {
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
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
  if (!generated && ![data.positioning, ...data.hard_gates.flatMap(({ condition, how }) => [condition, how]), ...data.redlines,
    ...data.bonus, ...data.not_wanted, ...data.indicators.flatMap(({ labels }) => labels.flatMap(({ name, tiers }) => [name, ...Object.values(tiers)]))].every(permitted)) return;
  const filterItems = (items: string[]) => items.filter((item) => {
    if (permitted(item)) return true;
    complianceRewritten = true;
    return false;
  });
  const positioning = clean(data.positioning, '依据职责与岗位能力要求完成工作');
  const hardGates = data.hard_gates.filter(({ condition }) => filterItems([condition]).length > 0)
    .map(({ condition, how }) => ({ condition, how: clean(how, '核对简历及可核实的工作经历') }));
  if (new Set(hardGates.map(({ condition }) => condition)).size !== hardGates.length) return;
  return {
    positioning, hard_gates: hardGates, indicators,
    redlines: filterItems(data.redlines), bonus: filterItems(data.bonus), not_wanted: filterItems(data.not_wanted),
    get weights_adjusted() { return weightsAdjusted || undefined; },
    get compliance_rewritten() { return complianceRewritten || undefined; },
  };
}

const generatedLabel = z.tuple([labelName, weight, text, text, text, text, text]);
const generatedLabels = z.array(generatedLabel).length(3);
const generatedProfileSchema = profileSchema.pick({
  positioning: true, hard_gates: true, redlines: true, bonus: true, not_wanted: true,
}).extend({
  weights: z.tuple([weight, weight, weight, weight]),
  background: generatedLabels,
  attitude: generatedLabels,
  technical: generatedLabels,
  collaboration: generatedLabels,
});

export function normalizeGeneratedProfile(value: unknown, jd: string, titleOnly: boolean): Profile | undefined {
  const parsed = generatedProfileSchema.safeParse(value);
  if (!parsed.success) return;
  const { weights, background, attitude, technical, collaboration, hard_gates, redlines, ...content } = parsed.data;
  const groups = [background, attitude, technical, collaboration] as const;
  return normalizeProfile({
    ...content,
    hard_gates: titleOnly ? [] : hard_gates,
    redlines: titleOnly ? [] : redlines,
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
const defaultLabels = [
  ['工作经历相关性', '职业知识基础', '资格与训练'],
  ['主动推进', '质量意识', '反馈与学习'],
  ['岗位相关技能', '任务执行', '问题解决'],
  ['沟通协作', '计划与跟进', '跨团队协调'],
];

const EDU = /博士|硕士|研究生|本科|大专|专科|中专|高中|初中/g;
const EDU_RANK: Record<string, number> = { 初中: 0, 高中: 1, 中专: 1, 专科: 2, 大专: 2, 本科: 3, 研究生: 4, 硕士: 4, 博士: 5 };
const minimumYears = /(?:至少\s*)?(\d{1,2})\s*年\s*(?:及以上|以上|起|\+)|(?:不少于|至少|最低)\s*(\d{1,2})\s*年/;
export function fallbackProfile(title: string, jd: string, skills: string[]): Profile {
  const education = [...jd.matchAll(/(?:博士|硕士|研究生|本科|大专|专科|中专|高中|初中)(?:及)?(?:以上|起)/g)][0]?.[0];
  const years = jd.match(minimumYears)?.[0];
  const skillsToUse = [...new Set(skills.map((skill) => skill.trim().slice(0, 48)).filter((skill) => permitted(skill) && labelName.safeParse(skill).success))].slice(0, 3);
  const gates = [education, years].filter((item): item is string => Boolean(item));
  return {
    positioning: permitted(title) && title.trim() ? `${title.slice(0, 280)}的岗位职责与能力要求` : '岗位职责与能力要求',
    hard_gates: gates.map((condition) => ({ condition, how: '核对简历中的明确资料' })),
    indicators: DIMENSIONS.map((name, index) => ({
      name, weight: 25,
      labels: (index === 2 ? [...new Set([...skillsToUse, ...defaultLabels[index]!])].slice(0, 6) : defaultLabels[index]!)
        .map((name, position, labels) => ({ name, weight: distribute(25, labels.length, position), tiers: { ...objectiveTiers } })),
    })),
    redlines: [], bonus: [], not_wanted: [], compliance_rewritten: forbiddenAttribute.test(jd) || undefined,
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
