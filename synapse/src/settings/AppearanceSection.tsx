import type { Settings } from "../models";
import { WEDGES, WHEEL_GEOMETRY, iconPosition, wedgePath } from "../wedges";

export default function AppearanceSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
}) {
  const appearance = settings.appearance;
  const tools = WEDGES.filter((tool) => appearance.wheel_tools.includes(tool.id));
  const center = WHEEL_GEOMETRY.size / 2;
  return (
    <div className="set-section">
      <div className="set-page-head">
        <h2 className="set-title">Wheel & appearance</h2>
        <p className="set-subtitle">
          Choose your tools and a subtle accent. Changes appear across Synapse.
        </p>
      </div>
      <h3 className="set-card-title">Accent color</h3>
      <div className="set-color-options" role="group" aria-label="Accent color">
        {(["neutral", "blue", "violet", "amber"] as const).map((accent) => (
          <button
            key={accent}
            className="set-color-option"
            aria-pressed={appearance.accent === accent}
            onClick={() => onChange({ ...settings, appearance: { ...appearance, accent } })}
          >
            <span className={`set-swatch set-swatch-${accent}`} />
            {accent === "neutral" ? "Graphite" : accent}
          </button>
        ))}
      </div>
      <h3 className="set-card-title">Tools on your wheel</h3>
      <div className="set-card set-size-card">
        <label className="set-card-row" htmlFor="wheel-size">
          <span className="set-label-stack">
            <span className="set-label">Wheel size</span>
            <span className="set-sublabel">
              Smaller for less space, larger for easier selection
            </span>
          </span>
          <output htmlFor="wheel-size">{appearance.wheel_size}%</output>
          <button
            className="set-btn set-btn-quiet"
            disabled={appearance.wheel_size === 100}
            onClick={(event) => {
              event.preventDefault();
              onChange({ ...settings, appearance: { ...appearance, wheel_size: 100 } });
            }}
          >
            Reset size
          </button>
        </label>
        <input
          id="wheel-size"
          aria-label="Wheel size"
          type="range"
          min="75"
          max="150"
          step="5"
          value={appearance.wheel_size}
          onChange={(event) =>
            onChange({
              ...settings,
              appearance: { ...appearance, wheel_size: Number(event.target.value) },
            })
          }
        />
        <div className="set-size-labels">
          <span>Small · 75%</span>
          <span>Large · 150%</span>
        </div>
      </div>
      <div className="set-wheel-layout">
        <div className="set-card">
          {WEDGES.map((tool) => (
            <label className="set-card-row" key={tool.id}>
              <span className="set-label">{tool.label}</span>
              <input
                type="checkbox"
                className="set-switch"
                checked={appearance.wheel_tools.includes(tool.id)}
                disabled={
                  tool.id === "settings" ||
                  (tools.length === 2 && appearance.wheel_tools.includes(tool.id))
                }
                onChange={(event) =>
                  onChange({
                    ...settings,
                    appearance: {
                      ...appearance,
                      wheel_tools: event.target.checked
                        ? [...appearance.wheel_tools, tool.id]
                        : appearance.wheel_tools.filter((id) => id !== tool.id),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
        <div className="set-wheel-preview">
          <svg
            style={{ width: `${appearance.wheel_size / 1.5}%` }}
            viewBox={`0 0 ${WHEEL_GEOMETRY.size} ${WHEEL_GEOMETRY.size}`}
            role="img"
            aria-label={`Wheel preview with ${tools.length} tools`}
          >
            {tools.map((tool, index) => {
              const point = iconPosition(index, tools.length, center, center, 88);
              return (
                <g key={tool.id}>
                  <path
                    className="set-preview-slice"
                    d={wedgePath(index, tools.length, center, center, 126, 50)}
                  />
                  <path
                    className="set-preview-icon"
                    d={tool.icon}
                    transform={`translate(${point.x - 10} ${point.y - 10}) scale(.8333)`}
                  />
                </g>
              );
            })}
            <circle cx={center} cy={center} r={50} className="set-preview-hub" />
          </svg>
          <span>{tools.length} tools selected</span>
          <p>Settings stays on the wheel. Keep at least one other tool.</p>
        </div>
      </div>
    </div>
  );
}
