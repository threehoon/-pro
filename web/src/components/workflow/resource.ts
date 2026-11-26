import { useEffect, useState } from "react";
import type { AiResult } from "../../workflowTypes";
import { apiMessage } from "../../lib/workflow";

export function useWorkflowResource<T>(fetchResource: () => Promise<T>, poll: boolean, fallback: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function refresh() {
      try {
        const result = await fetchResource();
        if (!active) return;
        setData(result);
        setError("");
      } catch (err) {
        if (active) setError(apiMessage(err, fallback));
      }
      if (active && poll) timer = window.setTimeout(() => void refresh(), 1800);
    }
    void refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [fallback, fetchResource, poll, revision]);

  return { data, error, reload: () => setRevision((value) => value + 1) };
}

export function requireAiResult<T>(result: AiResult<T>, fallback: string): T {
  if (!result.ok || !result.data) throw new Error(result.reason || fallback);
  return result.data;
}
