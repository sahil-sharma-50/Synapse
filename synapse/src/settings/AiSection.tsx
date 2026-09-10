import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MODEL_CATALOG,
  PROVIDER_LABELS,
  modelFor,
  type Provider,
  type Settings,
} from "../models";
import { ChipIcon, KeyIcon, LayersIcon } from "./icons";

const CUSTOM = "__custom__";

export default function AiSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const [status, setStatus] = useState<Record<Provider, boolean>>({
    anthropic: false,
    openai: false,
  });
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState("");

  const provider = settings.ai.provider;
  const model = modelFor(settings, provider);
  const catalog = MODEL_CATALOG[provider];
  // A model that isn't in the catalog is a custom one the user typed, so the
  // dropdown must land on "Custom…" and reveal the field pre-filled.
  const isCustom = !catalog.includes(model);

  // Local-only UI state for the custom-model text field. Kept separate from
  // `settings` so typing doesn't write settings.json (and broadcast
  // `settings-changed`) on every keystroke — only a debounced commit or blur
  // does. `customPickedProvider` tracks a provider where the user just chose
  // "Custom…" before they've typed anything, so the field can appear without
  // ever persisting an empty model string.
  const [customDrafts, setCustomDrafts] = useState<Partial<Record<Provider, string>>>({});
  const [customPickedProvider, setCustomPickedProvider] = useState<Provider | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A provider-keyed draft keeps switching providers from carrying stale text
  // into the next model field.
  const customDraft = customDrafts[provider] ?? (isCustom ? model : "");
  const showCustomField = isCustom || customPickedProvider === provider;

  function clearCommitTimer() {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
  }

  useEffect(() => {
    return () => {
      clearCommitTimer();
    };
  }, []);

  function refreshStatus() {
    invoke<Record<Provider, boolean>>("provider_status").then(setStatus).catch((e) => setError(String(e)));
  }

  useEffect(refreshStatus, []);

  function setProvider(next: Provider) {
    clearCommitTimer();
    setCustomPickedProvider(null);
    onChange({ ...settings, ai: { ...settings.ai, provider: next } });
  }

  function setModel(next: string) {
    const key = provider === "anthropic" ? "anthropic_model" : "openai_model";
    onChange({ ...settings, ai: { ...settings.ai, [key]: next } });
  }

  function selectModel(value: string) {
    clearCommitTimer();
    if (value === CUSTOM) {
      // Reveal the custom field without persisting an empty model string —
      // only committing actual typed text should trigger a settings write.
      setCustomPickedProvider(provider);
      setCustomDrafts((drafts) => ({
        ...drafts,
        [provider]: drafts[provider] ?? (isCustom ? model : ""),
      }));
      return;
    }
    setCustomPickedProvider(null);
    setModel(value);
  }

  function commitCustom(value: string) {
    const trimmed = value.trim();
    // Never persist an empty custom model — it would be sent to the API as
    // an invalid model string.
    if (!trimmed) return;
    setModel(trimmed);
  }

  function onCustomInput(value: string) {
    setCustomDrafts((drafts) => ({ ...drafts, [provider]: value }));
    clearCommitTimer();
    commitTimer.current = setTimeout(() => commitCustom(value), 400);
  }

  function onCustomBlur() {
    clearCommitTimer();
    commitCustom(customDraft);
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    try {
      setError("");
      await invoke("set_api_key", { provider, key: keyInput.trim() });
      setKeyInput("");
      refreshStatus();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeKey() {
    try {
      setError("");
      await invoke("delete_api_key", { provider });
      refreshStatus();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="set-section">
      <div className="set-page-head">
        <h2 className="set-title">AI</h2>
        <p className="set-subtitle">
          Synapse talks to your own account. Pick a provider and paste its key — there is no
          Synapse server in between.
        </p>
      </div>

      <div className="set-card-title">Connection</div>
      <div className="set-card">
        <label className="set-card-row">
          <span className="set-row-icon">
            <ChipIcon />
          </span>
          <span className="set-label">Provider</span>
          <div className="set-control">
            <select
              className="set-input"
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
        </label>

        <label className="set-card-row">
          <span className="set-row-icon">
            <LayersIcon />
          </span>
          <span className="set-label">Model</span>
          <div className="set-control">
            <select
              className="set-input"
              value={showCustomField ? CUSTOM : model}
              onChange={(e) => selectModel(e.target.value)}
            >
              {catalog.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value={CUSTOM}>Custom…</option>
            </select>
          </div>
        </label>

        {showCustomField && (
          // Indented by CSS rather than by an empty icon span standing in as a
          // spacer — this row belongs to the Model row above it, and saying so
          // in the class name survives an icon-size change.
          <label className="set-card-row set-card-subrow">
            <span className="set-label">Model ID</span>
            <div className="set-control">
              <input
                className="set-input"
                placeholder="Model ID"
                value={customDraft}
                onChange={(e) => onCustomInput(e.target.value)}
                onBlur={onCustomBlur}
              />
            </div>
          </label>
        )}

        <div className="set-card-row">
          <span className="set-row-icon">
            <KeyIcon />
          </span>
          <span className="set-label">API key</span>
          <div className="set-key">
            <span
              className={`set-badge ${status[provider] ? "set-ok" : "set-missing"}`}
            >
              {status[provider] ? "Key set" : "No key"}
            </span>
            <input
              className="set-input"
              type="password"
              aria-label={`${PROVIDER_LABELS[provider]} API key`}
              autoComplete="off"
              spellCheck={false}
              placeholder={`${PROVIDER_LABELS[provider]} API key`}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveKey()}
            />
            <button className="set-btn" onClick={saveKey} disabled={!keyInput.trim()}>
              Save
            </button>
            {status[provider] && (
              <button className="set-btn set-btn-quiet" onClick={removeKey}>
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      {error && <div className="set-error" role="alert">{error}</div>}
      <p className="set-hint">
        Keys are stored in the Windows Credential Manager, never in Synapse's
        settings file.
      </p>
    </div>
  );
}
