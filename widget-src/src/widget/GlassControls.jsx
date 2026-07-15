import { useState } from 'react';
import './GlassControls.css';

// Porting React del pannello di controllo "Liquid Glass" (liquid-glass-integration.js).
// Espone slider per regolare le CSS custom properties --cw-glass-* che pilotano
// l'effetto vetro di bolla/finestra/header. Pensato come tool di sviluppo/calibrazione,
// non fa parte del widget in produzione.

const DEFAULT_GLASS_CONFIG = {
  edgeIntensity: 0.02,
  rimIntensity: 0.08,
  blurRadius: 6.0,
  tintOpacity: 0.25,
  rippleEffect: 0.12,
  cornerBoost: 0.02
};

const CONTROLS = [
  { key: 'edgeIntensity', label: 'Edge Intensity', min: 0, max: 0.1, step: 0.001 },
  { key: 'rimIntensity', label: 'Rim Intensity', min: 0, max: 0.2, step: 0.001 },
  { key: 'blurRadius', label: 'Blur Radius', min: 1, max: 15, step: 0.5 },
  { key: 'tintOpacity', label: 'Tint Opacity', min: 0, max: 1, step: 0.05 },
  { key: 'rippleEffect', label: 'Ripple Effect', min: 0, max: 0.5, step: 0.01 },
  { key: 'cornerBoost', label: 'Corner Boost', min: 0, max: 0.1, step: 0.002 }
];

// Stessa mappatura valore -> CSS var dell'originale.
const CSS_VAR_MAPPING = {
  blurRadius: { prop: '--cw-glass-blur', format: (v) => `${v}px` },
  tintOpacity: { prop: '--cw-glass-bg-opacity', format: (v) => v.toFixed(2) },
  edgeIntensity: { prop: '--cw-glass-border-opacity', format: (v) => Math.min(v * 3, 1).toFixed(2) },
  rimIntensity: { prop: '--cw-glass-glow-opacity', format: (v) => Math.min(v * 5, 1).toFixed(2) },
  cornerBoost: { prop: '--cw-glass-highlight-opacity', format: (v) => Math.min(0.3 + v * 5, 1).toFixed(2) },
  rippleEffect: { prop: '--cw-glass-saturate', format: (v) => `${Math.round(150 + v * 500)}%` }
};

function applyToCssVars(key, value) {
  const config = CSS_VAR_MAPPING[key];
  if (config) {
    document.documentElement.style.setProperty(config.prop, config.format(value));
  }
}

export default function GlassControls() {
  const [visible, setVisible] = useState(false);
  const [values, setValues] = useState(DEFAULT_GLASS_CONFIG);

  const handleChange = (key, raw) => {
    const val = parseFloat(raw);
    setValues((prev) => ({ ...prev, [key]: val }));
    applyToCssVars(key, val);
  };

  const handleReset = () => {
    setValues(DEFAULT_GLASS_CONFIG);
    Object.entries(DEFAULT_GLASS_CONFIG).forEach(([key, val]) => applyToCssVars(key, val));
  };

  return (
    <>
      <button className="glass-toggle-btn" title="Mostra/Nascondi controlli Liquid Glass" onClick={() => setVisible((v) => !v)}>
        🪟
      </button>
      <div className={`glass-controls-panel ${visible ? 'visible' : ''}`}>
        <h3>
          🪟 Liquid Glass
          <button id="glassResetBtn" onClick={handleReset}>
            Reset
          </button>
        </h3>
        {CONTROLS.map(({ key, label, min, max, step }) => (
          <div className="glass-control-row" key={key}>
            <label>{label}</label>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={values[key]}
              onChange={(e) => handleChange(key, e.target.value)}
            />
            <span className="value">{values[key]}</span>
          </div>
        ))}
      </div>
    </>
  );
}
