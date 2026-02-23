import React from "react";

type ButtonVariant = "filled" | "tonal" | "outlined" | "ghost" | "text";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

const buttonVariants: Record<ButtonVariant, string> = {
  filled:
    "bg-anno-primary text-white shadow-lg shadow-anno-primary/35 hover:bg-indigo-500 focus-visible:ring-anno-primary",
  tonal:
    "bg-anno-surface-high text-anno-text-main shadow-md shadow-black/30 hover:bg-zinc-700 focus-visible:ring-anno-secondary",
  outlined:
    "bg-transparent text-anno-text-main ring-1 ring-white/10 hover:bg-anno-surface-high focus-visible:ring-anno-primary",
  ghost:
    "border border-zinc-700 bg-transparent text-anno-text-main hover:border-indigo-500/60 hover:bg-indigo-500/15 focus-visible:ring-indigo-500/60",
  text: "bg-transparent text-anno-text-muted hover:text-anno-text-main hover:bg-anno-surface-high focus-visible:ring-anno-secondary",
};

export function Button({ variant = "filled", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-2xl px-4 py-2 text-sm font-semibold transition duration-200 ease-out active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0 ${buttonVariants[variant]} ${className}`.trim()}
      {...props}
    />
  );
}

type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: "section" | "article" | "div";
  elevated?: boolean;
};

export function Card({ as = "section", elevated = false, className = "", ...props }: CardProps) {
  const Tag = as;
  return (
    <Tag
      className={`rounded-2xl bg-anno-surface-med p-5 ring-1 ring-white/5 shadow-xl shadow-black/35 ${elevated ? "shadow-2xl shadow-black/45" : ""} ${className}`.trim()}
      {...props}
    />
  );
}

export function SectionHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-4 space-y-1">
      <h2 className="text-xl font-semibold tracking-tight text-anno-text-main">{title}</h2>
      {subtitle ? <p className="text-sm text-anno-text-muted">{subtitle}</p> : null}
    </header>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="mb-4 block space-y-1.5">
      <span className="text-sm font-medium text-anno-text-main">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-anno-text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClassName =
  "w-full rounded-2xl bg-anno-surface-high px-3 py-2.5 text-sm text-anno-text-main placeholder:text-anno-text-muted/70 ring-1 ring-zinc-800 transition-all duration-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:cursor-not-allowed disabled:opacity-60";

export const modalOverlayClassName =
  "fixed inset-0 z-40 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[1px]";
