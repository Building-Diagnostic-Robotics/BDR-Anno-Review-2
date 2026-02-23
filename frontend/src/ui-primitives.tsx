import React from "react";

type ButtonVariant = "filled" | "tonal" | "outlined" | "text";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({ variant = "filled", className = "", ...props }: ButtonProps) {
  return <button className={`btn btn-${variant} ${className}`.trim()} {...props} />;
}

type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: "section" | "article" | "div";
  elevated?: boolean;
};

export function Card({ as = "section", elevated = false, className = "", ...props }: CardProps) {
  const Tag = as;
  return <Tag className={`card ${elevated ? "card-elevated" : ""} ${className}`.trim()} {...props} />;
}

export function SectionHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="section-heading">
      <h2>{title}</h2>
      {subtitle ? <p className="hint">{subtitle}</p> : null}
    </header>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
