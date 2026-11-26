import { useEffect, useState } from "react";
import { Button, Field, Input, Modal, Select, useToast } from "../ui";
import { api, ApiError } from "../../lib/api";
import type { Application, Interview, Meta } from "../../types";

export function ScheduleInterviewModal({
  open,
  applications,
  round,
  draft,
  candidateName,
  meta,
  onClose,
  onDone,
}: {
  open: boolean;
  applications: Application[];
  round: 1 | 2;
  draft?: Interview;
  candidateName: string;
  meta: Meta;
  onClose: () => void;
  onDone: () => void;
}) {
  const [applicationId, setApplicationId] = useState(applications[0]?.id ?? "");
  const [scheduledAt, setScheduledAt] = useState("");
  const [mode, setMode] = useState("video");
  const [duration, setDuration] = useState(45);
  const [location, setLocation] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [interviewers, setInterviewers] = useState<Array<{ id: string; name: string }>>([]);
  const [interviewerId, setInterviewerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setError("");
    setApplicationId(applications[0]?.id ?? "");
    const nextHour = new Date();
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const pad2 = (n: number) => String(n).padStart(2, "0");
    setScheduledAt(`${nextHour.getFullYear()}-${pad2(nextHour.getMonth() + 1)}-${pad2(nextHour.getDate())}T${pad2(nextHour.getHours())}:${pad2(nextHour.getMinutes())}`);
    api.team().then((data) => setInterviewers(data.items)).catch(() => setInterviewers([]));
    // 只在打开时重置；applications 变化不应打断正在填写的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = applications.find((item) => item.id === applicationId);

  async function submit() {
    if (!applicationId) {
      setError("这条投递不在流程中，无法安排面试");
      return;
    }
    if (!scheduledAt) {
      setError("请选择面试时间");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const schedule = {
        scheduledAt: new Date(scheduledAt).toISOString(),
        mode,
        durationMinutes: duration,
        location: mode === "onsite" ? location.trim() || undefined : undefined,
        meetingUrl: mode === "video" ? meetingUrl.trim() || undefined : undefined,
        interviewerId: interviewerId || null,
      };
      if (draft) await api.updateInterview(draft.id, schedule);
      else await api.createInterview({ ...schedule, applicationId, round });
      toast.push("面试已安排", "success");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "安排失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={round === 2 ? "安排复试" : "安排初试"}
      description={`${candidateName}${selected?.job_title ? ` · ${selected.job_title}` : ""}`}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            安排
          </Button>
        </>
      }
    >
      <div className="form-grid">
        {applications.length > 1 && (
          <Field label="投递职位" span>
            {(id) => (
              <Select id={id} value={applicationId} onChange={(event) => setApplicationId(event.target.value)}>
                {applications.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.job_title ?? item.job_id}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="面试时间" required>
          {(id) => <Input id={id} type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />}
        </Field>
        <Field label="时长（分钟）">
          {(id) => (
            <Select id={id} value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
              {[30, 45, 60, 90].map((value) => (
                <option key={value} value={value}>
                  {value} 分钟
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="面试形式">
          {(id) => (
            <Select id={id} value={mode} onChange={(event) => setMode(event.target.value)}>
              {Object.entries(meta.interviewModeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="面试官">
          {(id) => (
            <Select id={id} value={interviewerId} onChange={(event) => setInterviewerId(event.target.value)}>
              <option value="">待定</option>
              {interviewers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {mode === "onsite" ? (
          <Field label="面试地点">
            {(id) => <Input id={id} value={location} onChange={(event) => setLocation(event.target.value)} placeholder="如：3 号楼 5 层会议室" />}
          </Field>
        ) : (
          <Field label="会议链接" hint="留空时若已接通飞书日历，将自动生成飞书视频会议链接">
            {(id) => <Input id={id} value={meetingUrl} onChange={(event) => setMeetingUrl(event.target.value)} placeholder="留空自动生成，或填写飞书/腾讯会议链接" />}
          </Field>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">安排后会自动把候选人推进到「面试中」，并发出一条通知。</p>
    </Modal>
  );
}
