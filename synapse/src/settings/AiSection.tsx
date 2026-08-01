import { useEffect, useState } from "react";
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
          value={isCustom ? CUSTOM : model}
          onChange={(e) =>
            setModel(e.target.value === CUSTOM ? "" : e.target.value)
          }
        >
          {catalog.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </label>

      {isCustom && (
        <label className="set-row">
          <span className="set-label" />
          <input
            className="set-input"
            placeholder="Model ID"
            value={model}
            onChange={(e) => setModel(e.target.value)}
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
