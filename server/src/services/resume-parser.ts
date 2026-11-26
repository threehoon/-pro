import { AppError, badRequest } from '../lib/errors.ts';

export type ResumeKind = 'pdf' | 'docx' | 'txt';

export interface ParsedFields {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  current_company?: string;
  current_title?: string;
  years_experience?: number;
  education?: string;
  school?: string;
  major?: string;
  skills: string[];
  links: string[];
  summary?: string;
}

export interface ParsedResume {
  kind: ResumeKind;
  text: string;
  chars: number;
  pages?: number;
  fields: ParsedFields;
  warnings: string[];
  /** 0-1，仅表示「有多少关键字段被规则命中」，不代表候选人质量。 */
  confidence: number;
}

/**
 * 基础简历解析：只做文本抽取 + 规则/词典匹配，不调用任何模型。
 * 解析结果在前端始终可编辑，规则命中不会直接落库。
 */
export async function parseResume(input: {
  buffer: Buffer;
  filename: string;
  kind?: ResumeKind;
  strictText?: boolean;
}): Promise<ParsedResume> {
  const kind = input.kind ?? detectKind(input.filename, '');
  const { text, pages } = await extractText({ ...input, kind });
  const normalized = normalize(text);
  const warnings: string[] = [];

  if (normalized.length < 120) {
    warnings.push('可提取文字很少，可能是扫描件或图片型 PDF，建议人工补充信息。');
  }

  // 只对前 20000 字做字段规则匹配：既是返回文本的口径，也避免超长文本上的正则开销
  const fields = extractFields(normalized.slice(0, 20000), warnings);
  const confidence = scoreConfidence(fields);

  return {
    kind,
    text: normalized.slice(0, 20000),
    chars: normalized.length,
    pages,
    fields,
    warnings,
    confidence,
  };
}

export function detectKind(filename: string, mime: string): ResumeKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'txt';
  if (lower.endsWith('.doc')) {
    throw new AppError(415, 'legacy_doc_unsupported', '旧版 .doc 暂不支持，请另存为 PDF 或 DOCX 后再上传');
  }
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('wordprocessingml')) return 'docx';
  if (mime.startsWith('text/')) return 'txt';
  throw new AppError(415, 'unsupported_file', '仅支持 PDF、DOCX、TXT 格式的简历');
}

async function extractText(input: {
  buffer: Buffer;
  filename: string;
  kind: ResumeKind;
  strictText?: boolean;
}): Promise<{ text: string; pages?: number }> {
  try {
    if (input.kind === 'pdf') return await extractPdf(input.buffer);
    if (input.kind === 'docx') return await extractDocx(input.buffer);
    if (!input.strictText) return { text: input.buffer.toString('utf8') };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input.buffer);
    } catch {
      throw badRequest('无法读取文本简历，请另存为 UTF-8 或使用 PDF、DOCX');
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw badRequest('文本简历包含非文本内容，请重新导出文件');
    }
    return { text };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw badRequest(
      `简历内容读取失败：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }
}

async function extractPdf(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const init = {
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0];
  const doc = await pdfjs.getDocument(init).promise;
  const chunks: string[] = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    let line = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        chunks.push(line.trim());
        line = '';
      } else {
        line += ' ';
      }
    }
    if (line.trim()) chunks.push(line.trim());
  }
  await doc.destroy();
  return { text: chunks.join('\n'), pages: doc.numPages };
}

async function extractDocx(buffer: Buffer): Promise<{ text: string }> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value };
}

function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length)
    .join('\n')
    .trim();
}

const CITY_LIST = [
  '北京', '上海', '深圳', '广州', '杭州', '成都', '武汉', '南京', '苏州', '西安',
  '重庆', '天津', '长沙', '郑州', '青岛', '大连', '厦门', '合肥', '济南', '福州',
  '珠海', '东莞', '佛山', '宁波', '无锡', '常州', '沈阳', '哈尔滨', '昆明', '南昌',
  '香港', '澳门', '台北', '新加坡', '东京', '首尔', '伦敦', '纽约', '旧金山', '西雅图',
];

const EDUCATION_RANK: Array<[RegExp, string]> = [
  [/博士|ph\.?d|doctor/i, '博士'],
  [/硕士|研究生|mba|master/i, '硕士'],
  [/本科|学士|bachelor|undergraduate/i, '本科'],
  [/大专|专科|associate/i, '大专'],
  [/高中|中专|职高/i, '高中'],
];

const SKILL_DICTIONARY: Array<[string, string[]]> = [
  ['JavaScript', ['javascript', 'js', 'es6']],
  ['TypeScript', ['typescript', 'ts']],
  ['React', ['react', 'react.js', 'reactjs']],
  ['Vue', ['vue', 'vue.js', 'vuejs']],
  ['Next.js', ['next.js', 'nextjs']],
  ['Node.js', ['node.js', 'nodejs', 'node']],
  ['Java', ['java']],
  ['Spring Boot', ['spring boot', 'springboot', 'spring']],
  ['Go', ['golang', 'go 语言', 'go语言']],
  ['Python', ['python']],
  ['C++', ['c++', 'cpp']],
  ['C#', ['c#', '.net', 'dotnet']],
  ['PHP', ['php']],
  ['Rust', ['rust']],
  ['Kotlin', ['kotlin']],
  ['Swift', ['swift']],
  ['Flutter', ['flutter']],
  ['React Native', ['react native']],
  ['MySQL', ['mysql']],
  ['PostgreSQL', ['postgresql', 'postgres']],
  ['Redis', ['redis']],
  ['MongoDB', ['mongodb', 'mongo']],
  ['Elasticsearch', ['elasticsearch', 'es 搜索']],
  ['Kafka', ['kafka']],
  ['Docker', ['docker', '容器化']],
  ['Kubernetes', ['kubernetes', 'k8s']],
  ['AWS', ['aws', '亚马逊云']],
  ['阿里云', ['阿里云', 'aliyun']],
  ['微服务', ['微服务', 'microservice']],
  ['分布式系统', ['分布式']],
  ['高并发', ['高并发']],
  ['数据分析', ['数据分析', 'data analysis']],
  ['数据挖掘', ['数据挖掘', 'data mining']],
  ['机器学习', ['机器学习', 'machine learning', 'ml']],
  ['深度学习', ['深度学习', 'deep learning']],
  ['大模型', ['大模型', 'llm', 'large language model']],
  ['SQL', ['sql']],
  ['Tableau', ['tableau']],
  ['Power BI', ['power bi', 'powerbi']],
  ['Excel', ['excel', '电子表格']],
  ['SPSS', ['spss']],
  ['产品设计', ['产品设计', 'product design']],
  ['需求分析', ['需求分析', '需求管理']],
  ['用户研究', ['用户研究', 'user research']],
  ['Axure', ['axure']],
  ['Figma', ['figma']],
  ['Sketch', ['sketch']],
  ['Photoshop', ['photoshop', 'ps ']],
  ['Illustrator', ['illustrator', 'ai 设计']],
  ['UI 设计', ['ui 设计', 'ui设计', 'ui design']],
  ['交互设计', ['交互设计', 'interaction design']],
  ['视觉设计', ['视觉设计', 'visual design']],
  ['品牌设计', ['品牌设计', 'branding']],
  ['项目管理', ['项目管理', 'project management', 'pmp']],
  ['敏捷开发', ['敏捷', 'scrum', 'agile']],
  ['OKR', ['okr', 'kpi 管理']],
  ['招聘', ['招聘', 'recruit', 'talent acquisition']],
  ['薪酬绩效', ['薪酬', '绩效', 'compensation']],
  ['员工关系', ['员工关系', 'employee relations']],
  ['培训发展', ['培训', '组织发展', 'od']],
  ['销售管理', ['销售管理', 'sales management']],
  ['大客户销售', ['大客户', 'key account']],
  ['商务谈判', ['商务谈判', 'negotiation']],
  ['渠道拓展', ['渠道', 'channel']],
  ['市场推广', ['市场推广', 'marketing']],
  ['内容运营', ['内容运营', 'content marketing']],
  ['新媒体运营', ['新媒体', 'social media']],
  ['增长', ['增长', 'growth']],
  ['SEO', ['seo', '搜索引擎优化']],
  ['SEM', ['sem', '竞价']],
  ['财务分析', ['财务分析', 'financial analysis']],
  ['预算管理', ['预算', 'budget']],
  ['审计', ['审计', 'audit']],
  ['法务合规', ['法务', '合规', 'compliance']],
  ['供应链', ['供应链', 'supply chain']],
  ['英语', ['英语', 'english', 'cet-6', 'cet6', '雅思', '托福']],
  ['日语', ['日语', 'japanese', 'n1', 'n2']],
  ['沟通协作', ['沟通', '协作', 'cross-functional']],
  ['团队管理', ['团队管理', '带团队', 'team lead', '管理团队']],
];

const SKILL_LOOKUP: Array<{ canonical: string; needle: string }> = SKILL_DICTIONARY.flatMap(
  ([canonical, aliases]) => aliases.map((alias) => ({ canonical, needle: alias })),
);

/**
 * 专业名比院校名难识别：既可能写「专业：软件工程」，也可能只是教育经历那一行里的一个片段
 * （「2015-2019　同济大学　软件工程　本科」）。这里先认显式标签，再从同一行里剔除
 * 时间段 / 院校 / 学历后取剩下的那一段。
 */
function extractMajor(
  text: string,
  schoolLine: string | undefined,
  school: string | undefined,
): string | undefined {
  const labelled =
    text.match(/(?:专业|主修|所学专业)[:：\s]*([^\n，,。;；|]{2,24})/)?.[1] ??
    schoolLine?.match(/[（(]([^）)]{2,20})[）)]/)?.[1];
  const cleaned = labelled?.trim();
  if (cleaned) return cleaned;

  if (!schoolLine) return undefined;
  const parts = schoolLine
    .split(/[\s\u3000|｜/·・]+/)
    .map((part) => part.replace(/^[（(]|[）)]$/g, '').trim())
    .filter(Boolean)
    .filter((part) => part !== school)
    .filter((part) => !/^(19|20)\d{2}([.\-/年]?(至|-|–|—|~)?((19|20)\d{2}|至今|现在)?)?$/.test(part))
    .filter((part) => !EDUCATION_RANK.some(([pattern]) => pattern.test(part)))
    .filter((part) => !/(大学|学院|学校|University|College|Institute)/i.test(part))
    .filter((part) => part.length >= 2 && part.length <= 20);

  return parts[0];
}

function extractFields(text: string, warnings: string[]): ParsedFields {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const lower = text.toLowerCase();

  // 域名各部分用互不重叠的字符类，避免在长串 a 上出现二次方回溯
  const email = text.match(/[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}/)?.[0];
  if (!email) warnings.push('未识别到邮箱，建议手动补充。');

  const phone = extractPhone(text);
  if (!phone) warnings.push('未识别到手机号，建议手动补充。');

  const name = extractName(lines);
  if (!name) warnings.push('未可靠识别姓名，请核对。');

  const location = CITY_LIST.find((city) => text.includes(city));

  const education = EDUCATION_RANK.find(([pattern]) => pattern.test(text))?.[1];
  const schoolLine = lines.find((line) =>
    /(大学|学院|学校|University|College|Institute)/i.test(line) && line.length <= 60,
  );
  const school = schoolLine
    ?.replace(/^[^：:]{1,12}[：:]\s*/, '')
    .replace(/^\s*((19|20)\d{2}\s*[.\-/年]?\s*(至|-|–|—|~)?\s*((19|20)\d{2}|至今|现在)?)\s*/, '')
    .replace(/^[\s\u3000·•]+/, '')
    .match(/(.{2,25}?(?:大学|学院|学校|University|College|Institute))/)?.[1]
    ?.trim();
  const major = extractMajor(text, schoolLine, school);

  const years = extractYears(text, lines);
  const { company, title } = extractRole(lines);
  const skills = extractSkills(lower);
  const links = Array.from(
    new Set(
      (text.match(/https?:\/\/[^\s，。；;）)]+/g) ?? []).map((link) => link.replace(/[.,]$/, '')),
    ),
  ).slice(0, 5);
  const summary = extractSummary(lines);

  return {
    name,
    email,
    phone,
    location,
    current_company: company,
    current_title: title,
    years_experience: years,
    education,
    school: school && school.length >= 2 ? school : undefined,
    major,
    skills,
    links,
    summary,
  };
}

function extractPhone(text: string): string | undefined {
  const cn = text.match(/(?:\+?86[-\s]?)?(1[3-9]\d{9})\b/);
  if (cn?.[1]) return cn[1];
  const intl = text.match(/(\+\d{1,3}[\s-]?)?\(?\d{3,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/);
  const raw = intl?.[0]?.trim();
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15 ? raw : undefined;
}

const NAME_STOPWORDS = /简历|resume|curriculum|个人|求职|应聘|基本资料|个人信息|联系方式|求职意向/i;

function extractName(lines: string[]): string | undefined {
  const candidates = lines.slice(0, 12);
  for (const line of candidates) {
    if (line.length > 30) continue;
    if (NAME_STOPWORDS.test(line)) continue;
    if (/[@\d]/.test(line)) continue;
    if (/(大学|学院|公司|有限公司|电话|邮箱|地址)/.test(line)) continue;
    const cleaned = line.replace(/^(姓名|name)[:：\s]*/i, '').trim();
    if (/^[\u4e00-\u9fa5·]{2,4}$/.test(cleaned)) return cleaned;
    if (/^[A-Z][a-zA-Z'.-]+(\s[A-Z][a-zA-Z'.-]+){1,2}$/.test(cleaned)) return cleaned;
    if (/^(姓名|name)/i.test(line)) return cleaned;
  }
  return undefined;
}

function extractYears(text: string, lines: string[]): number | undefined {
  const explicit = text.match(/(\d{1,2})\s*年(?:以上)?\s*(?:[\u4e00-\u9fa5]{0,8})?经验/);
  if (explicit?.[1]) {
    const value = Number(explicit[1]);
    if (value >= 1 && value <= 45) return value;
  }
  const ranges: Array<[number, number]> = [];
  const rangePattern = /(20\d{2})\s*[.\-/年]\s*\d{1,2}?\s*[-–—~至]\s*(20\d{2}|至今|现在)/g;
  for (const match of text.matchAll(rangePattern)) {
    const start = Number(match[1]);
    const endRaw = match[2];
    const end = endRaw && /^\d{4}$/.test(endRaw) ? Number(endRaw) : new Date().getFullYear();
    if (start >= 1990 && end >= start && end <= new Date().getFullYear() + 1) ranges.push([start, end]);
  }
  if (ranges.length === 0) {
    const workingLine = lines.find((line) => /工作经历|工作经验|experience/i.test(line));
    if (workingLine) {
      const yearsInLine = workingLine.match(/(\d{1,2})\s*年/);
      if (yearsInLine?.[1]) return Number(yearsInLine[1]);
    }
    return undefined;
  }
  const earliest = Math.min(...ranges.map(([start]) => start));
  const latest = Math.max(...ranges.map(([, end]) => end));
  const span = latest - earliest;
  return span > 0 && span <= 45 ? Math.min(span, 45) : undefined;
}

const ROLE_HINT = /(工程师|经理|总监|主管|专员|设计师|架构师|开发|运营|产品|销售|顾问|分析师|助理|负责人|Leader|Lead|Manager|Director|Engineer|Designer|Analyst|Specialist|Consultant|Intern)/i;
const COMPANY_HINT = /(公司|集团|科技|网络|信息|银行|证券|咨询|传媒|文化|教育|医疗|生物|制造|实业|有限|Inc|Ltd|LLC|Corp|Group|Technology|Technologies|Solutions)/i;

const DATE_RANGE = /^(19|20)\d{2}\s*[.\-/年]?\s*(至|-|–|—|~)?\s*((19|20)\d{2}|至今|现在)?/;

function cleanPart(raw: string): string {
  return raw
    .replace(/^[\s·•*\-–—]+/, '')
    .split(/[，,。;；（(]/)[0]!
    .trim();
}

function extractRole(lines: string[]): { company?: string; title?: string } {
  const experienceIndex = lines.findIndex((line) => /工作经历|工作经验|职业经历|experience/i.test(line));
  const scope = experienceIndex >= 0 ? lines.slice(experienceIndex + 1, experienceIndex + 30) : lines;

  let title: string | undefined;
  let company: string | undefined;

  for (const line of scope) {
    if (line.length > 90) continue;
    const parts = line
      .split(/\s*[|｜·•@]\s*|\s{2,}|\s+/)
      .map(cleanPart)
      .filter((part) => part.length > 0 && !DATE_RANGE.test(part));

    for (const part of parts) {
      if (!title && ROLE_HINT.test(part) && part.length <= 30) title = part;
      if (!company && COMPANY_HINT.test(part) && part.length <= 40) company = part;
    }
    if (!company) {
      const fallback = parts.find(
        (part) => part !== title && part.length >= 2 && part.length <= 20 && !ROLE_HINT.test(part),
      );
      if (fallback) company = fallback;
    }
    if (title && company) break;
  }

  return {
    company,
    title: title?.replace(/^(现任|目前|职位|岗位|应聘)[:：]?\s*/, ''),
  };
}

const SECTION_HEADING = /^(个人简介|自我介绍|自我评价|个人总结|职业概述|summary|profile|about me|个人优势)[:：]?$/i;

const ANY_HEADING = /^(工作经历|工作经验|项目经历|项目经验|教育背景|教育经历|技能|专业技能|技能特长|证书|荣誉|获奖|实习经历|自我评价|个人简介|自我介绍|求职意向|联系方式|education|experience|skills?|projects?)\s*[:：]?$/i;

const INLINE_HEADING = /^(个人简介|自我介绍|自我评价|个人总结|职业概述|个人优势)\s*[:：]\s*(.+)$/;

function extractSummary(lines: string[]): string | undefined {
  for (const line of lines) {
    const inline = line.match(INLINE_HEADING);
    if (inline?.[2] && inline[2].trim().length >= 12) return inline[2].trim().slice(0, 320);
  }
  const index = lines.findIndex((line) => SECTION_HEADING.test(line));
  if (index >= 0) {
    const body: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!line.trim() || ANY_HEADING.test(line.trim())) break;
      body.push(line.trim());
    }
    const text = body.join(' ');
    if (text.length >= 20) return text.slice(0, 320);
  }
  // 没有小标题时，取正文段落里最早的一段自述（跳过联系方式与标题行）
  const cutoff = lines.findIndex((line) => ANY_HEADING.test(line.trim()));
  const scope = cutoff > 0 ? lines.slice(0, cutoff) : lines;
  for (const line of scope) {
    const text = line.trim();
    if (text.length < 16 || text.length > 320) continue;
    if (/[@]|https?:\/\//.test(text)) continue;
    if (/^(19|20)\d{2}\s*[.\-/年]/.test(text)) continue;
    if (/^(个人简历|简历|resume|求职意向|应聘)/i.test(text)) continue;
    if (/\d{11}/.test(text)) continue;
    return text.slice(0, 320);
  }
  return undefined;
}

function extractSkills(lower: string): string[] {
  const found: Array<{ canonical: string; index: number }> = [];
  for (const entry of SKILL_LOOKUP) {
    const needle = entry.needle.toLowerCase();
    if (!needle) continue;
    const index = lower.indexOf(needle);
    if (index < 0) continue;
    // 纯拉丁词要求词边界，避免 "java" 命中 "javascript" 之类误报
    if (/^[a-z0-9+#. ]+$/.test(needle) && needle.length <= 4) {
      const before = lower[index - 1] ?? ' ';
      const after = lower[index + needle.length] ?? ' ';
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
    }
    found.push({ canonical: entry.canonical, index });
  }
  const seen = new Map<string, number>();
  for (const item of found) {
    const current = seen.get(item.canonical);
    if (current === undefined || item.index < current) seen.set(item.canonical, item.index);
  }
  return Array.from(seen.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([canonical]) => canonical)
    .slice(0, 20);
}

function scoreConfidence(fields: ParsedFields): number {
  const checks = [
    Boolean(fields.name),
    Boolean(fields.email),
    Boolean(fields.phone),
    Boolean(fields.location),
    Boolean(fields.current_title),
    Boolean(fields.current_company),
    Boolean(fields.education),
    fields.skills.length > 0,
    typeof fields.years_experience === 'number',
  ];
  const hit = checks.filter(Boolean).length;
  return Math.round((hit / checks.length) * 100) / 100;
}