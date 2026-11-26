import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconSearch, IconStar, IconX } from "./icons";

/* ---------------------------------- Button --------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children != null && <span>{children}</span>}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, children, className = "", type = "button", ...rest }: IconButtonProps) {
  return (
    <button type={type} className={`icon-btn ${className}`.trim()} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/* ---------------------------------- Fields --------------------------------- */

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  span?: boolean;
  children: (id: string) => ReactNode;
}

export function Field({ label, hint, error, required, span, children }: FieldProps) {
  const id = useId();
  return (
    <div className={`field ${span ? "field-span" : ""} ${error ? "field-error" : ""}`.trim()}>
      {label && (
        <label className="field-label" htmlFor={id}>
          {label}
          {required && <span className="req"> *</span>}
        </label>
      )}
      {children(id)}
      {error ? (
        <p className="field-msg err" id={`${id}-msg`}>
          {error}
        </p>
      ) : hint ? (
        <p className="field-msg">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement> & { id?: string }) {
  return <input className={`input ${className}`.trim()} {...rest} />;
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`.trim()} {...rest} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`select ${className}`.trim()} {...rest}>
      {children}
    </select>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "搜索",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search-input">
      <IconSearch size={16} />
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        aria-label={placeholder}
      />
      {value && (
        <button type="button" className="search-clear" onClick={() => onChange("")} aria-label="清空搜索">
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}

/* ---------------------------------- Badges --------------------------------- */

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  color,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "danger" | "warning" | "success";
  dot?: boolean;
  color?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} style={color ? { color, background: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}>
      {dot && <span className="badge-dot" style={color ? { background: color } : undefined} />}
      {children}
    </span>
  );
}

export function StageBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="badge stage-badge" style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
      <span className="badge-dot" style={{ background: color }} />
      {label}
    </span>
  );
}

export function Avatar({
  name,
  size = 28,
  chars = 2,
}: {
  name?: string | null;
  size?: number;
  /** 中文名取几个字：默认两字（思远），紧挨姓名时用 1 字避免重复。 */
  chars?: 1 | 2;
}) {
  const text = initialsLocal(name, chars);
  const hue = hashHue(name ?? "");
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.38)),
        background: `hsl(${hue} 24% 88%)`,
        color: `hsl(${hue} 34% 26%)`,
      }}
      aria-hidden
    >
      {text}
    </span>
  );
}

function initialsLocal(name: string | null | undefined, chars: 1 | 2): string {
  if (!name) return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(-chars);
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function hashHue(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

/* ---------------------------------- Layout --------------------------------- */

export function Card({ children, className = "", ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        <h2 className="section-title">{title}</h2>
        {description && <p className="section-desc">{description}</p>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-heading">
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  title,
  description,
  action,
  compact,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      <svg width="72" height="56" viewBox="0 0 72 56" fill="none" aria-hidden>
        <rect x="10" y="12" width="52" height="34" rx="4" stroke="var(--line-strong)" strokeWidth="1.5" />
        <path d="M10 24h52" stroke="var(--line)" strokeWidth="1.5" />
        <path d="M20 32h14M20 38h22" stroke="var(--line-strong)" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="54" cy="17" r="2.4" fill="var(--line-strong)" />
      </svg>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%", radius = 6 }: { height?: number; width?: number | string; radius?: number }) {
  return <span className="skeleton" style={{ height, width, borderRadius: radius }} aria-hidden />;
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="list-skeleton" aria-label="加载中">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="list-skeleton-row">
          <Skeleton height={34} width={34} radius={999} />
          <div className="grow">
            <Skeleton height={13} width="42%" />
            <Skeleton height={11} width="68%" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <p>{message}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}

/* ------------------------------- Star rating ------------------------------- */

export function StarRating({
  value,
  onChange,
  size = 16,
  readOnly = false,
}: {
  value: number | null;
  onChange?: (value: number | null) => void;
  size?: number;
  readOnly?: boolean;
}) {
  return (
    <span className={`stars ${readOnly ? "readonly" : ""}`} role={readOnly ? "img" : "group"} aria-label={`评分 ${value ?? 0} / 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`star ${value != null && n <= value ? "on" : ""}`}
          disabled={readOnly}
          onClick={() => onChange?.(value === n ? null : n)}
          aria-label={`${n} 星`}
        >
          <IconStar size={size} filled={value != null && n <= value} />
        </button>
      ))}
    </span>
  );
}

/* ---------------------------------- Modal ---------------------------------- */

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  variant?: "modal" | "drawer";
}

export function Modal({ open, onClose, title, description, children, footer, width, variant = "modal" }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const dialog = ref.current;
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (!dialog || dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    }, 20);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className={`overlay overlay-${variant}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`${variant === "drawer" ? "drawer" : "modal"}`}
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          <div>
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
            {description && <p className="modal-desc">{description}</p>}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <IconX size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------- Toast ---------------------------------- */

type ToastKind = "info" | "success" | "error";
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastContext = createContext<{ push: (message: string, kind?: ToastKind) => void }>({
  push: () => undefined,
});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, kind: ToastKind = "info") => {
    counter.current += 1;
    const id = counter.current;
    setItems((prev) => [...prev, { id, kind, message }]);
    window.setTimeout(() => setItems((prev) => prev.filter((item) => item.id !== id)), kind === "error" ? 5200 : 2600);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-stack" aria-live="polite">
          {items.map((item) => (
            <div key={item.id} className={`toast toast-${item.kind}`}>
              <span className="toast-icon">{item.kind === "success" ? <IconCheck size={15} /> : item.kind === "error" ? <IconX size={15} /> : null}</span>
              <span>{item.message}</span>
              <button type="button" onClick={() => setItems((prev) => prev.filter((entry) => entry.id !== item.id))} aria-label="关闭提示">
                <IconX size={13} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/* --------------------------------- Confirm --------------------------------- */

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false);

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ options: ConfirmOptions; resolve: (value: boolean) => void } | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => setState({ options, resolve }));
  }, []);

  const finish = (value: boolean) => {
    state?.resolve(value);
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={Boolean(state)}
        onClose={() => finish(false)}
        title={state?.options.title ?? ""}
        description={state?.options.description}
        width={440}
        footer={
          <>
            <Button onClick={() => finish(false)}>{state?.options.cancelLabel ?? "取消"}</Button>
            <Button
              variant={state?.options.tone === "danger" ? "danger" : "primary"}
              onClick={() => finish(true)}
            >
              {state?.options.confirmLabel ?? "确认"}
            </Button>
          </>
        }
      >
        <p className="confirm-text">此操作会立即生效。</p>
      </Modal>
    </ConfirmContext.Provider>
  );
}

/* ----------------------------------- Tabs ---------------------------------- */

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ value: string; label: ReactNode; count?: number }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          className={`tab ${value === tab.value ? "active" : ""}`}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count != null && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
