/**
 * Skeletons (DESIGN §13.3): `.sk` shimmer blocks (static under reduced motion), aria-hidden.
 * Put aria-busy="true" on the loading container. SHARED (src/ui).
 */
import type { CSSProperties } from 'react';

export interface SkProps {
  w?: number | string;
  h?: number | string;
  /** Border radius (default 6). Use '50%' for circles. */
  r?: number | string;
  className?: string;
  style?: CSSProperties;
}

export function Sk({ w = '100%', h = 14, r, className, style }: SkProps) {
  return (
    <span
      className={['sk', className ?? ''].filter(Boolean).join(' ')}
      aria-hidden="true"
      style={{ width: w, height: h, ...(r != null ? { borderRadius: r } : null), ...style }}
    />
  );
}

/** A list-row skeleton (feeds / leaderboards): 40px circle + two bars + a right bar. */
export function SkRow({ avatar = 40 }: { avatar?: number }) {
  return (
    <div className="sk-row" aria-hidden="true">
      <Sk w={avatar} h={avatar} r="50%" />
      <span className="sk-row-tx">
        <Sk w="60%" h={14} />
        <Sk w="35%" h={12} />
      </span>
      <Sk w={48} h={14} />
    </div>
  );
}

/** n list-row skeletons (DESIGN: feeds/leaderboards show 6). */
export function SkRows({ n = 6, avatar = 40 }: { n?: number; avatar?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <SkRow key={i} avatar={avatar} />
      ))}
    </div>
  );
}
