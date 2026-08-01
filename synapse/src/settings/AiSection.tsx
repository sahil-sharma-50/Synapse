import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MODEL_CATALOG,
  PROVIDER_LABELS,
  modelFor,
  type Provider,
  type Settings,
} from "../models";

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
  // does. `customPicked` tracks "user just chose Custom… from the dropdown"
  // before they've typed anything, so the field can appear without ever
  // persisting an empty model string.
  const [customPicked, setCustomPicked] = useState(false);
  const [customDraft, setCustomDraft] = useState(isCustom ? model : "");
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Switching provider swaps which model this UI is editing, so the local
  // draft has to be re-derived for the new provider rather than carrying
  // over stale text from the previous one.
  useEffect(() => {
    setCustomPicked(false);
    setCustomDraft(isCustom ? model : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    return () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
    };
  }, []);

  function refreshStatus() {
    invoke<Record<Provider, boolean>>("provider_status").then(setStatus);
  }

  useEffect(refreshStatus, []);

  function setProvider(next: Provider) {
    onChange({ ...settings, ai: { ...settings.ai, provider: next } });
  }

  function setModel(next: string) {
    const key = provider === "anthropic" ? "anthropic_model" : "openai_model";
    onChange({ ...settings, ai: { ...settings.ai, [key]: next } });
  }

  function selectModel(value: string) {
    if (value === CUSTOM) {
      // Reveal the custom field without persisting an empty model string —
      // only committing actual typed text should trigger a settings write.
      setCustomPicked(true);
      setCustomDraft(isCustom ? model : "");
      return;
    }
    setCustomPicked(false);
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
    setCustomDraft(value);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => commitCustom(value), 400);
  }

  function onCustomBlur() {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitCustom(customDraft);
  }

  const showCustomField = isCustom || customPicked;

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
      <h2 className="set-title">AI</h2>

      <label className="set-row">
        <span className="set-label">Provider</span>
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
      </label>

      <label className="set-row">
        <span className="set-label">Model</span>
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
      </label>

      {showCustomField && (
        <label className="set-row">
          <span className="set-label" />
          <input
            className="set-input"
            placeholder="Model ID"
            value={customDraft}
            onChange={(e) => onCustomInput(e.target.value)}
            onBlur={onCustomBlur}
          />
        </label>
      )}

      <div className="set-row">
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
            placeholder={`${PROVIDER_LABELS[provider]} API key`}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveKey()}
          />
          <button className="set-btn" onClick={saveKey}>
            Save
          </button>
          {status[provider] && (
            <button className="set-btn set-btn-quiet" onClick={removeKey}>
              Remove
            </button>
          )}
        </div>
      </div>

      {error && <div className="set-error">{error}</div>}
      <p className="set-hint">
        Keys are stored in the Windows Credential Manager, never in Synapse's
        settings file.
      </p>
    </div>
  );
}
