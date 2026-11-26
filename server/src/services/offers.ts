import { getRow, run, transaction } from '../db/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { id, now } from '../lib/util.ts';
import { getApplication, recordArchive, recordStage } from './applications.ts';
import { audit } from './audit.ts';

interface Offer {
  id: string;
  application_id: string;
  status: 'negotiating' | 'sent' | 'accepted' | 'declined';
  expected_salary: number | null;
  final_salary: number | null;
  start_date: string | null;
  reply_deadline: string | null;
  offer_letter: string | null;
}

type Terms = Pick<Offer, 'expected_salary' | 'final_salary' | 'start_date' | 'reply_deadline' | 'offer_letter'>;

export function startNegotiation(applicationId: string, actorId: string): void {
  const timestamp = now();
  run(`INSERT INTO offers (id, application_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id('offer'), applicationId, actorId, timestamp, timestamp]);
}

export function offerDetail(applicationId: string) {
  const context = getRow<{
    title: string; candidate: string; min: number | null; max: number | null; currency: string; contact: string | null;
  }>(`SELECT j.title, c.name AS candidate, j.salary_min AS min, j.salary_max AS max, j.currency, u.name AS contact
      FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN jobs j ON j.id = a.job_id
      LEFT JOIN users u ON u.id = COALESCE(a.owner_id, j.owner_id) WHERE a.id = ?`, [applicationId]);
  if (!context) throw notFound('投递记录不存在');
  const offer = getRow<Offer>('SELECT * FROM offers WHERE application_id = ?', [applicationId]) ?? null;
  const expected = offer?.expected_salary ?? null;
  const { min, max } = context;
  const difference = expected !== null && max !== null ? expected - max : null;
  const openingSalary = expected !== null && min !== null && max !== null
    ? Math.min(expected, Math.floor((min + max) / 2)) : null;
  const script = openingSalary === null ? null : `我们希望先从 ${context.currency} ${openingSalary.toLocaleString('zh-CN')} 开始沟通，您怎么看？`;
  const template = offer?.final_salary != null && offer.start_date && offer.reply_deadline
    ? `${context.candidate}，您好！\n\n我们邀请您加入，担任${context.title}。\n约定薪资：${context.currency} ${offer.final_salary.toLocaleString('zh-CN')}\n到岗日期：${offer.start_date}\n请于 ${offer.reply_deadline} 前回复。${context.contact ? `\n联系人：${context.contact}` : ''}`
    : null;
  return { offer, budget: { min, max }, difference, openingSalary, script, template };
}

export function updateOffer(applicationId: string, actorId: string, patch: Partial<Terms>) {
  const application = getApplication(applicationId);
  const { offer } = offerDetail(applicationId);
  if (application.status !== 'active' || application.stage !== 'offer' || offer?.status !== 'negotiating') {
    throw badRequest('只有谈薪中的投递可以修改 Offer');
  }
  const terms = { ...offer, ...patch };
  if (terms.start_date && terms.reply_deadline && terms.reply_deadline > terms.start_date) {
    throw badRequest('答复期限不能晚于到岗日期');
  }
  transaction(() => {
    run(`UPDATE offers SET expected_salary = ?, final_salary = ?, start_date = ?, reply_deadline = ?, offer_letter = ?, updated_at = ? WHERE id = ?`,
      [terms.expected_salary, terms.final_salary, terms.start_date, terms.reply_deadline, terms.offer_letter, now(), offer.id]);
    audit({ actorId, action: 'offer.update', entityType: 'offer', entityId: offer.id });
  });
  return offerDetail(applicationId);
}

export function decideOffer(input: { applicationId: string; actorId: string; action: 'send' | 'accept' | 'decline' | 'hire'; reason?: string; start_date?: string }) {
  const application = getApplication(input.applicationId);
  const { offer, template } = offerDetail(input.applicationId);
  if (application.status !== 'active' || application.stage !== 'offer' || !offer) throw badRequest('当前投递不在 Offer 流程');
  const timestamp = now();
  transaction(() => {
    switch (input.action) {
      case 'send':
        if (offer.status !== 'negotiating' || !template) throw badRequest('请先填写定薪、到岗日期和答复期限');
        run(`UPDATE offers SET status = 'sent', offer_letter = ?, sent_at = ?, updated_at = ? WHERE id = ?`,
          [offer.offer_letter?.trim() || template, timestamp, timestamp, offer.id]);
        break;
      case 'accept':
        if (offer.status !== 'sent') throw badRequest('只有已发出的 Offer 可以记录接受');
        run(`UPDATE offers SET status = 'accepted', decided_at = ?, updated_at = ? WHERE id = ?`, [timestamp, timestamp, offer.id]);
        break;
      case 'decline': {
        if (offer.status !== 'sent' && offer.status !== 'accepted') throw badRequest('只有已发出的 Offer 可以记录拒绝');
        const reason = input.reason?.trim() || '候选人拒绝 Offer';
        run(`UPDATE offers SET status = 'declined', decline_reason = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
          [reason, timestamp, timestamp, offer.id]);
        recordArchive(application, input.actorId, reason);
        break;
      }
      case 'hire': {
        if (offer.status !== 'accepted') throw badRequest('请先记录候选人接受 Offer');
        if (input.start_date) {
          run('UPDATE offers SET start_date = ?, updated_at = ? WHERE id = ?', [input.start_date, timestamp, offer.id]);
        }
        recordStage(application, 'hired', input.actorId, '确认候选人已入职');
        break;
      }
    }
    audit({ actorId: input.actorId, action: `offer.${input.action}`, entityType: 'offer', entityId: offer.id });
  });
  return offerDetail(input.applicationId);
}
