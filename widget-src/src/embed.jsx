import React from 'react';
import ReactDOM from 'react-dom/client';
import ChatWidget from './widget/ChatWidget.jsx';
import { DEFAULT_CONFIG } from './widget/themes.js';
import './widget/ChatWidget.css';

// Replica l'API del vecchio widget.js (window.ChatWidget.init/instance) per poter
// incollare <script src="chat-widget.js"></script> su un sito che non ha già React,
// esattamente come nell'uso originale in index.html.

class ChatWidgetController {
  constructor(config) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.container = this.config.container || null;
    this.root = null;
    this.init();
  }

  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'chat-widget-container';
      document.body.appendChild(this.container);
    }
    this.render();
  }

  render() {
    this.root = this.root || ReactDOM.createRoot(this.container);
    this.root.render(
      <ChatWidget
        product={this.config.product}
        demoId={this.config.demoId}
        colors={this.config.colors}
        style={this.config.style}
        apiEndpoint={this.config.apiEndpoint}
        previewMode={!!this.config.previewMode}
      />
    );
  }

  // Aggiorna la config esistente e ri-renderizza SENZA remount (a differenza di
  // init(), che distrugge e ricrea): preserva stato (finestra aperta, animazioni)
  // tra un aggiornamento e l'altro. Usato dall'anteprima live nella pagina admin
  // per applicare in tempo reale le modifiche a colori/stile non ancora salvate.
  update(partialConfig) {
    this.config = { ...this.config, ...partialConfig };
    this.render();
  }

  destroy() {
    if (this.root) this.root.unmount();
    if (this.container) this.container.remove();
  }
}

window.ChatWidget = {
  init(config) {
    if (window.ChatWidget.instance) window.ChatWidget.instance.destroy();
    window.ChatWidget.instance = new ChatWidgetController(config);
    return window.ChatWidget.instance;
  },
  instance: null
};
