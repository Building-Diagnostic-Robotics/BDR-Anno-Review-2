import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LlmProviderId, LlmSettingsResponse, ReasoningPreset, SaveLlmSettingsRequest } from "./types";
import { Button, Field } from "./ui-primitives";

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
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="LLM settings">
      <div className="modal-card" ref={modalRef}>
        <div className="row spread">
          <h3>LLM settings</h3>
          <Button variant="outlined" onClick={onClose} aria-label="Close LLM settings">
            Close
          </Button>
        </div>
        <p className="hint">Default behavior is optimized for low-friction suggestions. Use Advanced only when tuning is needed.</p>

        <section className="settings-group">
          <h4>General</h4>
          <label className="row spread">
            <span>Enable suggestions</span>
            <input
              ref={firstControlRef}
              type="checkbox"
              checked={llmSuggestionsEnabled}
              onChange={(e) => setLlmSuggestionsEnabled(e.target.checked)}
            />
          </label>

          <Field label="Provider">
            <select value={selectedProvider} onChange={(event) => setSelectedProvider(event.target.value as "openai" | "anthropic" | "none") }>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="none">Disabled</option>
            </select>
          </Field>

          <Field label="Preset" hint="Fast prioritizes speed, Quality prioritizes accuracy.">
            <div className="row compact">
              <Button variant={preset === "Fast" ? "filled" : "outlined"} onClick={() => applyPreset("Fast")}>Fast</Button>
              <Button variant={preset === "Balanced" ? "filled" : "outlined"} onClick={() => applyPreset("Balanced")}>Balanced</Button>
              <Button variant={preset === "Quality" ? "filled" : "outlined"} onClick={() => applyPreset("Quality")}>Quality</Button>
            </div>
          </Field>
        </section>

        <section className="settings-group">
          <h4>Credentials</h4>
          <Field label={`OpenAI model${seed.openai.maskedKeyPreview ? ` (saved key: ${seed.openai.maskedKeyPreview})` : ""}`}>
            <select value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)}>
              <option value="gpt-5.2">gpt-5.2</option>
            </select>
          </Field>
          <div className="row">
            <input
              type={showOpenaiKey ? "text" : "password"}
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
              placeholder="sk-..."
            />
            <Button variant="tonal" onClick={() => setShowOpenaiKey((v) => !v)}>{showOpenaiKey ? "Hide" : "Show"}</Button>
            <Button variant="outlined" onClick={() => void onClearProviderKey("openai")}>Clear key</Button>
          </div>

          <Field label={`Anthropic model${seed.anthropic.maskedKeyPreview ? ` (saved key: ${seed.anthropic.maskedKeyPreview})` : ""}`}>
            <select value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)}>
              <option value="claude-opus-4-6">claude-opus-4-6</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
            </select>
          </Field>
          <div className="row">
            <input
              type={showAnthropicKey ? "text" : "password"}
              value={anthropicApiKey}
              onChange={(e) => setAnthropicApiKey(e.target.value)}
              placeholder="sk-ant-..."
            />
            <Button variant="tonal" onClick={() => setShowAnthropicKey((v) => !v)}>{showAnthropicKey ? "Hide" : "Show"}</Button>
            <Button variant="outlined" onClick={() => void onClearProviderKey("anthropic")}>Clear key</Button>
          </div>
        </section>

        <section className="settings-group">
          <h4>Advanced</h4>
          <button className="link-button" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "Hide" : "Show"} advanced settings</button>
          {showAdvanced ? (
            <>
              <Field label="Reasoning preset">
                <select value={reasoningPreset} onChange={(e) => setReasoningPreset(e.target.value as ReasoningPreset)}>
                  <option value="high">High</option>
                  <option value="balanced">Balanced</option>
                  <option value="low">Low</option>
                </select>
              </Field>

              <Field label="Prefetch buffer size">
                <input type="number" min={1} max={32} value={prefetchBufferSize} onChange={(e) => setPrefetchBufferSize(Number(e.target.value))} />
              </Field>
            </>
          ) : null}
        </section>

        {providerValidation ? <p className="error">{providerValidation}</p> : null}

        <div className="row">
          <Button
            onClick={() =>
              void onSave({
                llmSuggestionsEnabled,
                reasoningPreset,
                prefetchBufferSize,
                openai: { enabled: selectedProvider === "openai", model: openaiModel },
                anthropic: { enabled: selectedProvider === "anthropic", model: anthropicModel },
                openaiApiKey: openaiApiKey || undefined,
                anthropicApiKey: anthropicApiKey || undefined,
              })
            }
            disabled={Boolean(providerValidation)}
          >
            Save
          </Button>
          <Button variant="outlined" onClick={onClose}>Close</Button>
        </div>
        <p className="hint">Effective config: {llmSuggestionsEnabled ? "Suggestions enabled" : "Suggestions disabled"}, {preset} profile.</p>
      </div>
    </div>
  );
}
