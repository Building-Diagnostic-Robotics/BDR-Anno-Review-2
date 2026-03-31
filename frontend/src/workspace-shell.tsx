import React from "react";
import { Button, ConsoleSurface, Pill, Stepper } from "./ui-primitives";

export type WorkspaceStep = "setup" | "review" | "export";

type StatusItem = {
  label: string;
  value: string;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "dark";
};

type WorkspaceTopBarProps = {
  currentStep: WorkspaceStep;
  contextLabel: string;
  contextDetail: string;
  onOpenSettings: () => void;
  settingsDisabled?: boolean;
};

type WorkspaceStatusRailProps = {
  diagnosticsOpen: boolean;
  onToggleDiagnostics: () => void;
  items: StatusItem[];
};

type DiagnosticsDrawerProps = {
  open: boolean;
  diagnosticsText: string;
  hasError: boolean;
  onCopy: () => void;
  onClear: () => void;
};

const stepDescriptors = [
  { id: "setup", label: "Setup", detail: "Start or resume a review workspace." },
  { id: "review", label: "Review", detail: "Move quickly through faces and resolve boxes." },
  { id: "export", label: "Export", detail: "Confirm destination and write deterministic COCO." },
] satisfies Array<{ id: WorkspaceStep; label: string; detail: string }>;

export function WorkspaceTopBar({ currentStep, contextLabel, contextDetail, onOpenSettings, settingsDisabled = false }: WorkspaceTopBarProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-anno-line/80 bg-[#f4efe6]/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 md:px-8">
        <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-3">
              <Pill tone="accent">Calm Studio</Pill>
              <Pill tone="neutral">Desktop-first annotation review</Pill>
            </div>
            <h1 className="mt-3 text-[2rem] font-semibold tracking-[-0.04em] text-anno-text-main">BDR Anno Review Workspace</h1>
            <p className="mt-2 text-sm text-anno-text-muted">A clearer review studio for creating datasets, checking edits, and exporting deterministic results.</p>
          </div>

          <div className="flex flex-col items-start gap-3 rounded-[26px] bg-white/70 px-4 py-4 ring-1 ring-anno-line/80 shadow-sm shadow-stone-200/60 md:min-w-[320px]">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-anno-text-subtle">Workspace context</p>
              <p className="mt-1 text-base font-semibold tracking-[-0.02em] text-anno-text-main">{contextLabel}</p>
              <p className="mt-1 text-xs text-anno-text-muted">{contextDetail}</p>
            </div>
            <Button aria-label="Open settings" variant="secondary" onClick={onOpenSettings} disabled={settingsDisabled}>
              Studio settings
            </Button>
          </div>
        </div>

        <Stepper steps={stepDescriptors} activeStep={currentStep} />
      </div>
    </header>
  );
}

export function WorkspaceStatusRail({ diagnosticsOpen, onToggleDiagnostics, items }: WorkspaceStatusRailProps) {
  return (
    <section className="fixed bottom-0 left-0 right-0 z-30 border-t border-anno-line bg-[#f4efe6]/95 backdrop-blur" aria-live="polite">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-3 md:px-8 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <div key={item.label} className="rounded-full bg-white/85 px-3 py-2 ring-1 ring-anno-line/80 shadow-sm shadow-stone-200/50">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-anno-text-subtle">{item.label}</span>
              <span className="ml-2 text-sm font-semibold text-anno-text-main">{item.value}</span>
            </div>
          ))}
        </div>
        <Button variant={diagnosticsOpen ? "filled" : "outlined"} onClick={onToggleDiagnostics}>
          {diagnosticsOpen ? "Hide diagnostics" : "Show diagnostics"}
        </Button>
      </div>
    </section>
  );
}

export function DiagnosticsDrawer({ open, diagnosticsText, hasError, onCopy, onClear }: DiagnosticsDrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed bottom-[88px] left-0 right-0 z-20 px-4 md:px-8">
      <div className="mx-auto w-full max-w-[1600px]">
        <ConsoleSurface className="overflow-hidden">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-slate-600/60 pb-3">
            <div>
              <p className="text-sm font-semibold text-slate-50">Diagnostics Console</p>
              <p className="mt-1 text-xs text-slate-300">{hasError ? "Attention needed in the latest operation." : "System diagnostics are ready for inspection."}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outlined" className="border-slate-500/70 text-slate-100 hover:bg-slate-700/60" onClick={onCopy}>
                Copy log
              </Button>
              <Button variant="text" className="text-slate-300 hover:bg-slate-700/60 hover:text-slate-50" onClick={onClear}>
                Clear history
              </Button>
            </div>
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-100">{diagnosticsText}</pre>
        </ConsoleSurface>
      </div>
    </div>
  );
}
