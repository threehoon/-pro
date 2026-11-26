import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { uploadDir, all, getRow, run, transaction } from '../db/index.ts';
import { id, jsonParse, now, sha256, toJson } from '../lib/util.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { RESUME_MAX_BYTES, RESUME_EXTENSIONS, DOWNLOAD_MIME } from '../constants.ts';
import { detectKind, parseResume, type ParsedResume } from '../services/resume-parser.ts';
import { applyParsedFields, createCandidate } from '../services/candidates.ts';
import { audit } from '../services/audit.ts';
import { requireRecruiter, requireUser } from './guard.ts';
import { createApplication } from '../services/applications.ts';
import { getApprovedProfileVersion, queueScreening } from '../services/recruitment-ai.ts';

function safeExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return RESUME_EXTENSIONS.includes(ext) ? ext : '.bin';
}

async function readResumeUpload(file: NonNullable<Awaited<ReturnType<import('fastify').FastifyRequest['file']>>>) {
  // Multipart size limit errors are translated by app.ts.
  const buffer = await file.toBuffer();
  if (!buffer.length) throw badRequest('文件内容为空');
  if (buffer.length > RESUME_MAX_BYTES) throw badRequest('文件超过 8MB 上限');
  const filename = file.filename || 'resume';
  return { buffer, filename, kind: detectKind(filename, file.mimetype || '') };
}

type ResumeUpload = Awaited<ReturnType<typeof readResumeUpload>>;

function prepareResumeStorage(upload: ResumeUpload) {
  const fileId = id('file');
  const ext = safeExtension(upload.filename);
  const storedName = `${fileId}${ext}`;
  const storagePath = path.join(uploadDir, storedName);
  const digest = sha256(upload.buffer);
  async function remove(log: FastifyInstance['log']) {
    try { await unlink(storagePath); }
    catch (error) { log.error({ err: error, fileId }, '简历文件清理失败'); }
  }
  return {
    fileId, digest, remove,
    async write(log: FastifyInstance['log']) {
      await mkdir(uploadDir, { recursive: true });
      const handle = await open(storagePath, 'wx', 0o600);
      try {
        try { await handle.writeFile(upload.buffer); }
        finally { await handle.close(); }
      } catch (error) {
        await remove(log);
        throw error;
      }
    },
    persist(actorId: string, parsed: ParsedResume | null = null) {
      run(`INSERT INTO files (id, filename, mime, size, sha256, storage_path, uploaded_by, created_at, resume_parse_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [fileId, upload.filename, DOWNLOAD_MIME[ext] ?? 'application/octet-stream',
        upload.buffer.length, digest, storedName, actorId, now(), parsed ? toJson(parsed) : null]);
    },
  };
}

function requireImportProfile(jobId: string) {
  const approved = getApprovedProfileVersion(jobId);
  if (!approved) throw conflict('请先在职位详情确认岗位画像，再导入简历');
  return approved;
}

export async function uploadRoutes(app: FastifyInstance) {
  app.post('/api/uploads/resume', async (request, reply) => {
    const user = requireRecruiter(request);
    const file = await request.file();
    if (!file) throw badRequest('请选择要上传的简历文件');

    const upload = await readResumeUpload(file);
    const storage = prepareResumeStorage(upload);
    const { fileId } = storage;
    await storage.write(request.log);
    try { storage.persist(user.id); }
    catch (error) {
      await storage.remove(request.log);
      throw error;
    }

    let parsed = null;
    let parseError: string | null = null;
    try {
      parsed = await parseResume(upload);
      run('UPDATE files SET resume_parse_json = ? WHERE id = ?', [toJson(parsed), fileId]);
    } catch (error) {
      parseError = error instanceof Error ? error.message : '解析失败';
    }

    const fileRow = getRow<Record<string, unknown>>('SELECT * FROM files WHERE id = ?', [fileId])!;
    reply.code(201);
    return {
      file: {
        id: fileRow.id,
        filename: fileRow.filename,
        mime: fileRow.mime,
        size: fileRow.size,
        uploadedAt: fileRow.created_at,
      },
      parsed,
      parseError,
    };
  });

  app.post('/api/jobs/:jobId/resume-import', async (request, reply) => {
    const user = requireRecruiter(request);
    const { jobId } = request.params as { jobId: string };
    // Reject before parsing, and recheck the current approval after asynchronous file I/O.
    const job = getRow<{ status: string }>('SELECT status FROM jobs WHERE id = ?', [jobId]);
    if (!job) throw notFound('职位不存在');
    if (job.status === 'closed') throw badRequest('该职位已关闭，无法新增投递');
    requireImportProfile(jobId);

    let upload: ResumeUpload | undefined;
    for await (const file of request.files()) {
      upload = await readResumeUpload(file);
    }
    if (!upload) throw badRequest('请选择要上传的简历文件');
    const parsed = await parseResume({ ...upload, strictText: true });
    if (!parsed.text.trim()) throw badRequest('简历没有可提取的文字，请换一份文字版文件');
    const storage = prepareResumeStorage(upload);
    const fileName = path.basename(upload.filename, path.extname(upload.filename)).replace(/[\x00-\x1f\x7f]/g, '').trim();
    const name = (parsed.fields.name || fileName || '待补充姓名').slice(0, 120);
    const email = parsed.fields.email?.trim().toLowerCase();

    await storage.write(request.log);
    let application;
    try {
      requireImportProfile(jobId);
      application = createApplication({
        jobId, actorId: user.id, source: '简历直传',
        prepareCandidate() {
          const duplicate = getRow<{ candidate_id: string; application_id: string | null; status: string | null; stage: string | null }>(`
            SELECT c.id AS candidate_id, a.id AS application_id, a.status, a.stage FROM candidates c
            LEFT JOIN files f ON f.id = c.resume_file_id
            LEFT JOIN applications a ON a.candidate_id = c.id AND a.job_id = ?
            WHERE f.sha256 = ? OR c.email = ? COLLATE NOCASE
            ORDER BY a.id IS NOT NULL DESC, f.sha256 = ? DESC, c.id LIMIT 1`, [jobId, storage.digest, email ?? null, storage.digest]);
          if (duplicate) {
            throw conflict(duplicate.application_id ? '这份简历对应的候选人已投递此职位' : '该候选人已存在，请从候选人详情投递到本职位', {
              candidateId: duplicate.candidate_id, applicationId: duplicate.application_id,
              section: duplicate.status === 'active' && duplicate.stage === 'screening' ? 'screening' : 'applications',
            });
          }
          storage.persist(user.id, parsed);
          const candidate = createCandidate({ name, email, source: '简历直传', resume_file_id: storage.fileId }, user.id);
          applyParsedFields(candidate.id, storage.fileId, { ...parsed }, user.id);
          run('UPDATE candidates SET resume_text = ? WHERE id = ?', [parsed.text, candidate.id]);
          return candidate.id;
        },
      });
    } catch (error) {
      // The database transaction rolled back. Remove the exclusively created file.
      await storage.remove(request.log);
      throw error;
    }
    queueScreening(application.id, user.id);
    reply.code(201);
    return { applicationId: application.id, candidateId: application.candidate_id };
  });

  // 把已上传简历的解析结果写入指定候选人（只填空字段，不覆盖人工填写）
  app.post('/api/candidates/:candidateId/resume', async (request) => {
    const user = requireRecruiter(request);
    const { candidateId } = request.params as { candidateId: string };
    const schema = z.object({ fileId: z.string().min(1), parsed: z.record(z.unknown()).optional() });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest('缺少简历文件');

    const candidate = getRow<{ id: string }>('SELECT id FROM candidates WHERE id = ?', [candidateId]);
    if (!candidate) throw notFound('候选人不存在');

    const file = getRow<{ id: string; filename: string; storage_path: string; mime: string; resume_parse_json: string | null }>(
      'SELECT id, filename, storage_path, mime, resume_parse_json FROM files WHERE id = ?', [parsed.data.fileId]);
    if (!file) throw notFound('简历文件不存在');
    let trusted = jsonParse<ParsedResume | null>(file.resume_parse_json, null);
    if (!trusted) {
      try {
        const buffer = await readFile(path.join(uploadDir, path.basename(file.storage_path)));
        trusted = await parseResume({ buffer, filename: file.filename, kind: detectKind(file.filename, file.mime) });
      } catch {
        // Still attach the original when its contents cannot be parsed.
      }
    }
    transaction(() => {
      if (trusted) applyParsedFields(candidateId, file.id, { ...trusted }, user.id);
      run('UPDATE candidates SET resume_file_id = ?, resume_text = ?, updated_at = ? WHERE id = ?',
        [file.id, trusted?.text || null, now(), candidateId]);
      audit({ actorId: user.id, action: 'candidate.resume_attach', entityType: 'candidate', entityId: candidateId });
    });
    for (const application of all<{ id: string }>(`SELECT id FROM applications
      WHERE candidate_id = ? AND status = 'active' AND stage = 'screening'`, [candidateId])) {
      queueScreening(application.id, user.id);
    }
    return { ok: true };
  });

  app.get('/api/files/:fileId', async (request, reply) => {
    requireUser(request);
    const { fileId } = request.params as { fileId: string };
    const file = getRow<{ filename: string; storage_path: string }>(
      'SELECT filename, storage_path FROM files WHERE id = ?',
      [fileId],
    );
    if (!file) throw notFound('文件不存在');
    const absolute = path.join(uploadDir, path.basename(file.storage_path));
    if (!existsSync(absolute)) throw notFound('文件已不存在');

    // 一律按本地扩展名给类型，并且强制附件下载：即使有人上传 HTML 也只会被存成文件
    const ext = path.extname(file.storage_path).toLowerCase();
    reply.header('Content-Type', DOWNLOAD_MIME[ext] ?? 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    return reply.send(createReadStream(absolute));
  });
}