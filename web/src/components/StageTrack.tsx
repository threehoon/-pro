import type { Stage } from "../types";
import { stageColor } from "../lib/format";

interface Segment {
  stage: Stage;
  count: number;
}

/**
 * 签名手法「流动带」：把阶段人数画成一条连续色带。
 * 每段宽度按人数占比计算，最窄保留 2px，保证 0 人有可见锚点。
 */
export function StageTrack({
  values,
  total,
  large = false,
  label,
}: {
  values: Segment[];
  total: number;
  large?: boolean;
  label?: string;
}) {
  const sum = Math.max(1, total);
  const visible = values.reduce((acc, item) => acc + item.count, 0);

  return (
    <div className={`stage-track ${large ? "large" : ""}`}>
      <div className="track-rail" role="img" aria-label={label ?? `共 ${visible} 人`}>
        {values.map((item) =>
          item.count > 0 ? (
            <span
              key={item.stage}
              className="track-seg"
              style={{
                flexGrow: item.count,
                background: stageColor(item.stage),
              }}
              title={`${item.count} 人`}
            />
          ) : null,
        )}
        {visible === 0 && <span className="track-empty" />}
        {visible > 0 && visible < sum && (
          <span className="track-rest" aria-hidden style={{ flexGrow: sum - visible }} />
        )}
      </div>
      {label && <span className="track-label">{label}</span>}
    </div>
  );
}
