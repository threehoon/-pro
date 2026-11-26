import { useCallback } from "react";
import { Badge, ErrorState, ListSkeleton, Modal } from "../ui";
import { api } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import type { ApplicationDetail } from "../../types";
import { useWorkflowResource } from "./resource";
import { ScreeningPanel } from "./ScreeningPanel";
import { OfferPanel } from "./OfferPanel";

const stageLabels: Record<string, string> = {
  new: "新简历",
  screening: "待筛选",
  interview: "面试中",
  offer: "谈薪中",
  hired: "已入职",
};

/**
 * 在职位子模块里就地完成筛选或谈薪。
 * 复用候选人页同一套面板，不复制业务规则；只把「去哪操作」从跳转变成同页抽屉。
 */
export function ApplicationDrawer({
  applicationId,
  focus,
  canWrite,
  rejectionReasons,
  onClose,
  onChange,
}: {
  applicationId: string;
  focus: "screening" | "negotiation" | "onboarding";
  canWrite: boolean;
  rejectionReasons: string[];
  onClose: () => void;
  onChange: () => void;
}) {
  const fetchDetail = useCallback(() => api.application(applicationId), [applicationId]);
  const resource = useWorkflowResource(fetchDetail, false, "投递详情加载失败");
  const detail: ApplicationDetail | null = resource.data;

  // 决策性动作会把这条记录移出当前子模块：推进/归档后不再留在这里，
  // 先让外层刷新再关抽屉。保存草稿、记录发出这类可连续编辑的动作留在抽屉里。
  const afterChange = useCallback(async () => {
    onChange();
    try {
      const next = await api.application(applicationId);
      const application = next.application;
      // 归档/拒绝会停在原阶段（Offer 被拒仍是 stage=offer、status=rejected），所以每个分支都要看 status。
      // 谈薪在 Offer 发出后就该离开（该人转入待入职）；入职页则要等到真正入职或归档。
      const leftStage = application.status !== "active"
        || (focus === "screening"
          ? application.stage !== "screening" && application.stage !== "new"
          : focus === "negotiation"
            ? application.stage !== "offer"
              || application.offer_status === "sent" || application.offer_status === "accepted"
            : application.stage === "hired");
      if (leftStage) onClose();
    } catch {
      // 读不到最新状态时保持抽屉打开，由外层刷新兜底，避免误关掉正在看的记录。
    }
  }, [applicationId, focus, onChange, onClose]);

  return (
    <Modal
      open
      onClose={onClose}
      variant="drawer"
      width={680}
      title={detail ? detail.application.candidate_name ?? "候选人" : "候选人"}
      description={
        detail ? (
          <span className="inline-tags">
            <span>{detail.application.job_title ?? ""}</span>
            <Badge tone={detail.application.stage === "hired" ? "success" : "neutral"}>
              {detail.application.status === "rejected" ? "已归档" : stageLabels[detail.application.stage] ?? detail.application.stage}
            </Badge>
            <span className="muted">投递于 {fmtDate(detail.application.applied_at)}</span>
          </span>
        ) : null
      }
    >
      <div className="workflow-stack">
        {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
        {!detail && !resource.error && <ListSkeleton rows={3} />}
        {detail && focus === "screening" && (
          <ScreeningPanel
            application={detail.application}
            canWrite={canWrite}
            rejectionReasons={rejectionReasons}
            resumeHref={`/candidates/${detail.application.candidate_id}#resume`}
            onChange={() => {
              resource.reload();
              void afterChange();
            }}
          />
        )}
        {detail && focus !== "screening" && (
          <OfferPanel
            application={detail.application}
            canWrite={canWrite}
            onChange={() => {
              resource.reload();
              void afterChange();
            }}
          />
        )}
      </div>
    </Modal>
  );
}
