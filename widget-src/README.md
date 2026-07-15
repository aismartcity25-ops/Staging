# Chatbot Widget — React

Conversione 1:1 in React del widget originale (`widget.js` + `widget.css`, tema
ComunicAI/MedicAI con effetto liquid glass, shatter animation, finestra
ridimensionabile, upload file/immagine, input vocale mock e TTS).

**Estetica invariata**: `src/widget/ChatWidget.css` è una copia verbatim di
`widget.css` — nessuna classe, variabile CSS o animazione è stata rinominata
o modificata. La logica di `widget.js` (già scritta con `React.createElement`)
è stata portata in JSX idiomatico e suddivisa in moduli, mantenendo lo stesso
comportamento a runtime.

## Struttura

```
src/
  App.jsx                     Pagina demo (equivalente a index.html: color picker, toggle prodotto)
  App.css                     Stili SOLO della pagina demo (non del widget)
  embed.jsx                   Entry point per la build "embed" (script singolo, API window.ChatWidget.init)
  widget/
    ChatWidget.jsx             Componente principale (bolla + finestra chat)
    ChatWidget.css             Stile del widget — copia 1:1 di widget.css originale
    Message.jsx                Bolla messaggio, citazioni, badge confidence, copia/TTS
    icons.jsx                  Tutte le icone SVG (porting da React.createElement a JSX)
    themes.js                  Temi ComunicAI/MedicAI, risoluzione colori custom, hue particelle
    particles.js                Classi Shard/Spark per l'animazione "shatter" su canvas
    useResizableWindow.js       Hook per il resize della finestra (8 handle)
    GlassControls.jsx/.css      Pannello dev per calibrare l'effetto liquid glass (da liquid-glass-integration.js)
    index.js                    Export pubblico del modulo widget
```

## Uso come componente in un'app React esistente

```jsx
import { ChatWidget } from './widget';

<ChatWidget
  product="medicai"           // 'comunicai' | 'medicai'
  demoId="reference-demo"     // opzionale: carica welcome/suggerimenti da /api/demos/:id/suggestions
  apiEndpoint="/api/chat/message"
  colors={{                   // opzionale: override colori
    primary: '#00b4ff',
    secondary: '#0066cc',
    userBg: '#3b82f6',
    userText: '#ffffff',
    aiBg: '#e5e7eb',
    aiText: '#1f2937'
  }}
/>
```

Ricorda di importare anche il CSS una volta nell'app: `import './widget/ChatWidget.css'`.

## Sviluppo (demo con color picker, come il vecchio index.html)

```bash
npm install
npm run dev
```

## Build come libreria embeddabile (equivalente al vecchio widget.js)

Genera un singolo `dist-embed/chat-widget.js` che espone `window.ChatWidget.init(config)`,
per essere iniettato via `<script>` in un sito che non ha già React — stesso pattern
d'uso dell'originale in `index.html`:

```bash
npm run build:embed
```

```html
<script src="chat-widget.js"></script>
<script>
  ChatWidget.init({
    product: 'comunicai',
    demoId: 'reference-demo',
    apiEndpoint: '/api/chat/message',
    colors: { primary: '#1a8c5c', secondary: '#13a06a' }
  });
</script>
```

## Note

- I loghi in `public/Loghi/comunicai.png` e `medicai.png` sono placeholder 1x1:
  sostituiscili con gli asset reali (stesso path/nome usato dal widget originale).
- Il backend (`/api/chat/message`, `/api/chat/tts`, `/api/demos/:id/suggestions`)
  non è incluso: il componente chiama questi endpoint esattamente come l'originale,
  va solo puntato al tuo backend esistente.
- `GlassControls` è un tool di calibrazione per sviluppatori (agisce sulle CSS var
  `--cw-glass-*`); non è pensato per l'utente finale — rimuovilo da `App.jsx` in build
  di produzione se non ti serve.
