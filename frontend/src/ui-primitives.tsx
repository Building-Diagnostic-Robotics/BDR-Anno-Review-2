import React from "react";

type ButtonVariant =
  | "filled"
  | "tonal"
  | "outlined"
  | "ghost"
  | "text"
  | "primary"
  | "secondary"
  | "outline"
  | "quiet"
  | "danger";

type CardTone = "default" | "soft" | "inset" | "dark" | "raised";
type PillTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "dark";
type AlertTone = "info" | "success" | "warning" | "danger";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: "section" | "article" | "div";
  elevated?: boolean;
  tone?: CardTone;
};

type FieldProps = {
  label: string;
  children: React.ReactNode;
  hint?: string;
};

type StepItem<T extends string> = {
  id: T;
  label: string;
  detail?: string;
};

type TabItem<T extends string> = {
  id: T;
  label: string;
  detail?: string;
};

type SegmentedItem<T extends string> = {
  id: T;
  label: string;
  detail?: string;
};

type StepperProps<T extends string> = {
  steps: StepItem<T>[];
  activeStep: T;
};

type SectionTabsProps<T extends string> = {
  tabs: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
};

type SegmentedControlProps<T extends string> = {
  label: string;
  options: SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
};

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const buttonVariants: Record<ButtonVariant, string> = {
  filled:
    "bg-anno-primary text-anno-text-inverse shadow-lg shadow-anno-primary/20 hover:bg-anno-primary-strong focus-visible:ring-anno-primary",
  tonal:
    "bg-white/85 text-anno-text-main ring-1 ring-anno-line/80 shadow-sm shadow-stone-200/60 hover:bg-white focus-visible:ring-anno-primary",
  outlined:
    "bg-transparent text-anno-text-main ring-1 ring-anno-line hover:bg-anno-surface-low focus-visible:ring-anno-primary",
  ghost:
    "bg-anno-surface-low text-anno-text-main ring-1 ring-transparent hover:bg-anno-surface-med focus-visible:ring-anno-primary",
  text:
    "bg-transparent text-anno-text-muted ring-1 ring-transparent hover:bg-anno-surface-low hover:text-anno-text-main focus-visible:ring-anno-primary",
  primary:
    "bg-anno-primary text-anno-text-inverse shadow-lg shadow-anno-primary/20 hover:bg-anno-primary-strong focus-visible:ring-anno-primary",
  secondary:
    "bg-white/85 text-anno-text-main ring-1 ring-anno-line/80 shadow-sm shadow-stone-200/60 hover:bg-white focus-visible:ring-anno-primary",
  outline:
    "bg-transparent text-anno-text-main ring-1 ring-anno-line hover:bg-anno-surface-low focus-visible:ring-anno-primary",
  quiet:
    "bg-transparent text-anno-text-muted ring-1 ring-transparent hover:bg-anno-surface-low hover:text-anno-text-main focus-visible:ring-anno-primary",
  danger:
    "bg-rose-600 text-white shadow-lg shadow-rose-300/25 hover:bg-rose-700 focus-visible:ring-rose-500",
};

const cardTones: Record<CardTone, string> = {
  default: "bg-white/82 ring-1 ring-anno-line/80 shadow-lg shadow-stone-200/50",
  soft: "bg-anno-surface-low ring-1 ring-anno-line/70 shadow-md shadow-stone-200/35",
  inset: "bg-anno-surface-med ring-1 ring-anno-line/60 shadow-inner shadow-stone-300/20",
  dark: "bg-anno-surface-ink text-anno-text-inverse ring-1 ring-[#4f5760] shadow-2xl shadow-slate-900/35",
  raised: "bg-white/92 ring-1 ring-anno-line/80 shadow-xl shadow-stone-200/60",
};

const pillTones: Record<PillTone, string> = {
  neutral: "bg-anno-surface-med text-anno-text-main ring-1 ring-anno-line/70",
  accent: "bg-amber-100 text-amber-900 ring-1 ring-amber-300/70",
  success: "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300/70",
  warning: "bg-orange-100 text-orange-900 ring-1 ring-orange-300/70",
  danger: "bg-rose-100 text-rose-900 ring-1 ring-rose-300/70",
  info: "bg-sky-100 text-sky-900 ring-1 ring-sky-300/70",
  dark: "bg-slate-700/60 text-slate-50 ring-1 ring-slate-500/80",
};

const alertTones: Record<AlertTone, string> = {
  info: "border-sky-300/80 bg-sky-50/80 text-sky-900",
  success: "border-emerald-300/80 bg-emerald-50/80 text-emerald-900",
  warning: "border-amber-300/80 bg-amber-50/90 text-amber-900",
  danger: "border-rose-300/80 bg-rose-50/90 text-rose-900",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition duration-200 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#f4efe6]",
        buttonVariants[variant],
        className
      )}
      {...props}
    />
  );
}

export function Card({ as = "section", elevated = false, tone = "default", className = "", ...props }: CardProps) {
  const Tag = as;
  return (
    <Tag
      className={cx("rounded-[28px] p-5 md:p-6", cardTones[tone], elevated ? "shadow-2xl" : "", className)}
      {...props}
    />
  );
}

export function SectionHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-4 space-y-1">
      <h2 className="text-[1.45rem] font-semibold tracking-[-0.03em] text-anno-text-main">{title}</h2>
      {subtitle ? <p className="max-w-2xl text-sm text-anno-text-muted">{subtitle}</p> : null}
    </header>
  );
}

export function Field({ label, children, hint }: FieldProps) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium text-anno-text-main">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-anno-text-subtle">{hint}</span> : null}
    </label>
  );
}

export function Pill({ tone = "neutral", className = "", children }: { tone?: PillTone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cx("inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]", pillTones[tone], className)}>
      {children}
    </span>
  );
}

export function Alert({ tone = "info", title, children, className = "" }: { tone?: AlertTone; title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-[22px] border px-4 py-3", alertTones[tone], className)}>
      {title ? <p className="text-sm font-semibold">{title}</p> : null}
      <div className={cx(title ? "mt-1 text-sm" : "text-sm")}>{children}</div>
    </div>
  );
}

export function StatTile({ label, value, detail, className = "" }: { label: string; value: React.ReactNode; detail?: React.ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-[22px] bg-anno-surface-med px-4 py-3 ring-1 ring-anno-line/70", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-anno-text-subtle">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-[-0.03em] text-anno-text-main">{value}</p>
      {detail ? <p className="mt-1 text-xs text-anno-text-muted">{detail}</p> : null}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-[24px] border border-dashed border-anno-line bg-anno-surface-low px-5 py-8 text-center">
      <p className="text-lg font-semibold tracking-[-0.02em] text-anno-text-main">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-anno-text-muted">{description}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Stepper<T extends string>({ steps, activeStep }: StepperProps<T>) {
  const activeIndex = steps.findIndex((step) => step.id === activeStep);

  return (
    <ol className="flex flex-wrap gap-3" aria-label="Workspace progress">
      {steps.map((step, index) => {
        const active = step.id === activeStep;
        const complete = index < activeIndex;
        return (
          <li
            key={step.id}
            className={cx(
              "min-w-[150px] rounded-[22px] px-3 py-2 transition",
              active ? "bg-white/85 ring-1 ring-anno-primary/20 shadow-sm shadow-stone-200/60" : complete ? "bg-emerald-50 ring-1 ring-emerald-200/80" : "bg-anno-surface-low ring-1 ring-anno-line/70"
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cx(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                  active ? "bg-anno-primary text-anno-text-inverse" : complete ? "bg-emerald-600 text-white" : "bg-anno-surface-high text-anno-text-muted"
                )}
              >
                {complete ? "✓" : index + 1}
              </span>
              <span className="text-sm font-semibold text-anno-text-main">{step.label}</span>
            </div>
            {step.detail ? <p className="mt-1 text-xs text-anno-text-muted">{step.detail}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function SectionTabs<T extends string>({ tabs, value, onChange }: SectionTabsProps<T>) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={cx(
              "rounded-full px-3 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-anno-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[#f4efe6]",
              active ? "bg-anno-primary text-anno-text-inverse shadow-md shadow-anno-primary/15" : "bg-anno-surface-low text-anno-text-main ring-1 ring-anno-line hover:bg-white"
            )}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.detail ? <span className="ml-2 text-xs opacity-80">{tab.detail}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedControl<T extends string>({ label, options, value, onChange }: SegmentedControlProps<T>) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-anno-text-main">{label}</p>
      <div className="inline-flex flex-wrap gap-2 rounded-full bg-anno-surface-med p-1 ring-1 ring-anno-line/70">
        {options.map((option) => {
          const active = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              className={cx(
                "rounded-full px-4 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-anno-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[#f4efe6]",
                active ? "bg-white text-anno-text-main shadow-sm shadow-stone-200/70" : "text-anno-text-muted hover:bg-white/60 hover:text-anno-text-main"
              )}
              onClick={() => onChange(option.id)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {options.find((option) => option.id === value)?.detail ? (
        <p className="text-xs text-anno-text-subtle">{options.find((option) => option.id === value)?.detail}</p>
      ) : null}
    </div>
  );
}

export function ConsoleSurface({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("terminal-scrollbar rounded-[24px] bg-[#181c21] px-4 py-4 font-mono text-xs text-slate-200 ring-1 ring-slate-600/60 shadow-2xl shadow-slate-900/35", className)}>
      {children}
    </div>
  );
}

export const inputClassName =
  "w-full rounded-[18px] border border-anno-line bg-white/90 px-3 py-2.5 text-sm text-anno-text-main shadow-sm shadow-stone-200/50 transition-all duration-200 placeholder:text-anno-text-subtle focus:border-anno-primary focus:outline-none focus:ring-2 focus:ring-anno-primary/25 disabled:cursor-not-allowed disabled:opacity-60";

export const modalOverlayClassName =
  "fixed inset-0 z-40 flex items-center justify-center bg-[rgba(47,40,34,0.44)] p-4 backdrop-blur-[5px]";
