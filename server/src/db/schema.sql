-- Hireloop schema. Applied idempotently on boot; see db/index.ts.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- 登录账号：可以是一个短名字（演示账号就是 123），登录时与邮箱等价
  username       TEXT,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'recruiter'
                 CHECK (role IN ('admin', 'recruiter', 'hiring_manager')),
  title          TEXT,
  -- 飞书接入预留：扫码登录后回填，用于身份映射与消息推送
  feishu_open_id TEXT,
  feishu_union_id TEXT,
  created_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_by  TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  department      TEXT,
  location        TEXT,
  work_mode       TEXT NOT NULL DEFAULT 'onsite'
                  CHECK (work_mode IN ('onsite', 'hybrid', 'remote')),
  employment_type TEXT NOT NULL DEFAULT 'full_time'
                  CHECK (employment_type IN ('full_time', 'part_time', 'intern', 'contract')),
  level           TEXT,
  headcount       INTEGER NOT NULL DEFAULT 1,
  salary_min      INTEGER,
  salary_max      INTEGER,
  currency        TEXT NOT NULL DEFAULT 'CNY',
  description     TEXT,
  requirements    TEXT,
  skills          TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'paused', 'closed')),
  owner_id        TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS candidates (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  location         TEXT,
  current_company  TEXT,
  current_title    TEXT,
  years_experience REAL,
  education        TEXT,
  school           TEXT,
  major            TEXT,
  skills           TEXT NOT NULL DEFAULT '[]',
  tags             TEXT NOT NULL DEFAULT '[]',
  source           TEXT,
  linkedin         TEXT,
  portfolio        TEXT,
  summary          TEXT,
  notes            TEXT,
  resume_file_id   TEXT REFERENCES files(id),
  parsed           TEXT NOT NULL DEFAULT '{}',
  owner_id         TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_created ON candidates(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email);

CREATE TABLE IF NOT EXISTS applications (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_id     TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  stage            TEXT NOT NULL DEFAULT 'new'
                   CHECK (stage IN ('new', 'screening', 'interview', 'offer', 'hired')),
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'rejected')),
  owner_id         TEXT REFERENCES users(id),
  source           TEXT,
  rating           INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  rejection_reason TEXT,
  rejected_at      TEXT,
  applied_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (job_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_applications_job_stage ON applications(job_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_candidate ON applications(candidate_id);

CREATE TABLE IF NOT EXISTS application_events (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage     TEXT,
  to_stage       TEXT,
  type           TEXT NOT NULL
                 CHECK (type IN ('created', 'stage_change', 'rejected', 'reopened', 'hired', 'note')),
  note           TEXT,
  actor_id       TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_application ON application_events(application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interviews (
  id                        TEXT PRIMARY KEY,
  application_id            TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  round                     INTEGER NOT NULL DEFAULT 1,
  title                     TEXT NOT NULL DEFAULT '面试',
  mode                      TEXT NOT NULL DEFAULT 'video'
                            CHECK (mode IN ('onsite', 'video', 'phone')),
  scheduled_at              TEXT NOT NULL,
  duration_minutes          INTEGER NOT NULL DEFAULT 45,
  location                  TEXT,
  meeting_url               TEXT,
  interviewer_id            TEXT REFERENCES users(id),
  status                    TEXT NOT NULL DEFAULT 'scheduled'
                            CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  score                     INTEGER CHECK (score IS NULL OR score BETWEEN 1 AND 5),
  feedback                  TEXT,
  recommendation            TEXT
                            CHECK (recommendation IS NULL OR recommendation IN ('strong_yes', 'yes', 'no', 'strong_no')),
  -- 飞书日历预留：创建日程后回填 event_id，用于改期/取消同步
  external_calendar_event_id TEXT,
  created_by                TEXT REFERENCES users(id),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  completed_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_interviews_time ON interviews(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_interviews_application ON interviews(application_id);

-- 通知出站箱：业务事件先落库，渠道适配器（飞书机器人 / 邮件 / 站内）异步投递
CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,
  event_key      TEXT NOT NULL,
  type           TEXT NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'inapp'
                 CHECK (channel IN ('inapp', 'feishu', 'email')),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  target_user_id TEXT REFERENCES users(id),
  title          TEXT NOT NULL,
  body           TEXT,
  payload        TEXT NOT NULL DEFAULT '{}',
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  sent_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at);

-- 第三方集成配置，当前只登记飞书占位
CREATE TABLE IF NOT EXISTS integrations (
  provider    TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'disabled'
              CHECK (status IN ('disabled', 'configured')),
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_by  TEXT REFERENCES users(id),
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS job_profiles (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','failed')),
  generated_by TEXT NOT NULL DEFAULT 'ai' CHECK (generated_by IN ('ai','manual','fallback')),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, version)
);

CREATE TABLE IF NOT EXISTS screening_reviews (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES job_profiles(id),
  score INTEGER,
  verdict TEXT CHECK (verdict IN ('match','overqualified','mismatch')),
  unknown_weight INTEGER NOT NULL DEFAULT 0,
  missing_gates TEXT NOT NULL DEFAULT '[]',
  redline_hit TEXT NOT NULL DEFAULT '[]',
  detail_json TEXT NOT NULL DEFAULT '{}',
  decision TEXT CHECK (decision IN ('advance','reject')),
  reason TEXT,
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screening_app ON screening_reviews(application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  expected_salary INTEGER,
  final_salary INTEGER,
  start_date TEXT,
  reply_deadline TEXT,
  status TEXT NOT NULL DEFAULT 'negotiating' CHECK (status IN ('negotiating','sent','accepted','declined')),
  decline_reason TEXT,
  offer_letter TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT,
  input_hash TEXT,
  model TEXT,
  prompt_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','failed','skipped')),
  error TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  reasoning_tokens INTEGER,
  cached_tokens INTEGER,
  duration_ms INTEGER,
  actor_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_created ON ai_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_hash ON ai_runs(input_hash, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_subject ON ai_runs(kind, subject_id, created_at DESC);