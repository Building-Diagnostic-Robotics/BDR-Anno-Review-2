import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LlmProviderId, LlmSettingsResponse, ReasoningPreset, SaveLlmSettingsRequest } from "./types";
import { Button, Field, inputClassName, modalOverlayClassName } from "./ui-primitives";

type Props = {
  initial: LlmSettingsResponse | null;
  onClose: () => void;
  onSave: (request: SaveLlmSettingsRequest) => Promise<void>;
  onClearProviderKey: (provider: LlmProviderId) => Promise<void>;
};

export function LlmSettingsModal({ initial, onClose, onSave, onClearProviderKey }: Props) {
  const seed = useMemo(
    () =>
      initial ?? {
        llmSuggestionsEnabled: true,
        reasoningPreset: "high" as ReasoningPreset,
        prefetchBufferSize: 12,
        openai: { enabled: true, model: "gpt-5.2", apiKeyConfigured: false },
        anthropic: { enabled: false, model: "claude-sonnet-4-6", apiKeyConfigured: false },
      },
    [initial]
  );

  const [llmSuggestionsEnabled, setLlmSuggestionsEnabled] = useState(seed.llmSuggestionsEnabled);
  const [reasoningPreset, setReasoningPreset] = useState<ReasoningPreset>(seed.reasoningPreset);
  const [prefetchBufferSize, setPrefetchBufferSize] = useState(seed.prefetchBufferSize);
  const [openaiModel, setOpenaiModel] = useState(seed.openai.model);
  const [anthropicModel, setAnthropicModel] = useState(seed.anthropic.model);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState("");
  const [saveError, setSaveError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<"openai" | "anthropic" | "none">(
    seed.openai.enabled ? "openai" : seed.anthropic.enabled ? "anthropic" : "none"
  );

  const modalRef = useRef<HTMLDivElement | null>(null);
  const firstControlRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const preset = useMemo(() => {
    if (reasoningPreset === "low" && prefetchBufferSize <= 4) return "Fast";
    if (reasoningPreset === "high" && prefetchBufferSize >= 10) return "Quality";
    return "Balanced";
  }, [reasoningPreset, prefetchBufferSize]);

  const providerValidation =
    llmSuggestionsEnabled && selectedProvider === "none"
      ? "Select an LLM provider or disable suggestions before saving."
      : "";

  const applyPreset = (nextPreset: "Fast" | "Balanced" | "Quality") => {
    if (nextPreset === "Fast") {
      setReasoningPreset("low");
      setPrefetchBufferSize(4);
      return;
    }
    if (nextPreset === "Quality") {
      setReasoningPreset("high");
      setPrefetchBufferSize(12);
      return;
    }
    setReasoningPreset("balanced");
    setPrefetchBufferSize(8);
  };

  useEffect(() => {
    setLlmSuggestionsEnabled(seed.llmSuggestionsEnabled);
    setReasoningPreset(seed.reasoningPreset);
    setPrefetchBufferSize(seed.prefetchBufferSize);
    setOpenaiModel(seed.openai.model);
    setAnthropicModel(seed.anthropic.model);
    setOpenaiApiKey("");
    setAnthropicApiKey("");
    setShowOpenaiKey(false);
    setShowAnthropicKey(false);
    setShowAdvanced(false);
    setSaveFeedback("");
    setSaveError("");
    setIsSaving(false);
    setSelectedProvider(seed.openai.enabled ? "openai" : seed.anthropic.enabled ? "anthropic" : "none");
  }, [seed]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstControlRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const container = modalRef.current;
      if (!container) {
        return;
      }

      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((node) => !node.hasAttribute("disabled") && node.tabIndex !== -1);

      if (focusables.length === 0) {
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [onClose]);

  return (
    <div className={modalOverlayClassName} role="dialog" aria-modal="true" aria-label="LLM settings">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-anno-surface-med p-6 ring-1 ring-white/5 shadow-2xl shadow-black/60" ref={modalRef}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-xl font-semibold text-anno-text-main">LLM settings</h3>
          <Button variant="outlined" onClick={onClose} aria-label="Close LLM settings">
            Close
          </Button>
        </div>
        <p className="mb-5 text-sm text-anno-text-muted">Default behavior is optimized for low-friction suggestions. Use Advanced only when tuning is needed.</p>

        <section className="mb-5 space-y-4 rounded-2xl bg-anno-surface-low p-4 ring-1 ring-white/5">
          <h4 className="text-base font-semibold">General</h4>
          <label className="flex items-center justify-between gap-2 text-sm text-anno-text-main">
            <span>Enable suggestions</span>
            <input
              ref={firstControlRef}
              type="checkbox"
              checked={llmSuggestionsEnabled}
              onChange={(e) => setLlmSuggestionsEnabled(e.target.checked)}
              className="h-5 w-5 rounded border-0 bg-anno-surface-high text-anno-primary focus:ring-anno-primary"
            />
          </label>

          <Field label="Provider">
            <select className={inputClassName} value={selectedProvider} onChange={(event) => setSelectedProvider(event.target.value as "openai" | "anthropic" | "none") }>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="none">Disabled</option>
            </select>
          </Field>

          <Field label="Preset" hint="Fast prioritizes speed, Quality prioritizes accuracy.">
            <div className="flex flex-wrap gap-2">
              <Button variant={preset === "Fast" ? "filled" : "outlined"} onClick={() => applyPreset("Fast")}>Fast</Button>
              <Button variant={preset === "Balanced" ? "filled" : "outlined"} onClick={() => applyPreset("Balanced")}>Balanced</Button>
              <Button variant={preset === "Quality" ? "filled" : "outlined"} onClick={() => applyPreset("Quality")}>Quality</Button>
            </div>
          </Field>
        </section>

        <section className="mb-5 space-y-3 rounded-2xl bg-anno-surface-low p-4 ring-1 ring-white/5">
          <h4 className="text-base font-semibold">Credentials</h4>
          <Field label="OpenAI model">
            <select className={inputClassName} value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)}>
              <option value="gpt-5.2">gpt-5.2</option>
            </select>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={inputClassName}
              type={showOpenaiKey ? "text" : "password"}
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
              placeholder="sk-..."
            />
            <Button variant="tonal" onClick={() => setShowOpenaiKey((v) => !v)}>{showOpenaiKey ? "Hide" : "Show"}</Button>
            <Button variant="outlined" onClick={() => void onClearProviderKey("openai")}>Clear key</Button>
          </div>
          <p className="text-xs text-anno-text-muted">
            {seed.openai.apiKeyStatusError
              ? `OpenAI key status unavailable: ${seed.openai.apiKeyStatusError}`
              : seed.openai.apiKeyConfigured
                ? `OpenAI key saved${seed.openai.maskedKeyPreview ? ` (${seed.openai.maskedKeyPreview})` : ""}. Leave blank to keep existing key.`
                : "No OpenAI key saved. Leave blank to keep unchanged."}
          </p>

          <Field label="Anthropic model">
            <select className={inputClassName} value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)}>
              <option value="claude-opus-4-6">claude-opus-4-6</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
            </select>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={inputClassName}
              type={showAnthropicKey ? "text" : "password"}
              value={anthropicApiKey}
              onChange={(e) => setAnthropicApiKey(e.target.value)}
              placeholder="sk-ant-..."
            />
            <Button variant="tonal" onClick={() => setShowAnthropicKey((v) => !v)}>{showAnthropicKey ? "Hide" : "Show"}</Button>
            <Button variant="outlined" onClick={() => void onClearProviderKey("anthropic")}>Clear key</Button>
          </div>
          <p className="text-xs text-anno-text-muted">
            {seed.anthropic.apiKeyStatusError
              ? `Anthropic key status unavailable: ${seed.anthropic.apiKeyStatusError}`
              : seed.anthropic.apiKeyConfigured
                ? `Anthropic key saved${seed.anthropic.maskedKeyPreview ? ` (${seed.anthropic.maskedKeyPreview})` : ""}. Leave blank to keep existing key.`
                : "No Anthropic key saved. Leave blank to keep unchanged."}
          </p>
        </section>

        <section className="mb-5 space-y-3 rounded-2xl bg-anno-surface-low p-4 ring-1 ring-white/5">
          <h4 className="text-base font-semibold">Advanced</h4>
          <button className="text-sm text-anno-secondary transition hover:text-purple-300" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "Hide" : "Show"} advanced settings</button>
          {showAdvanced ? (
            <>
              <Field label="Reasoning preset">
                <select className={inputClassName} value={reasoningPreset} onChange={(e) => setReasoningPreset(e.target.value as ReasoningPreset)}>
                  <option value="high">High</option>
                  <option value="balanced">Balanced</option>
                  <option value="low">Low</option>
                </select>
              </Field>

              <Field label="Prefetch buffer size">
                <input className={inputClassName} type="number" min={1} max={32} value={prefetchBufferSize} onChange={(e) => setPrefetchBufferSize(Number(e.target.value))} />
              </Field>
            </>
          ) : null}
        </section>

        {providerValidation ? <p className="mb-3 text-sm text-rose-300">{providerValidation}</p> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              setIsSaving(true);
              setSaveError("");
              void onSave({
                llmSuggestionsEnabled,
                reasoningPreset,
                prefetchBufferSize,
                openai: { enabled: selectedProvider === "openai", model: openaiModel },
                anthropic: { enabled: selectedProvider === "anthropic", model: anthropicModel },
                openaiApiKey: openaiApiKey || undefined,
                anthropicApiKey: anthropicApiKey || undefined,
              })
                .then(() => {
                  const updatedProviders = [
                    openaiApiKey.trim() ? "OpenAI" : "",
                    anthropicApiKey.trim() ? "Anthropic" : "",
                  ].filter(Boolean);
                  setSaveFeedback(
                    updatedProviders.length > 0
                      ? `${updatedProviders.join(" and ")} key${updatedProviders.length > 1 ? "s" : ""} updated.`
                      : "Settings saved."
                  );
                  setSaveError("");
                })
                .catch((cause) => {
                  setSaveFeedback("");
                  setSaveError(String(cause));
                })
                .finally(() => {
                  setIsSaving(false);
                });
            }}
            disabled={Boolean(providerValidation) || isSaving}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
          <Button variant="outlined" onClick={onClose}>Close</Button>
        </div>
        {saveFeedback ? <p className="mt-3 text-xs text-emerald-300">{saveFeedback}</p> : null}
        {saveError ? <p className="mt-3 text-xs text-rose-300">Failed to save settings: {saveError}</p> : null}
        <p className="mt-3 text-xs text-anno-text-muted">Effective config: {llmSuggestionsEnabled ? "Suggestions enabled" : "Suggestions disabled"}, {preset} profile.</p>
      </div>
    </div>
  );
}
