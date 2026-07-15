import { useState } from 'react';
import ChatWidget from './widget/ChatWidget.jsx';
import GlassControls from './widget/GlassControls.jsx';

const DEFAULT_COLORS = {
  primary: '#1a8c5c',
  secondary: '#13a06a',
  userBg: '#3b82f6',
  userText: '#ffffff',
  aiBg: '#e5e7eb',
  aiText: '#1f2937'
};

const COLOR_FIELDS = [
  { key: 'primary', label: 'Colore principale' },
  { key: 'secondary', label: 'Colore secondario' },
  { key: 'userBg', label: 'Sfondo messaggi utente' },
  { key: 'userText', label: 'Testo messaggi utente' },
  { key: 'aiBg', label: 'Sfondo messaggi AI' },
  { key: 'aiText', label: 'Testo messaggi AI' }
];

export default function App() {
  const [product, setProduct] = useState('comunicai');
  const [colors, setColors] = useState(DEFAULT_COLORS);

  const handleColorChange = (key, value) => {
    setColors((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="landing-container">
      <h1 className="landing-title">🏛️ Chatbot Widget</h1>
      <p className="landing-subtitle">React Component — Liquid Glass Bubble</p>
      <span className="demo-badge">DEMO — Conversione React 1:1 del widget originale</span>

      <div className="product-toggle">
        <button
          className={product === 'comunicai' ? 'active' : ''}
          onClick={() => setProduct('comunicai')}
        >
          ComunicAI
        </button>
        <button
          className={product === 'medicai' ? 'active' : ''}
          onClick={() => setProduct('medicai')}
        >
          MedicAI
        </button>
      </div>

      <div className="features">
        <div className="feature-card">
          <h3>💎 Liquid Glass Effect</h3>
          <p>Effetto vetro liquido con trasparenza e riflessi.</p>
        </div>
        <div className="feature-card">
          <h3>✨ Shatter Animation</h3>
          <p>Animazione di frammentazione quando si apre la chat.</p>
        </div>
        <div className="feature-card">
          <h3>🎨 Color Schemes</h3>
          <p>Supporto per diversi temi colore (ComunicAI verde, MedicAI blu).</p>
        </div>
        <div className="feature-card">
          <h3>📱 Responsive</h3>
          <p>Design adattabile a diverse dimensioni di schermo.</p>
        </div>
      </div>

      <div className="color-picker-section">
        <h2>🎨 Personalizza Colori Chatbot</h2>
        <div className="color-grid">
          {COLOR_FIELDS.map(({ key, label }) => (
            <div className="color-field" key={key}>
              <label htmlFor={`color-${key}`}>{label}</label>
              <div className="color-input-wrap">
                <input
                  type="color"
                  id={`color-${key}`}
                  value={colors[key]}
                  onChange={(e) => handleColorChange(key, e.target.value)}
                />
                <input
                  type="text"
                  className="color-text"
                  value={colors[key]}
                  onChange={(e) => {
                    if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) handleColorChange(key, e.target.value);
                    else handleColorChange(key, e.target.value); // consente digitazione libera
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="color-preview">
          <span>Anteprima:</span>
          <div className="preview-chat">
            <div className="preview-ai-msg" style={{ background: colors.aiBg, color: colors.aiText }}>
              Ciao! Come posso aiutarti?
            </div>
            <div className="preview-user-msg" style={{ background: colors.userBg, color: colors.userText }}>
              Vorrei informazioni
            </div>
          </div>
        </div>
      </div>

      <p style={{ marginTop: '2rem', opacity: 0.7 }}>Clicca sulla bolla per vedere l'animazione!</p>

      <ChatWidget key={product} product={product} colors={colors} demoId="reference-demo" />
      <GlassControls />
    </div>
  );
}
