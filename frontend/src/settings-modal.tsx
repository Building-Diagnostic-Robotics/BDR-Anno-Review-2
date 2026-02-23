import React, { useEffect, useMemo, useState } from "react";
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
  const [openaiEnabled, setOpenaiEnabled] = useState(seed.openai.enabled);
  const [openaiModel, setOpenaiModel] = useState(seed.openai.model);
  const [anthropicEnabled, setAnthropicEnabled] = useState(seed.anthropic.enabled);
  const [anthropicModel, setAnthropicModel] = useState(seed.anthropic.model);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const preset = useMemo(() => {
    if (reasoningPreset === "low" && prefetchBufferSize <= 4) return "Fast";
    if (reasoningPreset === "high" && prefetchBufferSize >= 10) return "Quality";
    return "Balanced";
  }, [reasoningPreset, prefetchBufferSize]);

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
    setOpenaiEnabled(seed.openai.enabled);
    setOpenaiModel(seed.openai.model);
    setAnthropicEnabled(seed.anthropic.enabled);
    setAnthropicModel(seed.anthropic.model);
    setOpenaiApiKey("");
    setAnthropicApiKey("");
    setShowOpenaiKey(false);
    setShowAnthropicKey(false);
    setShowAdvanced(false);
  }, [seed]);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="LLM settings">
      <div className="modal-card">
        <h3>LLM settings</h3>
        <p className="hint">Default behavior is optimized for low-friction suggestions. Use Advanced only when tuning is needed.</p>

        <label className="row spread">
          <span>Enable suggestions</span>
          <input type="checkbox" checked={llmSuggestionsEnabled} onChange={(e) => setLlmSuggestionsEnabled(e.target.checked)} />
        </label>

        <Field label="Provider">
          <select
            value={openaiEnabled ? "openai" : anthropicEnabled ? "anthropic" : "none"}
            onChange={(event) => {
              const provider = event.target.value;
              setOpenaiEnabled(provider === "openai");
              setAnthropicEnabled(provider === "anthropic");
            }}
          >
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

        <h4>OpenAI</h4>
        <label className="row">
          <span>Enabled</span>
          <input type="checkbox" checked={openaiEnabled} onChange={(e) => setOpenaiEnabled(e.target.checked)} />
        </label>
        <label>Model</label>
        <select value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)}>
          <option value="gpt-5.2">gpt-5.2</option>
        </select>
        <label>API key {seed.openai.maskedKeyPreview ? `(saved: ${seed.openai.maskedKeyPreview})` : ""}</label>
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

        <h4>Anthropic</h4>
        <label className="row">
          <span>Enabled</span>
          <input type="checkbox" checked={anthropicEnabled} onChange={(e) => setAnthropicEnabled(e.target.checked)} />
        </label>
        <label>Model</label>
        <select value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)}>
          <option value="claude-opus-4-6">claude-opus-4-6</option>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
        </select>
        <label>API key {seed.anthropic.maskedKeyPreview ? `(saved: ${seed.anthropic.maskedKeyPreview})` : ""}</label>
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

        <div className="row">
          <Button
            onClick={() =>
              void onSave({
                llmSuggestionsEnabled,
                reasoningPreset,
                prefetchBufferSize,
                openai: { enabled: openaiEnabled, model: openaiModel },
                anthropic: { enabled: anthropicEnabled, model: anthropicModel },
                openaiApiKey: openaiApiKey || undefined,
                anthropicApiKey: anthropicApiKey || undefined,
              })
            }
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
