import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MODEL_CATALOG, PROVIDER_LABELS, modelFor, type Provider, type Settings } from "../models";
import { ChipIcon, KeyIcon, LayersIcon } from "./icons";
import { DEFAULT_GREETINGS } from "../greetings";

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
    openrouter: false,
  });
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

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
    invoke<Record<Provider, boolean>>("provider_status")
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }

  useEffect(refreshStatus, []);

  function setProvider(next: Provider) {
    setKeyInput("");
    setEditingKey(false);
    setShowKey(false);
    setConfirmRemove(false);
    setError("");
    clearCommitTimer();
    setCustomPickedProvider(null);
    onChange({ ...settings, ai: { ...settings.ai, provider: next } });
  }

  function setModel(next: string) {
    const key = `${provider}_model`;
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
    if (!keyInput.trim() || keyBusy) return;
    setKeyBusy(true);
    try {
      setError("");
      await invoke("set_api_key", { provider, key: keyInput.trim() });
      setKeyInput("");
      setEditingKey(false);
      setShowKey(false);
      setStatus((current) => ({ ...current, [provider]: true }));
    } catch (e) {
      setError(String(e));
    } finally {
      setKeyBusy(false);
    }
  }

  async function removeKey() {
    if (keyBusy) return;
    setKeyBusy(true);
    try {
      setError("");
      await invoke("delete_api_key", { provider });
      setStatus((current) => ({ ...current, [provider]: false }));
      setConfirmRemove(false);
      setKeyInput("");
    } catch (e) {
      setError(String(e));
    } finally {
      setKeyBusy(false);
    }
  }

  return (
    <div className="set-section">
      <div className="set-page-head">
        <h2 className="set-title">AI</h2>
        <p className="set-subtitle">
          A familiar voice when you open AI. Personalize what Synapse says hello with.
        </p>
      </div>

      <h3 className="set-card-title">Greetings</h3>
      <div className="set-card">
        <label className="set-card-row set-greetings">
          <span className="set-label">Custom greetings</span>
          <span className="set-sublabel" id="greetings-help">
            One greeting per line. Synapse picks one at random each time you open AI. Leave this
            blank to use the five built-in greetings.
          </span>
          <textarea
            className="set-input"
            rows={5}
            maxLength={4000}
            aria-describedby="greetings-help"
            placeholder={DEFAULT_GREETINGS.join("\n")}
            value={settings.ai.custom_greetings ?? ""}
            onChange={(event) =>
              onChange({
                ...settings,
                ai: { ...settings.ai, custom_greetings: event.target.value },
              })
            }
          />
        </label>
      </div>
      <p className="set-hint">
        Greetings and replies use the voice selected in Voice settings. Speak at any time to
        interrupt.
      </p>

      <h3 className="set-card-title">Computer assistant</h3>
      <div className="set-card">
        <label className="set-card-row">
          <span className="set-label-stack">
            <span className="set-label">Hybrid desktop control</span>
            <span className="set-sublabel">
              ~typesafe/jev-latest via OpenRouter · GPT-4o Mini for planning and replies
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.ai.hybrid ?? true}
            onChange={(event) =>
              onChange({ ...settings, ai: { ...settings.ai, hybrid: event.target.checked } })
            }
          />
        </label>
      </div>
      <p className="set-hint">
        Uses your saved OpenRouter and OpenAI keys. During tasks, relevant window text is shared; a
        window screenshot is shared when needed. Routine clicks, typing and navigation run
        automatically. Sensitive actions and unverified screen targets still need review. Press
        Ctrl+Alt+Escape anywhere to stop, or speak to interrupt. Costs and your daily limit are in
        Usage. Action results are in Conversations.
      </p>

      <h3 className="set-card-title">Connections &amp; chat model</h3>
      <div className="set-card">
        <label className="set-card-row">
          <span className="set-row-icon">
            <ChipIcon />
          </span>
          <span className="set-label">Provider</span>
          <div className="set-control">
            <select
              className="set-input"
              disabled={keyBusy}
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
                placeholder={provider === "openrouter" ? "provider/model-name" : "Model ID"}
                value={customDraft}
                onChange={(e) => onCustomInput(e.target.value)}
                onBlur={onCustomBlur}
              />
            </div>
          </label>
        )}

        {provider === "openrouter" && (
          <p className="set-card-row set-sublabel">
            Choose Custom to use any OpenRouter chat model. Paste its full model ID, such as
            openai/gpt-4o. Auto lets OpenRouter choose a model.
          </p>
        )}

        <div className="set-card-row">
          <span className="set-row-icon">
            <KeyIcon />
          </span>
          <span className="set-label-stack">
            <span className="set-label">API key</span>
            <span className="set-sublabel">
              {status[provider]
                ? "Saved securely in your system keychain"
                : "Connect your own account to use AI"}
            </span>
          </span>
          {status[provider] && !editingKey && (
            <div className="set-control">
              {confirmRemove ? (
                <>
                  <span className="set-note">Remove saved key?</span>
                  <button className="set-btn set-btn-danger" disabled={keyBusy} onClick={removeKey}>
                    Remove key
                  </button>
                  <button
                    className="set-btn set-btn-quiet"
                    disabled={keyBusy}
                    onClick={() => setConfirmRemove(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="set-btn set-btn-quiet" onClick={() => setEditingKey(true)}>
                    Change key
                  </button>
                  <button className="set-btn set-btn-quiet" onClick={() => setConfirmRemove(true)}>
                    Remove
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {(!status[provider] || editingKey) && (
          <form
            className="set-key-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveKey();
            }}
          >
            <label className="set-label" htmlFor="provider-api-key">
              {editingKey ? "Replace" : "Add"} {PROVIDER_LABELS[provider]} API key
            </label>
            <div className="set-key-entry">
              <input
                id="provider-api-key"
                className="set-input"
                type={showKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste your API key"
                value={keyInput}
                disabled={keyBusy}
                onChange={(event) => setKeyInput(event.target.value)}
              />
              <button
                type="button"
                className="set-btn set-btn-quiet"
                aria-pressed={showKey}
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
            <div className="set-actions">
              <button className="set-btn" disabled={!keyInput.trim() || keyBusy}>
                {keyBusy ? "Saving…" : "Save key"}
              </button>
              {status[provider] && (
                <button
                  type="button"
                  className="set-btn set-btn-quiet"
                  disabled={keyBusy}
                  onClick={() => {
                    setEditingKey(false);
                    setKeyInput("");
                    setShowKey(false);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      {error && (
        <div className="set-error" role="alert">
          {error}
        </div>
      )}
      <p className="set-hint">
        Keys are stored in the Windows Credential Manager, never in Synapse's settings file.
      </p>
    </div>
  );
}
