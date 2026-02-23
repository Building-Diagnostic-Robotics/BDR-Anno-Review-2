import React, { useMemo, useState } from "react";
import type { LlmProviderId, LlmSettingsResponse, ReasoningPreset, SaveLlmSettingsRequest } from "./types";

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
        llmSuggestionsEnabled: false,
        reasoningPreset: "high" as ReasoningPreset,
        prefetchBufferSize: 8,
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

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="LLM settings">
      <div className="modal-card">
        <h3>LLM settings</h3>
        <label className="row">
          <span>Enable suggestions feature flag</span>
          <input type="checkbox" checked={llmSuggestionsEnabled} onChange={(e) => setLlmSuggestionsEnabled(e.target.checked)} />
        </label>

        <label>Reasoning preset</label>
        <select value={reasoningPreset} onChange={(e) => setReasoningPreset(e.target.value as ReasoningPreset)}>
          <option value="high">High</option>
          <option value="balanced">Balanced</option>
          <option value="low">Low</option>
        </select>

        <label>Prefetch buffer size</label>
        <input type="number" min={1} max={32} value={prefetchBufferSize} onChange={(e) => setPrefetchBufferSize(Number(e.target.value))} />

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
          <button onClick={() => setShowOpenaiKey((v) => !v)}>{showOpenaiKey ? "Hide" : "Show"}</button>
          <button onClick={() => void onClearProviderKey("openai")}>Clear key</button>
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
          <button onClick={() => setShowAnthropicKey((v) => !v)}>{showAnthropicKey ? "Hide" : "Show"}</button>
          <button onClick={() => void onClearProviderKey("anthropic")}>Clear key</button>
        </div>

        <div className="row">
          <button
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
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
