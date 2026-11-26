import { useRef, useState, type DragEvent } from "react";
import { api, ApiError } from "../../lib/api";
import { Link } from "../../lib/router";
import { apiMessage, candidateLink } from "../../lib/workflow";
import type { BoardData } from "../../types";
import { IconUpload } from "../icons";
import { Button } from "../ui";

const ACCEPTED = /\.(pdf|docx|txt|md)$/i;
const MAX_BYTES = 8 * 1024 * 1024;

type ImportResult = {
  name: string;
  state: "ok" | "duplicate" | "skipped" | "failed";
  message?: string;
  link?: string | null;
};

function duplicateLink(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 409 || typeof error.details !== "object" || !error.details) return null;
  const details = error.details as { candidateId?: unknown; applicationId?: unknown; section?: unknown };
  if (typeof details.candidateId !== "string") return null;
  return candidateLink(details.candidateId, typeof details.applicationId === "string" ? details.applicationId : undefined,
    details.section === "screening" ? "screening" : "applications");
}

/**
 * 批量导入简历：一次可以选多份，逐份上传并显示结果。
 * 串行上传，避免同一批里重复简历互相抢跑；每份的结果独立展示，不整批失败。
 */
export function ResumeImport({ jobId, approvedProfile, onImported }: {
  jobId: string;
  approvedProfile: BoardData["approvedProfile"];
  onImported: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number; name: string } | null>(null);
  const [results, setResults] = useState<ImportResult[]>([]);
  const profileLink = `/jobs/${jobId}/profile`;

  async function importFiles(files: FileList | null) {
    if (!approvedProfile || busy.current || !files?.length) return;
    const picked = Array.from(files);
    busy.current = true;
    setResults([]);
    const next: ImportResult[] = [];
    let imported = 0;
    try {
      for (const [index, file] of picked.entries()) {
        if (!ACCEPTED.test(file.name) || file.size === 0 || file.size > MAX_BYTES) {
          next.push({ name: file.name, state: "skipped", message: "只收 8 MB 以内的 PDF、DOCX、TXT、MD" });
          setResults([...next]);
          continue;
        }
        setProgress({ index: index + 1, total: picked.length, name: file.name });
        try {
          await api.importResume(jobId, file);
          imported += 1;
          next.push({ name: file.name, state: "ok" });
        } catch (cause) {
          const link = duplicateLink(cause);
          next.push({ name: file.name, state: link ? "duplicate" : "failed", message: apiMessage(cause, "简历导入失败"), link });
        }
        setResults([...next]);
      }
    } finally {
      setProgress(null);
      busy.current = false;
      setResults([...next]);
      if (imported > 0) onImported();
    }
  }

  function enter(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    if (approvedProfile && !busy.current) setDragging(true);
  }

  function leave(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }

  function drop(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void importFiles(event.dataTransfer.files);
  }

  const okCount = results.filter((item) => item.state === "ok").length;
  const problemCount = results.length - okCount;

  return (
    <section className={`resume-import${dragging ? " is-dragging" : ""}`} aria-labelledby="resume-import-title"
      onDragEnter={enter} onDragLeave={leave}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = approvedProfile && !busy.current ? "copy" : "none";
      }} onDrop={drop}>
      <div className="resume-import-copy">
        <h2 id="resume-import-title" tabIndex={-1}>简历筛选</h2>
        {approvedProfile ? <>
          <p>把简历拖到这里，AI 按<Link className="text-link" to={profileLink}>已确认的第 {approvedProfile.version} 版画像</Link>分析，由你决定是否推进初试。</p>
          <p id="resume-import-format" className="muted">可一次选多份 · PDF、DOCX、TXT、MD · 每份最大 8 MB</p>
        </> : <p>先确认岗位画像，再上传简历进行筛选。</p>}
      </div>
      {approvedProfile ? <>
        <input ref={input} id="resume-import-file" type="file" accept=".pdf,.docx,.txt,.md" multiple hidden onChange={(event) => {
          void importFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }} />
        <Button variant="primary" icon={<IconUpload size={16} />} loading={Boolean(progress)} aria-describedby="resume-import-format" onClick={() => input.current?.click()}>
          {progress ? `正在导入 ${progress.index}/${progress.total}` : "选择简历"}
        </Button>
      </> : <Link className="btn btn-primary btn-md" to={profileLink}>去确认画像</Link>}
      {progress && <p className="resume-import-feedback" role="status">正在导入第 {progress.index}/{progress.total} 份：{progress.name}</p>}
      {results.length > 0 && (
        <div className="resume-import-results" role="status">
          <p className="muted">
            本次 {results.length} 份：成功 {okCount} 份{problemCount ? `，需处理 ${problemCount} 份` : ""}
          </p>
          <ul>
            {results.map((item, index) => (
              <li key={`${index}-${item.name}`} className={`import-row import-${item.state}`}>
                <span aria-hidden>{item.state === "ok" ? "✓" : item.state === "duplicate" ? "⇄" : "!"}</span>
                <span className="import-name">{item.name}</span>
                {item.message && <span className="muted">{item.message}</span>}
                {item.link && <Link to={item.link} className="text-link">打开已有记录</Link>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
