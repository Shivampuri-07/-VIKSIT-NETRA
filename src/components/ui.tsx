import React from "react";
import { X, ChevronDown } from "lucide-react";
import { statusColor, statusLabel } from "../lib/format";

/**
 * Shared presentation primitives for the VIKSIT-NETRA light institutional theme.
 * Presentation only: no data is derived, formatted or invented here.
 */

export const Card: React.FC<{
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ElementType;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}> = ({ title, subtitle, icon: Icon, actions, className = "", bodyClassName = "p-4", children }) => (
  <section className={`vn-card flex flex-col min-w-0 ${className}`}>
    {(title || actions) && (
      <header className="flex items-start justify-between gap-3 px-4 py-3 border-b border-line">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink flex items-center gap-2 leading-tight">
            {Icon && <Icon className="w-4 h-4 text-navy-600 shrink-0" aria-hidden="true" />}
            <span className="truncate">{title}</span>
          </h3>
          {subtitle && <p className="text-[11px] text-muted mt-0.5 leading-snug">{subtitle}</p>}
        </div>
        {actions && <div className="shrink-0 flex items-center gap-1.5">{actions}</div>}
      </header>
    )}
    <div className={`min-h-0 ${bodyClassName}`}>{children}</div>
  </section>
);

/** Headline number with a caption. `tone` only tints the value, never the whole card. */
export const Stat: React.FC<{
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "ok" | "warn" | "danger" | "info";
  className?: string;
}> = ({ label, value, hint, tone = "default", className = "" }) => {
  const tones: Record<string, string> = {
    default: "text-ink",
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
    info: "text-navy-600",
  };
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="vn-label truncate">{label}</div>
      <div className={`vn-num text-[18px] font-semibold leading-tight mt-0.5 ${tones[tone]}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted leading-snug mt-0.5">{hint}</div>}
    </div>
  );
};

/** Provenance chip: coloured dot + the status written out, so colour is never the only signal. */
export const StatusChip: React.FC<{ status?: string | null; title?: string; className?: string }> = ({ status, title, className = "" }) => {
  const c = statusColor(status);
  return (
    <span
      title={title ?? statusLabel(status)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[2px] text-[10px] font-medium whitespace-nowrap ${className}`}
      style={{ color: c, borderColor: c + "59", background: c + "12" }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c }} aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
};

export const Tag: React.FC<{
  tone?: "neutral" | "ok" | "warn" | "danger" | "info" | "accent";
  children: React.ReactNode;
  className?: string;
  title?: string;
}> = ({ tone = "neutral", children, className = "", title }) => {
  const tones: Record<string, string> = {
    neutral: "bg-subtle text-muted border-line",
    ok: "bg-ok-50 text-ok border-ok/30",
    warn: "bg-warn-50 text-warn border-warn/30",
    danger: "bg-danger-50 text-danger border-danger/30",
    info: "bg-navy-50 text-navy-600 border-navy-600/25",
    accent: "bg-saffron-50 text-saffron border-saffron/30",
  };
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-[1px] text-[10px] font-medium whitespace-nowrap ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
};

/** Label / value row used throughout the detail views. */
export const KV: React.FC<{ k: React.ReactNode; v: React.ReactNode; mono?: boolean }> = ({ k, v, mono = true }) => (
  <div className="flex justify-between gap-3 py-[3px] border-b border-line last:border-0">
    <span className="text-[11px] text-muted shrink-0">{k}</span>
    <span className={`text-[11px] text-ink text-right min-w-0 ${mono ? "vn-num" : ""}`}>{v}</span>
  </div>
);

/** Horizontal meter for a 0..1 value. */
export const Meter: React.FC<{ value: number; color?: string; className?: string }> = ({ value, color = "#1e4e82", className = "" }) => (
  <div className={`w-full h-1.5 bg-subtle rounded-full overflow-hidden ${className}`} role="presentation">
    <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
  </div>
);

/** Progressive disclosure: collapsed by default, so technical depth is available but not shouted. */
export const Disclose: React.FC<{ summary: string; children: React.ReactNode; className?: string; testId?: string }> = ({
  summary,
  children,
  className = "",
  testId,
}) => (
  <details className={`vn-details ${className}`} data-testid={testId}>
    <summary>
      <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
      {summary}
    </summary>
    <div className="pt-1">{children}</div>
  </details>
);

export const EmptyState: React.FC<{ icon?: React.ElementType; title: string; hint?: string; className?: string }> = ({
  icon: Icon,
  title,
  hint,
  className = "",
}) => (
  <div className={`h-full min-h-[120px] flex flex-col items-center justify-center text-center p-6 ${className}`}>
    {Icon && <Icon className="w-7 h-7 text-line-strong mb-2" aria-hidden="true" />}
    <p className="text-[13px] font-medium text-ink-soft">{title}</p>
    {hint && <p className="text-[11px] text-muted max-w-xs mt-1 leading-snug">{hint}</p>}
  </div>
);

/** Shared modal shell: light surface, labelled close control, Esc to dismiss. */
export const Modal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  title: string;
  icon?: React.ElementType;
  subtitle?: string;
  maxWidth?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ isOpen, onClose, title, icon: Icon, subtitle, maxWidth = "max-w-lg", footer, children }) => {
  React.useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[2000] bg-ink/30 backdrop-blur-[1px] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`vn-card w-full ${maxWidth} max-h-[88vh] flex flex-col shadow-xl`}>
        <header className="flex items-start justify-between gap-3 px-5 py-3.5 border-b border-line shrink-0">
          <div>
            <h2 className="text-[14px] font-semibold text-ink flex items-center gap-2">
              {Icon && <Icon className="w-4 h-4 text-navy-600" aria-hidden="true" />}
              {title}
            </h2>
            {subtitle && <p className="text-[11px] text-muted mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close dialog" className="text-muted hover:text-ink cursor-pointer p-1 -m-1 rounded">
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="px-5 py-3 border-t border-line flex justify-end gap-2 shrink-0 bg-subtle/60 rounded-b-[12px]">{footer}</footer>}
      </div>
    </div>
  );
};
