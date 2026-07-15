import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Config standard per lo sviluppo e la demo (App.jsx).
// Per la build "embed" (script singolo da iniettare in un sito esterno,
// equivalente al vecchio widget.js) usa `npm run build:embed`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  }
});
