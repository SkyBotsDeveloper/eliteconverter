import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

export const cx = (...classes: Array<string | false | null | undefined>): string =>
  classes.filter(Boolean).join(" ");

export const Logo = ({ compact = false }: { compact?: boolean }) => (
  <span className="ec-logo" aria-label="EliteConverter">
    <svg aria-hidden="true" viewBox="0 0 48 48" width="34" height="34" role="img">
      <rect x="4" y="5" width="40" height="38" rx="7" fill="currentColor" opacity="0.12" />
      <path
        d="M14 15h18l-5 7h8L20 36l4-10h-9l6-11z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M33 14h3v3" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
    {!compact && (
      <span>
        <strong>EliteConverter</strong>
        <small>Convert Streams. Deliver Anywhere.</small>
      </span>
    )}
  </span>
);

export const Button = ({
  children,
  className,
  variant = "primary",
  loading = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
}) => (
  <button
    className={cx("ec-button", `ec-button-${variant}`, className)}
    disabled={loading || props.disabled}
    {...props}
  >
    {loading ? <Loader2 className="icon spin" aria-hidden="true" /> : null}
    {children}
  </button>
);

export const IconButton = ({
  label,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) => (
  <button className={cx("ec-icon-button", className)} aria-label={label} title={label} {...props}>
    {children}
  </button>
);

export const Badge = ({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) => <span className={cx("ec-badge", `ec-badge-${tone}`)}>{children}</span>;

export const Panel = ({ children, className, ...props }: HTMLAttributes<HTMLElement>) => (
  <section className={cx("ec-panel", className)} {...props}>
    {children}
  </section>
);

export const Field = ({
  label,
  error,
  hint,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
}) => (
  <label className="ec-field" htmlFor={id}>
    <span>{label}</span>
    <input
      id={id}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? `${id}-error` : undefined}
      {...props}
    />
    {hint && !error ? <small>{hint}</small> : null}
    {error ? (
      <small id={`${id}-error`} role="alert" className="field-error">
        {error}
      </small>
    ) : null}
  </label>
);

export const ProgressBar = ({ value, label }: { value: number; label: string }) => (
  <div
    className="ec-progress"
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={value}
    aria-label={label}
  >
    <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
  </div>
);

export const CheckItem = ({ children }: { children: ReactNode }) => (
  <li className="check-item">
    <CheckCircle2 aria-hidden="true" className="icon" />
    <span>{children}</span>
  </li>
);
