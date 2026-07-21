# Documentazione Tecnica — Clean Staging AI

Questo documento descrive l’architettura, i flussi principali e il ruolo dei file del progetto. Per una panoramica ad alto livello e le istruzioni di avvio, vedi il [README principale](../README.md).

---

## Indice

1. [Stack tecnologico](#stack-tecnologico)
2. [Architettura generale](#architettura-generale)
3. [Flusso: creazione demo](#flusso-creazione-demo)
4. [Flusso: chat](#flusso-chat)
5. [Modalità di ricerca](#modalità-di-ricerca)
6. [Knowledge Engine (RAG)](#knowledge-engine-rag)
7. [Deep Search Engine (live)](#deep-search-engine-live)
8. [Agenti](#agenti)
9. [Struttura cartelle](#struttura-cartelle)
10. [Variabili d’ambiente](#variabili-dambiente)
11. [API principali](#api-principali)

---

## Stack tecnologico

- **Runtime:** Node.js ≥ 22.17.0
- **Framework web:** Express.js
- **AI / LLM:** OpenAI GPT-4o-mini
- **Embeddings:** OpenAI `text-embedding-3-small`
- **Vector store:** LanceDB
- **Database relazionale:** SQLite (`better-sqlite3`)
- **Crawling:** Axios + Puppeteer (fallback per pagine JS)
- **Parsing HTML:** Cheerio, Readability, jsdom
- **Frontend widget:** React + Vite
- **Live avatar:** HeyGen LiveAvatar Web SDK
- **Notifiche:** Twilio (SMS), SendGrid (email)

---

## Architettura generale

Il progetto è organizzato come una piattaforma di demo per chatbot verticali (ComunicAI, MedicAI, TourismAI). Ogni demo è legata a:

- un **sito cliente** (`clientUrl`)
- uno o più **URL sorgente** (`searchUrls`)
- un **prodotto verticale** (`product`)
- un set di **istruzioni personalizzate** opzionali
- una **modalità di ricerca** (`searchMode`): `live` o `crawling`

L’amministratore crea la demo da una pagina di configurazione; l’utente finale interagisce con il chatbot su `demo.html`.

---

## Flusso: creazione demo

1. **UI di configurazione**
   - File: `public/config_comunicai.html`, `public/config_medicai.html`, `public/config_tourism.html`
   - L’admin compila i campi e sceglie la modalità.

2. **Salvataggio**
   - Endpoint: `POST /api/demos` in `server.js`
   - Persistenza in `demos.json`
   - Se `searchMode === 'crawling'`:
     - viene generato un `knowledgeBaseId`
     - viene avviato un job background nel knowledge engine

3. **Monitoraggio indicizzazione**
   - `GET /api/ingestion/:kbId/state`
   - `SSE /api/ingestion/:kbId/progress`
   - La UI mostra un popup di progresso fino al completamento.

---

## Flusso: chat

1. **Widget**
   - File: `widget-src/src/widget/ChatWidget.jsx`
   - Chiama `POST /api/chat/message` in streaming SSE.

2. **Server**
   - File: `server.js`
   - Crea il singleton RAG e passa tutto a `orchestrateChat`.

3. **Orchestratore**
   - File: `src/orchestrator.js`
   - Carica demo, history, allegati.
   - Costruisce il system prompt.
   - Esegue guardrail → router → copywriter → (tool) → seconda chiamata AI.

4. **Tool executor**
   - File: `src/agents/tool-executor-agent.js`
   - Per `search_configured_sites`:
     - modalità `crawling` → prova RAG prima, fallback live
     - modalità `live` → `deep-search-engine.js`

---

## Modalità di ricerca

### Live

- Nessuna indicizzazione preventiva.
- Ogni query attiva `deep-search-engine.js`.
- Usa SERPApi/Google + fetch pagine + sintesi AI.
- Più lento per query, ma sempre aggiornato.

### Crawling

- Alla creazione della demo parte il crawl del sito.
- I chunk vengono embeddati e salvati in LanceDB.
- In chat si interroga prima il vector store.
- Se il KB è vuoto/non pronto, si ricade automaticamente su ricerca live.

---

## Knowledge Engine (RAG)

Componenti principali:

| File | Ruolo |
|---|---|
| `src/knowledge-engine/index.js` | API pubblica: enqueue, status, cancel |
| `src/knowledge-engine/jobs/job-manager.js` | Scheduling e heartbeat dei job |
| `src/knowledge-engine/jobs/job-runner.js` | Esecuzione crawl + ingest |
| `src/knowledge-engine/crawler/crawler.js` | Frontier e scoperta URL |
| `src/knowledge-engine/crawler/fetcher.js` | Fetch HTTP / Puppeteer |
| `src/knowledge-engine/crawler/sitemap.js` | Scoperta sitemap.xml |
| `src/knowledge-engine/crawler/robots.js` | Parsing robots.txt |
| `src/knowledge-engine/extraction/document.js` | Pulizia HTML → testo |
| `src/knowledge-engine/chunking/chunker.js` | Chunking semantico |
| `src/knowledge-engine/embedding/embedder.js` | Adapter embedding |
| `src/knowledge-engine/ingestion/ingest-worker.js` | Pipeline chunk → embed → store |
| `src/knowledge-engine/vectorstore/lancedb-store.js` | Indice LanceDB |
| `src/lib/embeddings.js` | Client embedding condiviso |
| `src/lib/lancedb.js` | Connessione LanceDB condivisa |

---

## Deep Search Engine (live)

File principale: `deep-search-engine.js`

Strategia a livelli:

1. **Livello 1 — SERPApi**: cerca `site:<hostname> <query>` e fetcha le pagine rilevanti.
2. **Livello 2 — Homepage fallback**: se SERPApi fallisce, fetcha la root URL.
3. **Livello 3 — AI synthesis**: compila il contesto e lo passa a GPT-4o-mini.

Funzioni di supporto:

- `searchConfiguredSites`: entry point
- `hybridSearch`: strategia SERPApi + fetch
- `extractPageData`: parsing HTML con Cheerio
- `buildContext`: costruzione contesto per l’AI
- `prefetchRootPages`: precarica le root in parallelo all’orchestratore

---

## Agenti

Tutti in `src/agents/`:

| Agente | File | Ruolo |
|---|---|---|
| Copywriter | `copywriter-agent.js` | Chiama OpenAI in streaming |
| Router | `router-agent.js` | Seleziona i tool disponibili |
| Tool Executor | `tool-executor-agent.js` | Esegue i tool scelti dal modello |
| RAG | `rag-agent.js` | Lookup nel knowledge base |
| Guardrail | `guardrail-agent.js` | Blocchi di sicurezza input/output |
| QA | `qa-agent.js` | Review confidenza risposte |
| Memory | `memory-agent.js` | History sessione in memoria |
| Database | `database-agent.js` | Caricamento demo |
| Query Planner | `query-planner-agent.js` | Riscrittura query per retrieval |

---

## Struttura cartelle

```
.
├── data/                       # Dati runtime
│   ├── crawl-state/            # Stato crawl
│   ├── jobs/                   # Job SQLite
│   ├── knowledge-engine/       # Job KB e LanceDB
│   ├── lancedb/                # Vector store legacy
│   └── uploads/                # File caricati
├── docs/                       # Documentazione
├── Loghi/                      # Asset loghi
├── public/                     # UI admin e demo
│   ├── config_*.html           # Pagine configurazione
│   ├── demo.html               # Pagina demo pubblica
│   ├── api-config.js           # Configurazione API client
│   └── auth.js                 # Auth lato client
├── src/                        # Codice server
│   ├── agents/                 # Micro-agent
│   ├── config/                 # Prompt verticali
│   ├── deployments/            # Orchestratore deployment
│   ├── knowledge-engine/       # Crawl / ingest / RAG
│   ├── lib/                    # Utility condivise
│   ├── middleware/             # Middleware Express
│   ├── pipeline/               # Pipeline RAG
│   ├── services/               # Servizi legacy/disattivati
│   └── widget/                 # Widget chat embed
├── widget-src/                 # Sorgente React del widget
│   └── src/
│       └── widget/
│           ├── ChatWidget.jsx  # Componente principale
│           └── ...
├── deep-search-engine.js       # Motore live search
├── server.js                   # Entry point Express
└── package.json
```

---

## Variabili d’ambiente

Copia `.env.example` in `.env` e configura almeno:

```bash
OPENAI_API_KEY=              # richiesto
SERPAPI_API_KEY=             # per ricerca live
FIRECRAWL_API_KEY=           # fallback crawling live
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
SENDGRID_API_KEY=
SESSION_SECRET=
PORT=3000
```

---

## API principali

| Metodo | Endpoint | Descrizione |
|---|---|---|
| POST | `/api/demos` | Crea una demo |
| PUT | `/api/demos/:id` | Modifica una demo |
| DELETE | `/api/demos/:id` | Elimina una demo |
| POST | `/api/chat/message` | Messaggio al chatbot (SSE) |
| GET | `/api/ingestion/:kbId/state` | Stato indicizzazione |
| GET | `/api/ingestion/:kbId/progress` | Progresso indicizzazione (SSE) |
| POST | `/api/login` | Login admin |

---

## Note di manutenzione

- I file `src/services/enhanced-chat-service.js` e `src/services/local-rag.js` sono attualmente non utilizzati.
- L’eliminazione di una demo non rimuove i dati KB e i file SQLite associati: va gestita manualmente o con uno script di cleanup.
- La duplicazione intenzionale di `demo.instructions` in `src/orchestrator.js` (una volta via `buildSystemPrompt` e una volta append diretto) serve a rinforzare il peso delle istruzioni personalizzate nel system prompt.
