# Clean Staging AI — Chatbot Demo Platform

Piattaforma per la creazione rapida di demo interattive di chatbot verticali: **ComunicAI** (PA / comuni), **MedicAI** (sanità) e **TourismAI** (turismo).

Ogni demo si collega al sito del cliente e consente agli utenti di fare domande in linguaggio naturale, ottenendo risposte basate sui contenuti reali del sito.

---

## Cosa fa

- **Crea demo in pochi click**: inserisci il sito del cliente, gli URL sorgente, le istruzioni personalizzate e i colori.
- **Due modalità di ricerca**:
  - **Live**: ricerca in tempo reale sui siti configurati (SERPApi + crawl on-demand).
  - **Crawling**: indicizza il sito in background e risponde da un knowledge base vettoriale (RAG), con fallback live se necessario.
- **Widget embeddabile**: React, facilmente inseribile in qualsiasi pagina.
- **Avatar live opzionale**: integrazione HeyGen per un’esperienza conversazionale avanzata.

---

## Requisiti

- [Node.js](https://nodejs.org/) ≥ 22.17.0
- Chiavi API per i servizi che intendi usare (OpenAI è obbligatorio)

---

## Avvio rapido

```bash
# 1. Installa le dipendenze
npm install

# 2. Copia il file di esempio delle variabili d’ambiente
cp .env.example .env

# 3. Modifica .env inserendo le tue chiavi
#    Almeno OPENAI_API_KEY è richiesta.

# 4. Avvia il server
npm start
```

L’applicazione sarà disponibile su `http://localhost:3000` (o sulla porta configurata in `.env`).

---

## Flusso tipico

1. Vai su `http://localhost:3000` e fai login.
2. Scegli il prodotto (ComunicAI / MedicAI / TourismAI).
3. Compila il form:
   - **URL sito cliente**: la pagina che verrà mostrata nella demo
   - **URL sorgente ricerca**: uno o più URL da cui attingere le informazioni
   - **Istruzioni personalizzate**: regole comportamentali opzionali per il chatbot
   - **Modalità**: Live o Crawling
4. Crea la demo e, se hai scelto Crawling, attendi il completamento dell’indicizzazione.
5. Apri la demo e inizia a chattare.

---

## Build del widget

Per rigenerare il bundle embeddabile del widget:

```bash
npm run build:widget
```

Il risultato viene salvato in `widget-src/dist-embed/`.

---

## Documentazione tecnica

Per l’architettura completa, la descrizione dei file, i flussi interni e le API, vedi:

👉 [docs/technical.md](docs/technical.md)

---

## Struttura rapida

```
.
├── server.js              # Entry point Express
├── deep-search-engine.js  # Motore di ricerca live
├── src/
│   ├── orchestrator.js    # Coordinamento agenti di chat
│   ├── agents/            # Micro-agent (RAG, tool, guardrail, ...)
│   ├── knowledge-engine/  # Crawler, chunker, embedder, LanceDB
│   ├── config/            # Prompt per prodotto
│   └── lib/               # Utility condivise
├── public/                # UI admin e pagine demo
├── widget-src/            # Sorgente React del widget
└── docs/                  # Documentazione
```

---

## Licenza

Progetto interno — tutti i diritti riservati.
