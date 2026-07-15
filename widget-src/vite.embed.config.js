import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Build alternativa che replica l'uso originale di widget.js:
// un singolo <script src="chat-widget.js"></script> che espone
// window.ChatWidget.init({ product, colors, ... }) su qualsiasi sito.
export default defineConfig({
  plugins: [react()],
  // React/ReactDOM (bundlati nell'IIFE) leggono process.env.NODE_ENV a runtime;
  // in build.lib Vite non lo sostituisce automaticamente come nella build normale,
  // quindi va definito esplicitamente per evitare "process is not defined" nel browser.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    outDir: 'dist-embed',
    lib: {
      entry: resolve(__dirname, 'src/embed.jsx'),
      name: 'ChatWidgetEmbed',
      formats: ['iife'],
      fileName: () => 'chat-widget.js'
    },
    rollupOptions: {
      output: {
        // React è incluso nel bundle: lo script è pensato per essere
        // incollato in siti che NON hanno già React (come il vecchio widget.js).
        inlineDynamicImports: true,
        assetFileNames: 'chat-widget.[ext]'
      }
    },
    cssCodeSplit: false
  }
});
