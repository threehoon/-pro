import { Field, Select } from "../ui";

export function ArchiveReasonField({ reasons, value, onChange, allowEmpty = false }: {
  reasons: string[];
  value: string;
  onChange: (reason: string) => void;
  /** 批量归档要求人来选，不预填默认值。 */
  allowEmpty?: boolean;
}) {
  return <Field label="归档原因">{(id) => (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {allowEmpty && <option value="">请选择原因</option>}
      {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
    </Select>
  )}</Field>;
}

export function defaultArchiveReason(reasons: string[], suggested?: string | null) {
  if (suggested && reasons.includes(suggested)) return suggested;
  return reasons.includes("其他") ? "其他" : reasons[0] ?? "其他";
}
