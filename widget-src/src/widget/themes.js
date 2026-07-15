// Configurazione temi — identica a DEFAULT_CONFIG/THEMES in widget.js originale.

export const DEFAULT_CONFIG = {
  product: 'comunicai',
  searchUrls: [],
  instructions: '',
  clientUrl: '',
  demoId: '',
  apiEndpoint: '/api/chat/message',
  theme: 'auto',
  colors: null // Colori custom: { primary, secondary, userBg, userText, aiBg, aiText }
};

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
