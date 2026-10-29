/**
 * Form fields from the dialog spec (DESIGN §12.1): outlined `.tf` text field with floating
 * label, prefix, counter, error/warn/help line; select; textarea; checkbox; radio option cards;
 * the 6-digit code input; switch + toggle row (Layers). SHARED (src/ui).
 *
 * A11y: the `.tf` container is the <label>; errors set aria-invalid + aria-describedby → help.
 */
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon } from './Icons';

interface FieldMeta {
  label: string;
  error?: string | null;
  warn?: string | null;
  help?: string | null;
  className?: string;
}

function HelpLine({ id, error, warn, help }: { id: string; error?: string | null; warn?: string | null; help?: string | null }) {
  const text = error || warn || help;
  if (!text) return null;
  return (
    <p id={id} className={['tf-help', error ? 'err' : warn ? 'warn' : ''].filter(Boolean).join(' ')} role={error ? 'alert' : undefined}>
      {text}
    </p>
  );
}

/* ------------------------------------------------------------------ text */

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'>, FieldMeta {
  /** e.g. "$" for tickers. */
  prefix?: string;
  /** Fixed trailing text, e.g. "@bosphorusgrill.example". */
  suffix?: ReactNode;
  /** Show `n/max` (uses maxLength). */
  counter?: boolean;
  /** Monospace input (addresses). */
  mono?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, warn, help, className, prefix, suffix, counter, mono, id, maxLength, value, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? `tf${auto}`;
  const helpId = `${inputId}-help`;
  const len = typeof value === 'string' ? value.length : 0;
  return (
    <div className={['tf-wrap', className ?? ''].filter(Boolean).join(' ')}>
      <label className={['tf', error ? 'err' : ''].filter(Boolean).join(' ')} htmlFor={inputId}>
        <span className="tf-l">{label}</span>
        {prefix ? <span className="tf-pre">{prefix}</span> : null}
        <input
          ref={ref}
          id={inputId}
          className={mono ? 'mono-input' : undefined}
          maxLength={maxLength}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || warn || help ? helpId : undefined}
          {...rest}
        />
        {suffix ? <span className="tf-c tf-suffix">{suffix}</span> : null}
        {counter && maxLength ? (
          <span className="tf-c" aria-hidden="true">
            {len}/{maxLength}
          </span>
        ) : null}
      </label>
      <HelpLine id={helpId} error={error} warn={warn} help={help} />
    </div>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldMeta {
  counter?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, error, warn, help, className, counter, id, maxLength, value, rows = 3, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? `ta${auto}`;
  const helpId = `${inputId}-help`;
  const len = typeof value === 'string' ? value.length : 0;
  return (
    <div className={['tf-wrap', className ?? ''].filter(Boolean).join(' ')}>
      <label className={['tf', 'tf-area', error ? 'err' : ''].filter(Boolean).join(' ')} htmlFor={inputId}>
        <span className="tf-l">{label}</span>
        <textarea
          ref={ref}
          id={inputId}
          rows={rows}
          maxLength={maxLength}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || warn || help ? helpId : undefined}
          {...rest}
        />
        {counter && maxLength ? (
          <span className="tf-c" aria-hidden="true">
            {len}/{maxLength}
          </span>
        ) : null}
      </label>
      <HelpLine id={helpId} error={error} warn={warn} help={help} />
    </div>
  );
});

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldMeta {
  options: readonly { value: string; label: string }[];
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, error, warn, help, className, options, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? `sel${auto}`;
  const helpId = `${inputId}-help`;
  return (
    <div className={['tf-wrap', className ?? ''].filter(Boolean).join(' ')}>
      <label className={['tf', error ? 'err' : ''].filter(Boolean).join(' ')} htmlFor={inputId}>
        <span className="tf-l">{label}</span>
        <select ref={ref} id={inputId} aria-invalid={error ? true : undefined} aria-describedby={error || warn || help ? helpId : undefined} {...rest}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="arrow_drop_down" className="tf-caret" />
      </label>
      <HelpLine id={helpId} error={error} warn={warn} help={help} />
    </div>
  );
});

/* ------------------------------------------------------------------ checkbox */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  children: ReactNode;
}

export function Checkbox({ children, className, ...rest }: CheckboxProps) {
  return (
    <label className={['check', className ?? ''].filter(Boolean).join(' ')}>
      <input type="checkbox" {...rest} />
      <span>{children}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ option cards */

export interface OptionCardProps {
  icon: string;
  title: string;
  sub?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  /** Show a trailing chevron (navigation cards in "Other ways to verify"). */
  chevron?: boolean;
  /** 'radio' (default) or 'button' for navigation cards. */
  kind?: 'radio' | 'button';
  onSelect: () => void;
  children?: ReactNode;
}

export function OptionCard({ icon, title, sub, checked, disabled, chevron, kind = 'radio', onSelect, children }: OptionCardProps) {
  return (
    <button
      type="button"
      className="opt"
      role={kind === 'radio' ? 'radio' : undefined}
      aria-checked={kind === 'radio' ? !!checked : undefined}
      aria-disabled={disabled || undefined}
      data-disabled={disabled || undefined}
      tabIndex={kind === 'radio' && !checked ? -1 : 0}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      <span className="oi">
        <Icon name={icon} />
      </span>
      <span className="opt-tx">
        <b>{title}</b>
        {sub ? <small>{sub}</small> : null}
        {children}
      </span>
      {chevron ? <Icon name="chevron_right" className="opt-chev" /> : null}
    </button>
  );
}

/** Radio group wrapper for OptionCards: ↑/↓/←/→ move between enabled options. */
export function OptionGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([aria-disabled="true"])') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[n]?.focus();
    items[n]?.click();
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={className} onKeyDown={onKey}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ 6-digit code */

export interface CodeInputProps {
  value: string;
  onChange: (digits: string) => void;
  /** Called when all digits are filled (auto-submit). */
  onComplete?: (digits: string) => void;
  length?: number;
  error?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Changing this re-plays the shake animation (e.g. attempt counter). */
  shakeKey?: number | string;
}

/** Focus was dropped to <body> (or sits on an element that just became disabled). */
function focusLost(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || (a instanceof HTMLElement && a.matches(':disabled'));
}

export function CodeInput({ value, onChange, onComplete, length = 6, error, disabled, autoFocus, shakeKey }: CodeInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const digits = value.replace(/\D/g, '').slice(0, length).split('');
  const [shake, setShake] = useState(false);
  /** The box that takes focus: the first empty one (the last box when all are filled). */
  const nextIdx = Math.min(digits.length, length - 1);

  useEffect(() => {
    if (autoFocus) refs.current[nextIdx]?.focus();
    // only on mount (modal step effects also focus the box marked data-autofocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Disabling the boxes while a code is checked drops keyboard focus to <body>, outside the
  // dialog. When they are enabled again (e.g. after a wrong code), put focus back in the boxes.
  const wasDisabled = useRef(!!disabled);
  useEffect(() => {
    const was = wasDisabled.current;
    wasDisabled.current = !!disabled;
    if (!was || disabled) return;
    if (focusLost() || rootRef.current?.contains(document.activeElement)) refs.current[nextIdx]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  useEffect(() => {
    if (!error) return;
    setShake(true);
    const t = setTimeout(() => setShake(false), 320);
    return () => clearTimeout(t);
  }, [error, shakeKey]);

  const setAll = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
    refs.current[Math.min(clean.length, length - 1)]?.focus();
  };

  const onInput = (i: number, raw: string) => {
    const typed = raw.replace(/\D/g, '');
    if (!typed) return;
    if (typed.length > 1) {
      // autofill / multi-char paste into one box
      setAll(digits.slice(0, i).join('') + typed);
      return;
    }
    const arr = [...digits];
    arr[Math.min(i, arr.length)] = typed; // boxes fill left to right
    setAll(arr.join(''));
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const arr = [...digits];
      if (arr[i]) {
        arr.splice(i, 1);
        onChange(arr.join(''));
        refs.current[i]?.focus();
      } else if (i > 0) {
        arr.splice(i - 1, 1);
        onChange(arr.join(''));
        refs.current[i - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault();
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < length - 1) {
      e.preventDefault();
      refs.current[Math.min(i + 1, digits.length)]?.focus();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/\d/.test(text)) return;
    e.preventDefault();
    setAll(text);
  };

  return (
    <div ref={rootRef} className={['code6', error ? 'err' : '', shake ? 'shake' : ''].filter(Boolean).join(' ')}>
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          data-autofocus={autoFocus && i === nextIdx ? '' : undefined}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={digits[i] ?? ''}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          pattern="[0-9]*"
          maxLength={i === 0 ? length : 1}
          aria-label={`Digit ${i + 1} of ${length}`}
          aria-invalid={error || undefined}
          disabled={disabled}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ switch */

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

/** 36×20 switch (on = green track, white 16px thumb). */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={['switch', checked ? 'on' : ''].filter(Boolean).join(' ')}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}

/** 48px Layers toggle row: label + switch; the whole row toggles. */
export function ToggleRow({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <div className="toggle-row" onClick={() => !disabled && onChange(!checked)}>
      <span className="toggle-row-l">{label}</span>
      <span onClick={(e) => e.stopPropagation()}>
        <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      </span>
    </div>
  );
}
