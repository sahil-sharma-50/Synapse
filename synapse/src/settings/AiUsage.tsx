import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "../models";

interface Usage {
  day: string;
  provider: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  uncertain: number;
}
const money = (amount: number) => `$${amount.toFixed(amount > 0 && amount < 0.01 ? 6 : 2)}`;
function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function AiUsage({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const [rows, setRows] = useState<Usage[]>([]);
  const [days, setDays] = useState(7);
  const [metric, setMetric] = useState<"cost" | "requests">("cost");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [budgetError, setBudgetError] = useState("");
  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    const refresh = async () => {
      const version = ++sequence;
      try {
        const result = await invoke<Usage[]>("get_ai_usage");
        if (!disposed && sequence === version) {
          setRows(result);
          setError("");
        }
      } catch (cause) {
        if (!disposed) setError(String(cause));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    const subscription = listen("ai-usage-changed", () => void refresh());
    void subscription.then(refresh).catch((cause) => {
      if (!disposed) {
        setError(String(cause));
        setLoading(false);
      }
    });
    const timer = window.setInterval(() => void refresh(), 60000);
    return () => {
      disposed = true;
      clearInterval(timer);
      void subscription.then((stop) => stop());
    };
  }, []);
  const today = dayKey(new Date());
  const dates = Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - days + index + 1);
    return dayKey(date);
  });
  const selected = rows.filter((row) => row.day >= dates[0] && row.day <= today);
  const cost = selected.reduce((sum, row) => sum + row.cost, 0);
  const requests = selected.reduce((sum, row) => sum + row.requests, 0);
  const tokens = selected.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0);
  const uncertain = selected.reduce((sum, row) => sum + row.uncertain, 0);
  const todayCost = rows.filter((row) => row.day === today).reduce((sum, row) => sum + row.cost, 0);
  const budget = settings.ai.daily_budget ?? 1;
  const series = dates.map((day) => ({
    day,
    value: selected.filter((row) => row.day === day).reduce((sum, row) => sum + row[metric], 0),
  }));
  const maximum = Math.max(...series.map((point) => point.value)) || (metric === "cost" ? 0.01 : 1);
  const models = new Map<string, Usage>();
  for (const row of selected) {
    const key = `${row.provider}/${row.model}`;
    const prior = models.get(key);
    models.set(
      key,
      prior
        ? {
            ...row,
            requests: prior.requests + row.requests,
            input_tokens: prior.input_tokens + row.input_tokens,
            output_tokens: prior.output_tokens + row.output_tokens,
            cost: prior.cost + row.cost,
            uncertain: prior.uncertain + row.uncertain,
          }
        : { ...row },
    );
  }
  return (
    <section className="set-section" aria-labelledby="usage-title">
      <div className="set-page-head">
        <h2 className="set-title" id="usage-title">
          Usage
        </h2>
        <p className="set-subtitle">
          Your assistant, by the numbers. Synapse requests on this device only. All costs are USD.
        </p>
      </div>
      <div className="set-actions" aria-label="Usage period">
        {[
          [1, "Today"],
          [7, "7 days"],
          [30, "Month"],
        ].map(([count, label]) => (
          <button
            className="set-btn set-btn-quiet"
            key={count}
            aria-pressed={days === count}
            onClick={() => setDays(Number(count))}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="set-error">
          Could not load usage: {error}
        </p>
      )}
      <div className="set-usage-totals">
        <div className="set-card">
          <span className="set-sublabel">Cost &amp; reservations</span>
          <strong>{money(cost)}</strong>
        </div>
        <div className="set-card">
          <span className="set-sublabel">Requests</span>
          <strong>{requests.toLocaleString()}</strong>
        </div>
        <div className="set-card">
          <span className="set-sublabel">Tokens</span>
          <strong>{tokens.toLocaleString()}</strong>
        </div>
      </div>
      <div className="set-card set-usage-chart">
        <div className="set-actions">
          <h3 className="set-card-title">Daily activity</h3>
          <label>
            Measure{" "}
            <select
              className="set-input"
              value={metric}
              onChange={(event) => setMetric(event.target.value as "cost" | "requests")}
            >
              <option value="cost">Cost (USD)</option>
              <option value="requests">Requests</option>
            </select>
          </label>
        </div>
        <svg
          viewBox="0 0 640 200"
          role="img"
          aria-labelledby="usage-chart-title"
          aria-describedby="usage-chart-desc"
        >
          <title id="usage-chart-title">
            Daily {metric} over {days} {days === 1 ? "day" : "days"}
          </title>
          <desc id="usage-chart-desc">
            {series
              .map(
                (point) => `${point.day}: ${metric === "cost" ? money(point.value) : point.value}`,
              )
              .join("; ")}
          </desc>
          <text x="0" y="16">
            {metric === "cost" ? money(maximum) : maximum}
          </text>
          <line x1="60" y1="160" x2="630" y2="160" />
          {series.map((point, index) => {
            const width = 560 / days;
            const height = (point.value / maximum) * 120;
            return (
              <g key={point.day}>
                <rect
                  x={65 + index * width}
                  y={160 - Math.max(1, height)}
                  width={Math.max(2, width - 5)}
                  height={Math.max(1, height)}
                >
                  <title>
                    {point.day}: {metric === "cost" ? money(point.value) : point.value}
                  </title>
                </rect>
                {(index === 0 || index === days - 1 || (days === 7 && index === 3)) && (
                  <text x={65 + index * width} y="184">
                    {point.day.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {loading ? (
          <p role="status">Loading usage…</p>
        ) : (
          !requests && (
            <p className="set-hint">
              No requests in this period. Tracking starts with this update.
            </p>
          )
        )}
      </div>
      <h3 className="set-card-title">By model</h3>
      <div className="set-card set-usage-table">
        <table>
          <caption className="set-sublabel">
            Requests, tokens and costs for the selected period
          </caption>
          <thead>
            <tr>
              <th scope="col">Model / provider</th>
              <th scope="col">Requests</th>
              <th scope="col">In / out tokens</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {[...models]
              .sort((a, b) => b[1].cost - a[1].cost)
              .map(([key, row]) => (
                <tr key={key}>
                  <th scope="row">
                    {row.model}
                    <small>{row.provider}</small>
                    <meter
                      aria-label={`${row.model} share of cost`}
                      min="0"
                      max={cost || 0.01}
                      value={row.cost}
                    />
                  </th>
                  <td>{row.requests}</td>
                  <td>
                    {row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}
                  </td>
                  <td>
                    {money(row.cost)}
                    {row.uncertain ? " *" : ""}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="set-hint">
        {uncertain ? `* ${uncertain} requests have estimated or reserved costs. ` : ""}
        OpenRouter reports actual cost. Direct-provider costs use listed token rates. Requests
        without final billing stay reserved; tokens are counted only when reported. Earlier
        conversations have no usage data. Month shows the past 30 days.
      </p>
      <h3 className="set-card-title">Daily limit</h3>
      <div className="set-card">
        <label className="set-card-row">
          <span className="set-label-stack">
            <span className="set-label">Maximum per day (USD)</span>
            <span className="set-sublabel">
              Resets at local midnight. Applies to all new Synapse AI requests.
            </span>
          </span>
          <input
            className="set-input set-usage-budget"
            type="number"
            min="0.01"
            max="100"
            step="0.01"
            defaultValue={budget}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (!Number.isFinite(value) || value < 0.01 || value > 100) {
                setBudgetError("Choose a daily limit between $0.01 and $100.");
                return;
              }
              setBudgetError("");
              onChange({ ...settings, ai: { ...settings.ai, daily_budget: value } });
            }}
          />
        </label>
        <div className="set-card-row">
          <label className="set-label-stack">
            {money(todayCost)} of {money(budget)} today
            <progress
              aria-label="Today's budget used"
              max={budget}
              value={Math.min(todayCost, budget)}
            />
          </label>
        </div>
      </div>
      {budgetError && (
        <p className="set-error" role="alert">
          {budgetError}
        </p>
      )}
      <p className="set-hint">
        New paid requests stop before their reservation exceeds the remaining budget. Local
        listening, speech and stopping stay available.
      </p>
    </section>
  );
}
