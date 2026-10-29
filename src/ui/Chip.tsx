/**
 * Filter chip (DESIGN §6.3): 32px white pill; `on` = green container + trailing close icon
 * ("tap again to clear"); `aria-pressed`. SHARED (src/ui).
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icons';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Leading Material Symbols icon. */
  icon?: string;
  /** Leading emoji (rendered in `.em`). */
  emoji?: string;
  on?: boolean;
  /** Show the trailing close icon when on (default true). */
  clearable?: boolean;
  children: ReactNode;
}

export function Chip({ icon, emoji, on, clearable = true, className, children, type, ...rest }: ChipProps) {
  return (
    <button
      type={type ?? 'button'}
      className={['chip', on ? 'on' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-pressed={on ?? false}
      {...rest}
    >
      {emoji ? (
        <span className="em" aria-hidden="true">
          {emoji}
        </span>
      ) : icon ? (
        <Icon name={icon} />
      ) : null}
      {children}
      {on && clearable ? <Icon name="close" className="chip-x" size={16} /> : null}
    </button>
  );
}
