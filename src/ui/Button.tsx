/**
 * Buttons (DESIGN §6 shared button CSS + added states). SHARED (src/ui).
 *  - <Button variant="primary|tonal|outline|amber|text|danger" icon="…" loading block />
 *  - <IconButton icon="close" label="Close" /> — icon-only, always has aria-label + tooltip.
 * Loading: label stays, a spinning `progress_activity` replaces the leading icon, aria-busy,
 * clicks ignored. Disabled: opacity .38, no hover. A `tip` adds a tooltip (data-tip).
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './Icons';

export type ButtonVariant = 'primary' | 'tonal' | 'outline' | 'amber' | 'text' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  /** Leading Material Symbols icon. */
  icon?: string;
  /** Fill the leading icon. */
  iconFill?: boolean;
  /** Custom leading node (e.g. <XGlyph />) instead of `icon`. */
  lead?: ReactNode;
  /** Trailing Material Symbols icon (e.g. open_in_new). */
  trailingIcon?: string;
  /** Full-width 48px block button. */
  block?: boolean;
  loading?: boolean;
  /** Tooltip text (shown on hover/focus; also used for disabled reasons). */
  tip?: string;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', icon, iconFill, lead, trailingIcon, block, loading, tip, className, disabled, onClick, type, children, ...rest },
  ref,
) {
  const cls = ['btn', `btn-${variant}`, block ? 'btn-block' : '', loading ? 'is-loading' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cls}
      disabled={disabled}
      aria-busy={loading || undefined}
      data-tip={tip}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? <Icon name="progress_activity" spin /> : lead ?? (icon ? <Icon name={icon} fill={iconFill} /> : null)}
      {children}
      {trailingIcon ? <Icon name={trailingIcon} className="trail" /> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: string;
  /** Required accessible name; also the tooltip text. */
  label: string;
  fill?: boolean;
  size?: number;
  /** Disable the automatic tooltip (e.g. inside a menu). */
  noTip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, fill, size, noTip, className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={['icon-btn', className ?? ''].filter(Boolean).join(' ')}
      aria-label={label}
      data-tip={noTip ? undefined : label}
      {...rest}
    >
      <Icon name={icon} fill={fill} size={size} />
    </button>
  );
});
