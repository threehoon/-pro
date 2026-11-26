import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResume, detectKind } from '../src/services/resume-parser.ts';

const SAMPLE = `张小明
应聘高级前端工程师
邮箱: xiaoming.zhang@example.com 手机: 13912345678
现居上海，7年经验
教育背景：复旦大学 计算机科学与技术 本科
工作经历：
2020-2025 字节跳动 高级前端工程师，负责 React 组件库与性能优化
2018-2020 美团 前端工程师
技能：React、TypeScript、Node.js、Vite、CSS、Figma
个人简介：热爱前端工程化，主导过设计系统落地。
`;

test('detectKind 根据扩展名判断文件类型', () => {
  assert.equal(detectKind('a.pdf', ''), 'pdf');
  assert.equal(detectKind('a.docx', ''), 'docx');
  assert.equal(detectKind('a.txt', ''), 'txt');
  assert.equal(detectKind('简历.MD', ''), 'txt');
});

test('detectKind 拒绝旧版 doc', () => {
  assert.throws(() => detectKind('legacy.doc', 'application/msword'), /不支持/);
});

test('解析纯文本简历能命中关键字段', async () => {
  const result = await parseResume({
    buffer: Buffer.from(SAMPLE, 'utf8'),
    filename: 'resume.txt',
    kind: 'txt',
  });

  assert.equal(result.fields.name, '张小明');
  assert.equal(result.fields.email, 'xiaoming.zhang@example.com');
  assert.equal(result.fields.phone, '13912345678');
  assert.equal(result.fields.location, '上海');
  assert.equal(result.fields.current_company, '字节跳动');
  assert.equal(result.fields.current_title, '高级前端工程师');
  assert.equal(result.fields.years_experience, 7);
  assert.equal(result.fields.education, '本科');
  assert.equal(result.fields.school, '复旦大学');
  assert.ok(result.fields.skills.includes('React'));
  assert.ok(result.fields.skills.includes('TypeScript'));
  assert.ok(result.confidence > 0.7, `confidence=${result.confidence}`);
  assert.equal(result.warnings.length, 0);
});

test('内容过少时给出警告而不是崩溃', async () => {
  const result = await parseResume({ buffer: Buffer.from('张三', 'utf8'), filename: 'tiny.txt', kind: 'txt' });
  assert.ok(result.warnings.length > 0);
  assert.equal(result.fields.name, '张三');
});

test('纯拉丁技能词做词边界，java 不会命中 javascript', async () => {
  const result = await parseResume({
    buffer: Buffer.from('李雷\n技能：JavaScript、React\n邮箱 leilei@example.com', 'utf8'),
    filename: 'r.txt',
    kind: 'txt',
  });
  assert.ok(result.fields.skills.includes('JavaScript'));
  assert.ok(!result.fields.skills.includes('Java'));
});
test('简介在下一个章节标题处截断', async () => {
  const result = await parseResume({
    buffer: Buffer.from(SAMPLE, 'utf8'),
    filename: 'resume.txt',
  });
  assert.ok(!result.fields.summary?.includes('字节跳动'), `summary=${result.fields.summary}`);
  assert.ok(result.fields.summary?.includes('热爱前端工程化'));
});

test('学校名去掉前置就读时间段', async () => {
  const result = await parseResume({
    buffer: Buffer.from('王芳\n教育背景\n2014-2018　浙江大学　计算机科学与技术　本科\n邮箱 wangfang@example.com', 'utf8'),
    filename: 'resume.txt',
  });
  assert.equal(result.fields.school, '浙江大学');
  assert.equal(result.fields.education, '本科');
});

test('教育经历那一行里能拆出专业', async () => {
  const result = await parseResume({
    buffer: Buffer.from('王芳\n教育背景\n2014-2018　浙江大学　计算机科学与技术　本科\n邮箱 wangfang@example.com', 'utf8'),
    filename: 'resume.txt',
  });
  assert.equal(result.fields.major, '计算机科学与技术');
});

test('显式标注的专业优先于从教育经历行推断', async () => {
  const result = await parseResume({
    buffer: Buffer.from('李雷\n专业：软件工程\n2016-2020　同济大学　本科\n邮箱 lilei@example.com', 'utf8'),
    filename: 'resume.txt',
  });
  assert.equal(result.fields.major, '软件工程');
});

test('明确写出的年限优先于起止年份跨度', async () => {
  const result = await parseResume({
    buffer: Buffer.from(
      '李强\n5 年后端开发经验\n工作经历\n2015-2025 某公司 后端工程师\n邮箱 liqiang@example.com',
      'utf8',
    ),
    filename: 'resume.txt',
  });
  assert.equal(result.fields.years_experience, 5);
});

test('超长无邮箱文本不会拖垮解析（邮箱正则线性）', async () => {
  const started = Date.now();
  const result = await parseResume({
    buffer: Buffer.from('a'.repeat(200_000), 'utf8'),
    filename: 'long.txt',
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `解析耗时 ${elapsed}ms，可能存在正则回溯`);
  assert.equal(result.fields.email, undefined);
});
