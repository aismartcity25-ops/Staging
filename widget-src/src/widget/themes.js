// Configurazione temi — identica a DEFAULT_CONFIG/THEMES in widget.js originale.

export const DEFAULT_CONFIG = {
  product: 'comunicai',
  searchUrls: [],
  instructions: '',
  clientUrl: '',
  demoId: '',
  apiEndpoint: '/api/chat/message',
  theme: 'auto',
  colors: null, // Colori custom: { primary, secondary, userBg, userText, aiBg, aiText }
  style: null // Stile custom: { borderRadius, position, sizePreset, glass } — vedi resolveStyle()
};

// Default = valori hardcoded ATTUALI del CSS, cosi' le demo esistenti senza
// campo `style` restano visivamente identiche a prima di questa estensione.
export const DEFAULT_STYLE = {
  borderRadius: { window: 24, bubble: 32 }, // px — window: 1.5em@16px, bubble: 2em@16px
  position: 'bottom-right', // 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  sizePreset: 'standard', // 'compact' | 'standard' | 'large'
  glass: { blur: 24, saturate: 200, opacity: 0.12 } // px, %, 0-1 — = --cw-glass-blur/-saturate/-bg-opacity di default
};

export const SIZE_PRESETS = {
  compact: { width: 380, height: 560 },
  standard: { width: 460, height: 640 }, // = default attuale in useResizableWindow.js
  large: { width: 540, height: 760 }
};

const POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

function clampNum(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Calcola lo stile effettivo unendo i default con eventuali override custom
 * passati via props. Difensivo: qualunque campo mancante/malformato ricade
 * sempre sul default, mai NaN/undefined propagato a runtime.
 */
export function resolveStyle(style) {
  const s = style || {};
  const br = s.borderRadius || {};
  const glass = s.glass || {};
  return {
    borderRadius: {
      window: clampNum(br.window, 0, 32, DEFAULT_STYLE.borderRadius.window),
      bubble: clampNum(br.bubble, 0, 32, DEFAULT_STYLE.borderRadius.bubble)
    },
    position: POSITIONS.includes(s.position) ? s.position : DEFAULT_STYLE.position,
    sizePreset: SIZE_PRESETS[s.sizePreset] ? s.sizePreset : DEFAULT_STYLE.sizePreset,
    glass: {
      blur: clampNum(glass.blur, 0, 40, DEFAULT_STYLE.glass.blur),
      saturate: clampNum(glass.saturate, 100, 300, DEFAULT_STYLE.glass.saturate),
      opacity: clampNum(glass.opacity, 0, 0.4, DEFAULT_STYLE.glass.opacity)
    }
  };
}

export const THEMES = {
  comunicai: {
    name: 'ComunicAI',
    primary: '#22c55e',
    secondary: '#16a34a',
    headerBg: '#22c55e',
    glowColor: '#22c55e',
    glowColorAlt: '#16a34a',
    logo: '/Loghi/comunicai.png'
  },
  medicai: {
    name: 'MedicAI',
    primary: '#00b4ff',
    secondary: '#0066cc',
    headerBg: '#00b4ff',
    glowColor: '#00b4ff',
    glowColorAlt: '#0066cc',
    logo: '/Loghi/medicai.png'
  }
};

// Suggerimenti di fallback per prodotto (usati se l'API demo non ne fornisce).
export const FALLBACK_SUGGESTIONS = {
  medicai: [
    'Quali servizi medici offrite?',
    'Come prenotare una visita?',
    'Orari di apertura'
  ],
  comunicai: [
    'Come posso richiedere un certificato?',
    'Informazioni sulla TARI',
    'Orari ufficio anagrafe'
  ]
};

export const FALLBACK_WELCOME = {
  medicai:
    '👋 Benvenuto in MedicAI! Sono un assistente intelligente per i servizi sanitari. Cosa vuoi sapere?',
  comunicai:
    '👋 Benvenuto in ComunicAI! Sono un assistente intelligente per i servizi comunali. Cosa vuoi sapere?'
};

/**
 * Calcola il tema effettivo unendo il tema di prodotto con eventuali
 * colori custom passati via props (stessa logica del widget originale).
 */
export function resolveTheme(product, colors) {
  const baseTheme = THEMES[product] || THEMES.comunicai;
  if (!colors) return baseTheme;
  return {
    ...baseTheme,
    primary: colors.primary || baseTheme.primary,
    secondary: colors.secondary || baseTheme.secondary,
    headerBg: colors.primary || baseTheme.headerBg,
    glowColor: colors.primary || baseTheme.glowColor,
    glowColorAlt: colors.secondary || baseTheme.glowColorAlt,
    userBg: colors.userBg || '#3b82f6',
    userText: colors.userText || '#ffffff',
    aiBg: colors.aiBg || '#e5e7eb',
    aiText: colors.aiText || '#1f2937'
  };
}

/** Estrae la hue (0-360) da un colore esadecimale, per le particelle dello shatter. */
export function hueFromHex(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substr(0, 2), 16) / 255;
  const g = parseInt(h.substr(2, 2), 16) / 255;
  const b = parseInt(h.substr(4, 2), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    switch (max) {
      case r:
        hue = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        hue = (b - r) / d + 2;
        break;
      case b:
        hue = (r - g) / d + 4;
        break;
      default:
        break;
    }
    hue *= 60;
  }
  return Math.round(hue);
}

export function getParticleHue(product, colors) {
  if (colors && colors.primary) return hueFromHex(colors.primary);
  return product === 'medicai' ? 200 : 150;
}
