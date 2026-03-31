import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LlmProviderId, LlmSettingsResponse, ReasoningPreset, SaveLlmSettingsRequest } from "./types";
import { Alert, Button, Card, Field, Pill, SegmentedControl, SectionHeading, inputClassName, modalOverlayClassName } from "./ui-primitives";

type Props = {
  initial: LlmSettingsResponse | null;
  onClose: () => void;
  onSave: (request: SaveLlmSettingsRequest) => Promise<void>;
  onSetProviderKey: (provider: LlmProviderId, apiKey: string) => Promise<void>;
  onClearProviderKey: (provider: LlmProviderId) => Promise<void>;
};

type ProviderSelection = "openai" | "anthropic" | "none";

type ProviderCardProps = {
  provider: "openai" | "anthropic";
  title: string;
  selected: boolean;
  hasKey: boolean;
  model: string;
  keyValue: string;
  disabled: boolean;
  modelOptions: string[];
  onSelect: () => void;
  onModelChange: (value: string) => void;
  onKeyValueChange: (value: string) => void;
  onUpdateKey: () => void;
  onClearKey: () => void;
};

function ProviderCard({
  provider,
  title,
  selected,
  hasKey,
  model,
  keyValue,
  disabled,
  modelOptions,
  onSelect,
  onModelChange,
  onKeyValueChange,
  onUpdateKey,
  onClearKey,
}: ProviderCardProps) {
  const providerLabel = provider === "openai" ? "OpenAI" : "Anthropic";

  return (
    <Card tone={selected ? "raised" : "soft"} className={selected ? "ring-2 ring-anno-primary/40" : ""}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xl font-semibold tracking-[-0.03em] text-anno-text-main">{title}</h4>
            <Pill tone={selected ? "success" : "neutral"}>{selected ? "Active" : "Available"}</Pill>
          </div>
          <p className="mt-2 text-sm text-anno-text-muted">
            {provider === "openai"
              ? "Balanced default with the current studio preset."
              : "Alternative provider for teams standardizing on Anthropic."}
          </p>
        </div>
        <Button variant={selected ? "filled" : "outlined"} onClick={onSelect} disabled={disabled}>
          {selected ? "Selected" : `Use ${providerLabel}`}
        </Button>
      </div>

      <div className="mt-5 space-y-4">
        <Field label={`${providerLabel} model`}>
          <select className={inputClassName} value={model} onChange={(event) => onModelChange(event.target.value)}>
            {modelOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={`${providerLabel} API key`}
          hint={hasKey ? "A key is already stored. Enter a new value only when rotating credentials." : "Enter and store a key for this provider."}
        >
          <input
            className={inputClassName}
            type="password"
            value={keyValue}
            onChange={(event) => onKeyValueChange(event.target.value)}
            placeholder={hasKey ? "Stored securely. Paste a new key to replace it." : "Paste API key"}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={hasKey ? "success" : "neutral"}>{hasKey ? "Key stored" : "Key missing"}</Pill>
          <Button variant="secondary" onClick={onUpdateKey} disabled={disabled}>
            Update {providerLabel} key
          </Button>
          <Button variant="outlined" onClick={onClearKey} disabled={disabled || !hasKey}>
            Clear {providerLabel} key
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function LlmSettingsModal({ initial, onClose, onSave, onSetProviderKey, onClearProviderKey }: Props) {
  const seed = useMemo(
    () =>
      initial ?? {
        llmSuggestionsEnabled: true,
        reasoningPreset: "high" as ReasoningPreset,
        prefetchBufferSize: 12,
        editorWarmupThresholdRatio: 0.4,
        editorWarmupTimeoutMs: 15000,
        openai: { enabled: true, model: "gpt-5.4", hasKey: false },
        anthropic: { enabled: false, model: "claude-sonnet-4-6", hasKey: false },
      },
    [initial]
  );

  const [llmSuggestionsEnabled, setLlmSuggestionsEnabled] = useState(seed.llmSuggestionsEnabled);
  const [reasoningPreset, setReasoningPreset] = useState<ReasoningPreset>(seed.reasoningPreset);
  const [prefetchBufferSize, setPrefetchBufferSize] = useState(seed.prefetchBufferSize);
  const [editorWarmupThresholdRatio, setEditorWarmupThresholdRatio] = useState(seed.editorWarmupThresholdRatio);
  const [editorWarmupTimeoutMs, setEditorWarmupTimeoutMs] = useState(seed.editorWarmupTimeoutMs);
  const [openaiModel, setOpenaiModel] = useState(seed.openai.model);
  const [anthropicModel, setAnthropicModel] = useState(seed.anthropic.model);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState("");
  const [saveError, setSaveError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isUpdatingKey, setIsUpdatingKey] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderSelection>(
    seed.openai.enabled ? "openai" : seed.anthropic.enabled ? "anthropic" : "none"
  );
  const [openaiKeyInput, setOpenaiKeyInput] = useState("");
  const [anthropicKeyInput, setAnthropicKeyInput] = useState("");

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
    setEditorWarmupThresholdRatio(seed.editorWarmupThresholdRatio);
    setEditorWarmupTimeoutMs(seed.editorWarmupTimeoutMs);
    setOpenaiModel(seed.openai.model);
    setAnthropicModel(seed.anthropic.model);
    setShowAdvanced(false);
    setSaveFeedback("");
    setSaveError("");
    setIsSaving(false);
    setIsUpdatingKey(false);
    setOpenaiKeyInput("");
    setAnthropicKeyInput("");
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

  const setProviderKey = async (provider: LlmProviderId, rawValue: string) => {
    const providerLabel = provider === "openai" ? "OpenAI" : "Anthropic";
    const apiKey = rawValue.trim();

    setSaveFeedback("");
    setSaveError("");
    if (!apiKey) {
      setSaveError(`${providerLabel} key was not updated.`);
      return;
    }

    setIsUpdatingKey(true);
    try {
      await onSetProviderKey(provider, apiKey);
      setSaveFeedback(`${providerLabel} API key updated.`);
      if (provider === "openai") {
        setOpenaiKeyInput("");
      } else {
        setAnthropicKeyInput("");
      }
    } catch (cause) {
      setSaveError(String(cause));
    } finally {
      setIsUpdatingKey(false);
    }
  };

  const clearProviderKey = async (provider: LlmProviderId) => {
    setSaveFeedback("");
    setSaveError("");
    setIsUpdatingKey(true);
    try {
      await onClearProviderKey(provider);
      setSaveFeedback(`${provider === "openai" ? "OpenAI" : "Anthropic"} API key cleared.`);
    } catch (cause) {
      setSaveError(String(cause));
    } finally {
      setIsUpdatingKey(false);
    }
  };

  return (
    <div className={modalOverlayClassName} role="dialog" aria-modal="true" aria-label="LLM settings">
      <div
        className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-[32px] bg-[#f5efe6] p-6 shadow-2xl shadow-stone-900/20 ring-1 ring-anno-line/80 md:p-7"
        ref={modalRef}
      >
        <div className="flex flex-col gap-4 border-b border-anno-line/80 pb-5 md:flex-row md:items-start md:justify-between">
          <SectionHeading
            title="Suggestion Studio Settings"
            subtitle="Tune how review suggestions enter the workspace without changing the backend behavior or project contracts."
          />
          <Button variant="outlined" onClick={onClose} aria-label="Close LLM settings">
            Close
          </Button>
        </div>

        <div className="mt-6 space-y-6">
          <Card tone="soft">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-2xl">
                <h4 className="text-xl font-semibold tracking-[-0.03em] text-anno-text-main">General behavior</h4>
                <p className="mt-2 text-sm text-anno-text-muted">Default behavior is tuned for mixed operators: low friction by default, with room to increase quality when a session needs it.</p>
              </div>
              <label className="flex items-center gap-3 rounded-full bg-white/75 px-4 py-2 ring-1 ring-anno-line/70">
                <input
                  ref={firstControlRef}
                  type="checkbox"
                  checked={llmSuggestionsEnabled}
                  onChange={(event) => setLlmSuggestionsEnabled(event.target.checked)}
                  className="h-4 w-4 rounded border-anno-line text-anno-primary focus:ring-anno-primary"
                />
                <span className="text-sm font-semibold text-anno-text-main">Enable suggestions</span>
              </label>
            </div>

            <div className="mt-5">
              <SegmentedControl
                label="Preset"
                value={preset}
                onChange={applyPreset}
                options={[
                  { id: "Fast", label: "Fast", detail: "Low reasoning with a small buffer." },
                  { id: "Balanced", label: "Balanced", detail: "Steady response time for most sessions." },
                  { id: "Quality", label: "Quality", detail: "Higher reasoning with a larger suggestion buffer." },
                ]}
              />
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <div className="rounded-[22px] bg-white/75 px-4 py-3 ring-1 ring-anno-line/70">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-anno-text-subtle">Current profile</p>
                <p className="mt-1 text-lg font-semibold tracking-[-0.02em] text-anno-text-main">{preset}</p>
              </div>
              <div className="rounded-[22px] bg-white/75 px-4 py-3 ring-1 ring-anno-line/70">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-anno-text-subtle">Reasoning</p>
                <p className="mt-1 text-lg font-semibold tracking-[-0.02em] capitalize text-anno-text-main">{reasoningPreset}</p>
              </div>
              <div className="rounded-[22px] bg-white/75 px-4 py-3 ring-1 ring-anno-line/70">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-anno-text-subtle">Prefetch buffer</p>
                <p className="mt-1 text-lg font-semibold tracking-[-0.02em] text-anno-text-main">{prefetchBufferSize} faces</p>
              </div>
            </div>
          </Card>

          <section aria-labelledby="provider-heading">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <h4 id="provider-heading" className="text-xl font-semibold tracking-[-0.03em] text-anno-text-main">
                Provider cards
              </h4>
              <Pill tone="info">Current selection: {selectedProvider === "none" ? "Disabled" : selectedProvider}</Pill>
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              <Button variant={selectedProvider === "openai" ? "filled" : "outlined"} onClick={() => setSelectedProvider("openai")}>
                Use OpenAI
              </Button>
              <Button variant={selectedProvider === "anthropic" ? "filled" : "outlined"} onClick={() => setSelectedProvider("anthropic")}>
                Use Anthropic
              </Button>
              <Button variant={selectedProvider === "none" ? "danger" : "outlined"} onClick={() => setSelectedProvider("none")}>
                Disable provider
              </Button>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <ProviderCard
                provider="openai"
                title="OpenAI"
                selected={selectedProvider === "openai"}
                hasKey={seed.openai.hasKey}
                model={openaiModel}
                keyValue={openaiKeyInput}
                disabled={isUpdatingKey}
                modelOptions={["gpt-5.4"]}
                onSelect={() => setSelectedProvider("openai")}
                onModelChange={setOpenaiModel}
                onKeyValueChange={setOpenaiKeyInput}
                onUpdateKey={() => void setProviderKey("openai", openaiKeyInput)}
                onClearKey={() => void clearProviderKey("openai")}
              />
              <ProviderCard
                provider="anthropic"
                title="Anthropic"
                selected={selectedProvider === "anthropic"}
                hasKey={seed.anthropic.hasKey}
                model={anthropicModel}
                keyValue={anthropicKeyInput}
                disabled={isUpdatingKey}
                modelOptions={["claude-opus-4-6", "claude-sonnet-4-6"]}
                onSelect={() => setSelectedProvider("anthropic")}
                onModelChange={setAnthropicModel}
                onKeyValueChange={setAnthropicKeyInput}
                onUpdateKey={() => void setProviderKey("anthropic", anthropicKeyInput)}
                onClearKey={() => void clearProviderKey("anthropic")}
              />
            </div>
          </section>

          <Card tone="inset">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 className="text-xl font-semibold tracking-[-0.03em] text-anno-text-main">Advanced controls</h4>
                <p className="mt-2 text-sm text-anno-text-muted">Use these only when you need to tune startup pacing or long-running suggestion behavior.</p>
              </div>
              <Button variant="quiet" onClick={() => setShowAdvanced((value) => !value)}>
                {showAdvanced ? "Hide advanced settings" : "Show advanced settings"}
              </Button>
            </div>

            {showAdvanced ? (
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <Field label="Reasoning preset">
                  <select className={inputClassName} value={reasoningPreset} onChange={(event) => setReasoningPreset(event.target.value as ReasoningPreset)}>
                    <option value="high">High</option>
                    <option value="balanced">Balanced</option>
                    <option value="low">Low</option>
                  </select>
                </Field>

                <Field label="Prefetch buffer size">
                  <input
                    className={inputClassName}
                    type="number"
                    min={1}
                    max={32}
                    value={prefetchBufferSize}
                    onChange={(event) => setPrefetchBufferSize(Number(event.target.value))}
                  />
                </Field>

                <Field label="Editor warmup threshold ratio" hint="Fraction of prefetched faces that must be ready before entering the editor automatically.">
                  <input
                    className={inputClassName}
                    type="number"
                    min={0.1}
                    max={1}
                    step={0.1}
                    value={editorWarmupThresholdRatio}
                    onChange={(event) => setEditorWarmupThresholdRatio(Number(event.target.value))}
                  />
                </Field>

                <Field label="Editor warmup timeout (ms)" hint="Base timeout, extended briefly when progress continues.">
                  <input
                    className={inputClassName}
                    type="number"
                    min={2000}
                    max={60000}
                    step={500}
                    value={editorWarmupTimeoutMs}
                    onChange={(event) => setEditorWarmupTimeoutMs(Number(event.target.value))}
                  />
                </Field>
              </div>
            ) : null}
          </Card>

          {providerValidation ? <Alert tone="danger">{providerValidation}</Alert> : null}
          {saveFeedback ? <Alert tone="success">{saveFeedback}</Alert> : null}
          {saveError ? <Alert tone="danger">Failed to update settings: {saveError}</Alert> : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-anno-line/80 pt-5">
            <p className="text-sm text-anno-text-muted">
              Effective config: {llmSuggestionsEnabled ? "Suggestions enabled" : "Suggestions disabled"}, {preset} profile.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setIsSaving(true);
                  setSaveError("");
                  void onSave({
                    llmSuggestionsEnabled,
                    reasoningPreset,
                    prefetchBufferSize,
                    editorWarmupThresholdRatio,
                    editorWarmupTimeoutMs,
                    openai: { enabled: selectedProvider === "openai", model: openaiModel },
                    anthropic: { enabled: selectedProvider === "anthropic", model: anthropicModel },
                  })
                    .then(() => {
                      setSaveFeedback("Settings saved.");
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
                disabled={Boolean(providerValidation) || isSaving || isUpdatingKey}
              >
                {isSaving ? "Saving…" : "Save"}
              </Button>
              <Button variant="outlined" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
