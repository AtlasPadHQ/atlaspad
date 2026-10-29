/**
 * Panel empty state (DESIGN §13.4): centred column, 96px dashed green circle with a 40px icon,
 * title 16/22 600, body 14/20 text-2 (max 280px), optional buttons. SHARED (src/ui).
 */
import type { ReactNode } from 'react';
import { Icon } from './Icons';

export interface EmptyStateProps {
  icon: string;
  title: string;
  body?: ReactNode;
  /** Buttons (gap 8, margin-top 16). */
  children?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, body, children, className }: EmptyStateProps) {
  return (
    <div className={['empty', className ?? ''].filter(Boolean).join(' ')}>
      <span className="empty-ic">
        <Icon name={icon} size={40} />
      </span>
      <h3 className="empty-t">{title}</h3>
      {body ? <p className="empty-b">{body}</p> : null}
      {children ? <div className="empty-actions">{children}</div> : null}
    </div>
  );
}
