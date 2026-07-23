// ─── Load environment variables ───────────────────────────────────────────────
require('dotenv').config();

// ─── Crash isolation ───────────────────────────────────────────────────────
// Un errore che emerge processando un singolo turno di chat (una risposta
// OpenAI malformata, un sito irraggiungibile) non deve mai far cadere il
// server per tutte le altre sessioni/demo attive. Ultima linea di difesa:
// logga e continua a servire.
process.on('unhandledRejection', (reason) => {
  console.error('🚨 Unhandled promise rejection (server kept running):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught exception (server kept running):', err && err.stack ? err.stack : err);
});

const { liveAvatarConfig } = require('./src/config/liveavatar-config.js');
liveAvatarConfig.validate();

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cors    = require('cors');
const OpenAI  = require('openai');
const multer  = require('multer');
const { createProxyMiddleware } = require('http-proxy-middleware');

const { MonitoringSystem } = require('./src/services/monitoring-system.js');
const { orchestrateChat, clearChatSession, getSessionHistory } = require('./src/orchestrator');
const { upload, classifyMime } = require('./src/lib/uploads');
const { transcribeAudio } = require('./src/lib/stt');
const { textToSpeech } = require('./src/lib/tts');
const { searchConfiguredSites: deepSearchConfiguredSites } = require('./deep-search-engine.js');
const { analyzeSite } = require('./src/lib/site-analyzer');
const knowledgeEngine = require('./src/knowledge-engine');
const { loadDemos, saveDemos } = require('./src/lib/demos-store');
const cron = require('node-cron');
const { runRecrawlBatch, runRecrawlForDemo, readHistory } = require('./src/knowledge-engine/recrawl-checker');
const { createRag } = require('./src/pipeline/rag');

// Upload audio per l'input vocale (/api/chat/stt): in memoria, mai su disco
// (a differenza di `upload`, che persiste gli allegati chat) — la
// registrazione viene scartata subito dopo la trascrizione.
const sttUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ─── App ───────────────────────────────────────────────────────────────────────
const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 7000;

// ─── OpenAI (lazy) ────────────────────────────────────────────────────────────
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      console.warn('⚠️  OPENAI_API_KEY mancante – funzioni AI disabilitate');
      return null;
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('✓ OpenAI inizializzato');
  }
  return _openai;
}

// ─── RAG (lazy, condivide il client OpenAI sopra) ────────────────────────────
let _rag = null;
function getRag() {
  const client = getOpenAI();
  if (!client) return null;
  if (!_rag) _rag = createRag({ openai: client });
  return _rag;
}

// ─── Monitoring ───────────────────────────────────────────────────────────────
const monitoring = new MonitoringSystem();
monitoring.start();
console.log('📊 Monitoring system started');

// ─── Recrawl checker (periodic "has this demo's site changed?") ───────────────
// Fires every night at 22:00; runRecrawlBatch itself skips any demo whose
// own recrawlIntervalDays (default 7, src/knowledge-engine/recrawl-checker.js)
// hasn't elapsed yet, so the net effect is "each demo re-checked every N
// days" while still self-healing if a given night's tick is missed (server
// down, etc.). No cap on how long a triggered recrawl may run past 05:00 —
// this only governs when the nightly check starts.
cron.schedule('0 22 * * *', () => {
  console.log('🔄 Recrawl checker: avvio controllo notturno');
  runRecrawlBatch({ trigger: 'cron' })
    .then((records) => console.log(`🔄 Recrawl checker: completato (${records.length} demo controllate)`))
    .catch((err) => console.error('🔄 Recrawl checker: errore batch notturno:', err.message));
}, { timezone: 'Europe/Rome' });

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({
  strict: false,
  limit: '10mb'
}));
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3111', 'https://app.liveavatar.com', 'https://staging.ai4smartcity.ai', 'http://staging.ai4smartcity.ai'],
  credentials: true,
  optionsSuccessStatus: 200
}));
app.use('/proxy-liveavatar', createProxyMiddleware({
    target: 'https://api.liveavatar.com',
    changeOrigin: true,
    pathRewrite: {
        '^/proxy-liveavatar': '',
    },
    onProxyReq: (proxyReq, req, res) => {
        const apiKey = liveAvatarConfig.apiKey || process.env.LIVEAVATAR_API_KEY;
        if (apiKey) {
            // Multiple auth methods for SDK compatibility
            proxyReq.setHeader('Authorization', `Bearer ${apiKey}`);
            proxyReq.setHeader('x-api-key', apiKey);
            proxyReq.setHeader('x-liveavatar-api-key', apiKey);
            proxyReq.setHeader('api-key', apiKey);
        }
        // Cross-site cookies
        proxyReq.setHeader('Cookie', 'SameSite=None; Secure; Path=/');
        // LiveAvatar headers
        proxyReq.setHeader('User-Agent', 'LiveAvatarProxy/2.0');
        proxyReq.setHeader('Origin', 'https://app.liveavatar.com');
        console.log(`🔌 Proxy API req: ${req.method} ${req.url} → api.liveavatar.com`);
    },
    onProxyRes: (proxyRes, req, res) => {
        // Full CORS for SDK
        proxyRes.headers['access-control-allow-origin'] = '*';
        proxyRes.headers['access-control-allow-credentials'] = 'true';
        proxyRes.headers['access-control-allow-methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
        proxyRes.headers['access-control-allow-headers'] = 'Content-Type,Authorization,x-api-key,x-liveavatar-api-key';
        proxyRes.headers['access-control-max-age'] = '86400';
        console.log(`📡 Proxy API res: ${proxyRes.statusCode} ${req.url}`);
    },
    onError: (err, req, res) => {
        console.error(`❌ Proxy error ${req.url}:`, err.message);
        res.status(502).json({ error: 'Proxy error', message: err.message });
    }
}));

app.use('/cdn-cgi', cors({ origin: '*' }), (req, res) => {
  res.status(204).end();
});

app.use((req, res, next) => {
  // Enhanced LiveAvatar CSP + SameSite security
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "default-src 'self' https://app.liveavatar.com https://api.liveavatar.com https: data: blob: 'unsafe-inline'; frame-ancestors *; frame-src *; connect-src *; img-src * data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://app.liveavatar.com https://api.liveavatar.com;");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  next();
});

// ─── Session management for Plesk multi-process compatibility ─────────────────
// Per Plesk con più worker Passenger, salviamo i dati utente anche in un
// COOKIE come fallback. Se una richiesta finisce su un worker diverso, il
// middleware sotto la ripristina dal cookie.
app.use(session({
  secret: process.env.SESSION_SECRET || 'ai4smartcity-demo-super-secret-key-change-in-production',
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || process.env.FORCE_SECURE_COOKIES === 'true',
    maxAge: 8 * 60 * 60 * 1000,  // 8 ore
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    domain: undefined
  }
}));

// ─── Middleware di sincronizzazione utente da cookie a req.session ───────────
app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie || '';
  req.cookies = req.cookies || {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, value] = cookie.trim().split('=');
    if (name && value) {
      try {
        req.cookies[name] = decodeURIComponent(value);
      } catch (e) {
        // Cookie non valido, ignora
      }
    }
  });

  if (!req.session.user && req.cookies.user_data) {
    try {
      const userData = JSON.parse(Buffer.from(req.cookies.user_data, 'base64').toString());
      req.session.user = userData;
      console.log('🔄 Restored user from cookie:', userData.username);
    } catch (e) {
      console.error('❌ Failed to parse user_data cookie:', e.message);
    }
  }
  next();
});
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.originalUrl}`);
  next();
});

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/widget', express.static(path.join(__dirname, 'widget')));
// no-cache: forza il browser a rivalidare il bundle del widget React ad ogni
// richiesta (via ETag/If-None-Match), così un rebuild si vede subito senza
// bisogno di hard-refresh manuali.
app.use('/widget-src', express.static(path.join(__dirname, 'widget-src'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));
app.use('/Loghi', express.static(path.join(__dirname, 'Loghi')));
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// Silenzia i 404 di Next.js provenienti da LiveAvatar (204 silenzioso)
app.use('/_next', (req, res) => {
  res.status(204).end();
});

// ─── API Router ───────────────────────────────────────────────────────────────
const apiRouter = express.Router();
app.use('/api', apiRouter);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function loadUsers() {
  try   { return JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8')); }
  catch { return []; }
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Non autenticato' });
  next();
}

// ─── Avatar Context Helpers (LiveAvatar) ──────────────────────────────────────
function getTodayYYYYMMDD() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function extractChatInsights(sessionId) {
  if (!sessionId) return {};
  const history = getSessionHistory(sessionId).slice(-10);
  const assistantMessages = history.filter(msg => msg.role === 'assistant' && typeof msg.content === 'string').map(msg => msg.content);

  const insights = {};
  const newsPattern = /news|aggiornamento|nuovo|da oggi|ultim[a]? ora|ultima ora|breaking/i;
  const warningPattern = /manutenzione|offline|attenzione|avviso|interruzione|problema|urgente/i;
  const offerPattern = /sconto|offerta|promozione|speciale|da non perdere|promo/i;

  for (const content of assistantMessages) {
    if (newsPattern.test(content) && !insights.news) {
      insights.news = content.slice(0, 200) + (content.length > 200 ? '...' : '');
    }
    if (warningPattern.test(content) && !insights.warning) {
      insights.warning = content.slice(0, 200) + (content.length > 200 ? '...' : '');
    }
    if (offerPattern.test(content) && !insights.offerta_attuale) {
      insights.offerta_attuale = content.slice(0, 200) + (content.length > 200 ? '...' : '');
    }
  }

  return insights;
}

function getBaseVerticals(product) {
  const sectorMap = { comunicai: 'comuni_pa', medicai: 'sanita', tourism: 'turismo' };
  const sector = sectorMap[product] || 'comuni_pa';

  const base = {
    comuni_pa: {
      news: "Nessuna notizia recente disponibile",
      avvisi: "Tutti i servizi funzionanti",
      prossimi_eventi: "Prossimi eventi in programma",
      uffici: {
        anagrafe: "Aperto lun-ven 8:30-12:30",
        tributi: "Scadenze IMU entro 16 giugno",
        sociale: "Sportello attivo su appuntamento"
      }
    },
    sanita: {
      warning: "Nessun avviso attivo",
      prenotazioni: "Sistema prenotazioni online attivo",
      servizi_disponibili: "Vaccinazioni, analisi del sangue, visite specialistiche",
      prossimi_appuntamenti: "Verifica la tua agenda personale"
    },
    turismo: {
      offerta_attuale: "Scopri le nostre offerte speciali!",
      eventi: "Eventi culturali e sagre locali",
      prenotazioni: "Hotel e ristoranti disponibili",
      meteo: "Tempo splendido per visitare!"
    }
  };

  return base[sector] || base.comuni_pa;
}

function generateDynamicContext(sessionId, product, dateStr) {
  const baseVerticals = getBaseVerticals(product);
  const chatInsights = extractChatInsights(sessionId);

  const verticals = { ...baseVerticals };
  if (chatInsights.news) verticals.news = chatInsights.news;
  if (chatInsights.warning) verticals.warning = chatInsights.warning;
  if (chatInsights.offerta_attuale) verticals.offerta_attuale = chatInsights.offerta_attuale;

  return {
    metadata: { last_update: dateStr, version: "1.2.0", product: product, sessionId: sessionId || null },
    verticals: verticals
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── Root ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/login_comunicai.html'));

// ── Tourism (redirect to tourism login) ────────────────────────────────────
app.get('/tourism', (req, res) => res.redirect('/login_tourism.html'));

// ── API health-check ───────────────────────────────────────────────────────
apiRouter.get('/', (req, res) => {
  res.json({ ok: true, service: 'clean-staging-ai', status: 'running' });
});

// ── Auth ─────────────────────────────────────────────────────────────────────
apiRouter.post('/login', async (req, res) => {
  const { username, password, product } = req.body;
  console.log('🔐 Login attempt:', { username, product });

  if (!username || !password || !product)
    return res.status(400).json({ error: 'Campi mancanti' });

  const users = loadUsers();
  const user  = users.find(u => u.username === username);
  if (!user)
    return res.status(401).json({ error: 'Credenziali non valide' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid)
    return res.status(401).json({ error: 'Credenziali non valide' });

  if (!user.products.includes(product))
    return res.status(403).json({ error: 'Accesso non autorizzato per questo prodotto' });

  const userData = {
    id: user.id, username: user.username, name: user.name,
    role: user.role, products: user.products, currentProduct: product
  };

  req.session.user = userData;

  // Fondamentale per Plesk: i dati utente vengono salvati anche in un cookie
  // per la persistenza cross-process (GET /api/me potrebbe finire su un
  // worker diverso da quello che ha gestito il login).
  res.cookie('user_data', Buffer.from(JSON.stringify(userData)).toString('base64'), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || process.env.FORCE_SECURE_COOKIES === 'true',
    maxAge: 8 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/'
  });

  const configPages = {
    comunicai: 'config_comunicai.html',
    medicai: 'config_medicai.html',
    tourism: 'config_tourism.html'
  };
  const configPage = configPages[product] || 'config_comunicai.html';
  console.log('✅ Login OK:', username, '→', configPage);
  res.json({
    success: true,
    user: { name: user.name, role: user.role, products: user.products, currentProduct: product, username: user.username },
    redirect: `/${configPage}`
  });
});

apiRouter.post('/logout', (req, res) => {
  req.session.destroy();
  res.clearCookie('user_data', { path: '/' });
  res.json({ success: true });
});

apiRouter.get('/me', (req, res) => {
  console.log('🔍 Session check – user:', req.session.user?.username || 'none');
  if (!req.session.user) return res.status(401).json({ error: 'Non autenticato' });
  res.json({ user: req.session.user });
});

// ── URL Validation ───────────────────────────────────────────────────────────
apiRouter.post('/validate-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL richiesto' });
  try {
    new URL(url);
    const axios = require('axios');
    const r = await axios.head(url, { timeout: 5000, maxRedirects: 3, headers: { 'User-Agent': 'Mozilla/5.0' } });
    res.json({ success: true, url, status: r.status, valid: true });
  } catch (err) {
    res.json({ success: false, url, error: err.message, valid: false });
  }
});

// ── Site analysis (bottone "Analizza sito" in fase di creazione demo) ────────
// Scan strutturale (non guidato da query) fino a 3 livelli: gerarchia +
// data di ultima modifica per pagina, più verifica sitemap/feed. Resta un
// controllo live indipendente sia da deep-search-engine.js (motore di
// ricerca live usato in chat) sia dal knowledge-engine (crawl/ingest/index):
// serve solo a dare un'anteprima strutturale del sito PRIMA di creare la
// demo, non è influenzato dalla modalità 'live'/'crawling' scelta.
const SITE_ANALYSIS_VALID_MODES = new Set(['live', 'crawling']);

// ── Sanitizzazione campo "style" delle demo (personalizzazione estetica del
// chatbot: forma/bordi, posizione, dimensione, effetti "liquid glass") ───────
// Duplica intenzionalmente la stessa whitelist/clamp di
// widget-src/src/widget/themes.js#resolveStyle: server.js è CommonJS,
// widget-src è un package ESM/Vite separato, condividerlo richiederebbe un
// build step in più per un helper di poche righe. Nessuna validazione di
// questo tipo esisteva finora nemmeno per "colors", ma è stata aggiunta qui
// dato che il campo è nuovo e scritto direttamente in demos.json senza schema.
const STYLE_POSITIONS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left']);
const STYLE_SIZE_PRESETS = new Set(['compact', 'standard', 'large']);

function clampStyleNum(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeStyle(style) {
  const s = style || {};
  const br = s.borderRadius || {};
  const glass = s.glass || {};
  return {
    borderRadius: {
      window: clampStyleNum(br.window, 0, 32, 24),
      bubble: clampStyleNum(br.bubble, 0, 32, 32)
    },
    position: STYLE_POSITIONS.has(s.position) ? s.position : 'bottom-right',
    sizePreset: STYLE_SIZE_PRESETS.has(s.sizePreset) ? s.sizePreset : 'standard',
    glass: {
      blur: clampStyleNum(glass.blur, 0, 40, 24),
      saturate: clampStyleNum(glass.saturate, 100, 300, 200),
      opacity: clampStyleNum(glass.opacity, 0, 0.4, 0.12)
    }
  };
}

// ── Sanitizzazione campi welcome/questions/logo della demo ───────────────────
// Alimentano GET /api/demos/:id/suggestions, già atteso dal widget
// (ChatWidget.jsx fa fetch di questa rotta da tempo, ma non esisteva ancora
// lato server — richiesta sempre in 404, fallback silenzioso ai default fissi
// per prodotto). Stesso pattern difensivo di sanitizeStyle: qualunque valore
// mancante/malformato ricade su un default sicuro, mai propagato as-is.
const MAX_WELCOME_CHARS = 500;
const MAX_QUESTION_CHARS = 120;
const MAX_QUESTIONS = 6;

function sanitizeWelcome(welcome) {
  if (typeof welcome !== 'string') return '';
  return welcome.trim().slice(0, MAX_WELCOME_CHARS);
}

function sanitizeQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions
    .filter(q => typeof q === 'string' && q.trim())
    .map(q => q.trim().slice(0, MAX_QUESTION_CHARS))
    .slice(0, MAX_QUESTIONS);
}

// Logo: solo percorsi interni noti (/uploads/<file> da upload via
// /api/chat/upload, o /Loghi/<file> i default di prodotto già serviti
// staticamente) — mai un URL esterno arbitrario da un campo testo libero, per
// non far caricare al widget (via <img src>) risorse fuori dal nostro
// controllo. Un solo segmento dopo il prefisso (niente sotto-percorsi) e
// nessun ".." nel nome file: express.static protegge già a valle da path
// traversal, ma meglio essere espliciti anche qui piuttosto che affidarsi
// solo a quello.
function sanitizeLogo(logo) {
  if (typeof logo !== 'string') return '';
  const trimmed = logo.trim();
  const match = /^\/(uploads|Loghi)\/([^/]+)$/.exec(trimmed);
  if (!match || match[2].includes('..')) return '';
  return trimmed;
}

apiRouter.post('/site-analysis', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL richiesto' });
  try { new URL(url); }
  catch { return res.status(400).json({ success: false, error: 'URL non valido' }); }

  try {
    const result = await analyzeSite(url);
    res.json(result);
  } catch (err) {
    console.error('Site analysis error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Knowledge base (crawling → ingest → index, src/knowledge-engine) ─────────
// Una demo in modalità 'crawling' ha un knowledgeBaseId (== job id ==
// namespace LanceDB, vedi src/lib/lancedb.js) che identifica la sua knowledge
// base indicizzata. Crearne una nuova (id nuovo) invece di riusare quella
// esistente quando i searchUrls cambiano evita di riavviare un job già
// esistente con lo stesso id senza che i suoi seedUrls persistiti vengano
// aggiornati (knowledge-engine/storage/jobs-db.js#upsertQueued non li
// sovrascrive in caso di conflitto) — più semplice e sicuro che modificare
// quel comportamento.
function urlsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((u, i) => u === b[i]);
}

// Override opzionali di maxDepth/maxPages (campi "crawlMaxDepth"/"crawlMaxPages"
// nel form demo, accanto agli URL sorgente). Non validi/assenti -> undefined,
// cioè "usa il default di src/knowledge-engine/config.js" — non viene mai
// scritto un valore di default hardcoded sulla demo, solo l'eventuale
// personalizzazione esplicita dell'operatore.
function sanitizeCrawlNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

function ensureKnowledgeBase(draft, previousDemo) {
  if (draft.searchMode !== 'crawling') return previousDemo ? (previousDemo.knowledgeBaseId || null) : null;

  const sameUrls = previousDemo && urlsEqual(previousDemo.searchUrls, draft.searchUrls);
  const sameCrawlOptions = previousDemo
    && (previousDemo.crawlMaxDepth || null) === (draft.crawlMaxDepth || null)
    && (previousDemo.crawlMaxPages || null) === (draft.crawlMaxPages || null);
  const reuse = previousDemo
    && previousDemo.knowledgeBaseId
    && previousDemo.searchMode === 'crawling'
    && sameUrls
    && sameCrawlOptions;
  const kbId = reuse ? previousDemo.knowledgeBaseId : uuidv4();

  const options = {};
  if (draft.crawlMaxDepth) options.maxDepth = draft.crawlMaxDepth;
  if (draft.crawlMaxPages) options.maxPages = draft.crawlMaxPages;

  try {
    knowledgeEngine.enqueueJob({ id: kbId, seedUrls: draft.searchUrls, options });
  } catch (err) {
    console.error('knowledge-engine enqueueJob error:', err.message);
    return previousDemo ? (previousDemo.knowledgeBaseId || null) : null;
  }
  return kbId;
}

// ── Demos CRUD ───────────────────────────────────────────────────────────────
apiRouter.post('/demos', requireAuth, (req, res) => {
  const { clientUrl, searchUrls, instructions, colors, style, searchMode, welcome, questions, logo, crawlMaxDepth, crawlMaxPages } = req.body;

  if (!clientUrl || !searchUrls || !Array.isArray(searchUrls) || searchUrls.length === 0)
    return res.status(400).json({ error: 'Dati mancanti o non validi' });

  try { new URL(clientUrl); searchUrls.forEach(u => new URL(u)); }
  catch { return res.status(400).json({ error: 'URL non valido' }); }

  const demo = {
    id: uuidv4(),
    createdAt:   new Date().toISOString(),
    createdBy:   req.session.user.username,
    product:     req.session.user.currentProduct,
    clientUrl, searchUrls,
    searchMode: SITE_ANALYSIS_VALID_MODES.has(searchMode) ? searchMode : 'live',
    instructions: instructions || '',
    colors: colors || { primary:'#00b4ff', secondary:'#0066cc', userBg:'#3b82f6', userText:'#ffffff', aiBg:'#e5e7eb', aiText:'#1f2937' },
    style: sanitizeStyle(style),
    // Vuoti di default: il widget ricade sui default fissi per prodotto
    // (FALLBACK_WELCOME/FALLBACK_SUGGESTIONS in themes.js) e sul logo di
    // prodotto (/Loghi/comunicai.png o /Loghi/medicai.png) finché non
    // vengono personalizzati — vedi GET /api/demos/:id/suggestions sotto.
    welcome: sanitizeWelcome(welcome),
    questions: sanitizeQuestions(questions),
    logo: sanitizeLogo(logo)
  };
  const sanitizedMaxDepth = sanitizeCrawlNumber(crawlMaxDepth, 1, 10);
  const sanitizedMaxPages = sanitizeCrawlNumber(crawlMaxPages, 10, 2000);
  if (sanitizedMaxDepth !== undefined) demo.crawlMaxDepth = sanitizedMaxDepth;
  if (sanitizedMaxPages !== undefined) demo.crawlMaxPages = sanitizedMaxPages;
  demo.knowledgeBaseId = ensureKnowledgeBase(demo, null);

  const demos = loadDemos();
  demos.push(demo);
  saveDemos(demos);
  res.json({ success: true, demo, demoUrl: `/demo.html?id=${demo.id}` });
});

apiRouter.put('/demos/:id', requireAuth, (req, res) => {
  const { clientUrl, searchUrls, instructions, colors, style, searchMode, welcome, questions, logo, crawlMaxDepth, crawlMaxPages } = req.body;
  const demoId = req.params.id;

  if (!demoId) return res.status(400).json({ error: 'ID demo richiesto' });
  if (!clientUrl || !searchUrls || !Array.isArray(searchUrls) || searchUrls.length === 0)
    return res.status(400).json({ error: 'Dati mancanti o non validi' });

  try { new URL(clientUrl); searchUrls.forEach(u => new URL(u)); }
  catch { return res.status(400).json({ error: 'URL non valido' }); }

  const demos = loadDemos();
  const idx = demos.findIndex(d => d.id === demoId);
  if (idx === -1) return res.status(404).json({ error: 'Demo non trovata' });

  const user = req.session.user;
  if (user.role !== 'admin' && demos[idx].createdBy !== user.username) {
    return res.status(403).json({ error: 'Non autorizzato a modificare questa demo' });
  }

  const previousDemo = demos[idx];
  const resolvedSearchMode = SITE_ANALYSIS_VALID_MODES.has(searchMode) ? searchMode : (previousDemo.searchMode || 'live');
  const sanitizedMaxDepth = sanitizeCrawlNumber(crawlMaxDepth, 1, 10);
  const sanitizedMaxPages = sanitizeCrawlNumber(crawlMaxPages, 10, 2000);
  const knowledgeBaseId = ensureKnowledgeBase(
    { searchMode: resolvedSearchMode, searchUrls, crawlMaxDepth: sanitizedMaxDepth, crawlMaxPages: sanitizedMaxPages },
    previousDemo
  );

  demos[idx] = {
    ...previousDemo,
    clientUrl,
    searchUrls,
    searchMode: resolvedSearchMode,
    knowledgeBaseId,
    instructions: instructions || '',
    colors: colors || previousDemo.colors,
    style: style ? sanitizeStyle(style) : (previousDemo.style || sanitizeStyle(null)),
    welcome: sanitizeWelcome(welcome),
    questions: sanitizeQuestions(questions),
    logo: sanitizeLogo(logo),
    updatedAt: new Date().toISOString()
  };
  if (sanitizedMaxDepth !== undefined) demos[idx].crawlMaxDepth = sanitizedMaxDepth;
  else delete demos[idx].crawlMaxDepth;
  if (sanitizedMaxPages !== undefined) demos[idx].crawlMaxPages = sanitizedMaxPages;
  else delete demos[idx].crawlMaxPages;

  saveDemos(demos);
  res.json({ success: true, demo: demos[idx] });
});

apiRouter.get('/demos', requireAuth, (req, res) => {
  const demos = loadDemos();
  const user  = req.session.user;
  const list  = user.role === 'admin' ? demos : demos.filter(d => d.createdBy === user.username);
  res.json(list.reverse());
});

apiRouter.delete('/demos/:id', requireAuth, (req, res) => {
  const demos = loadDemos();
  const demo = demos.find(d => d.id === req.params.id);
  if (!demo) return res.status(404).json({ success: false, error: 'Demo non trovata' });

  const user = req.session.user;
  if (user.role !== 'admin' && demo.createdBy !== user.username) {
    return res.status(403).json({ success: false, error: 'Non autorizzato a cancellare questa demo' });
  }

  saveDemos(demos.filter(d => d.id !== demo.id));
  res.json({ success: true });
});

apiRouter.get('/demos/:id', (req, res) => {
  const demo = loadDemos().find(d => d.id === req.params.id);
  if (!demo) return res.status(404).json({ error: 'Demo non trovata' });
  res.json(demo);
});

// ── Recrawl history (controllo periodico "il sito è stato aggiornato?") ──────
// Storico letto da data/knowledge-engine/recrawl-history.json (scritto solo
// da src/knowledge-engine/recrawl-checker.js — mai da queste route). Stesso
// pattern auth/filtro di GET /demos: admin vede tutto, gli altri solo le
// proprie demo.
apiRouter.get('/recrawl-history', requireAuth, (req, res) => {
  const user = req.session.user;
  const demos = loadDemos();
  const visible = user.role === 'admin' ? demos : demos.filter(d => d.createdBy === user.username);
  const history = readHistory();
  const rows = visible
    .filter(d => history[d.id])
    .map(d => {
      const h = history[d.id];
      return {
        demoId: d.id,
        product: d.product,
        clientUrl: d.clientUrl,
        createdBy: d.createdBy,
        lastRunAt: h.lastRunAt,
        lastRunOutcome: h.lastRunOutcome,
        runsCount: (h.runs || []).length
      };
    });
  res.json(rows);
});

apiRouter.get('/recrawl-history/:demoId', requireAuth, (req, res) => {
  const demo = loadDemos().find(d => d.id === req.params.demoId);
  if (!demo) return res.status(404).json({ error: 'Demo non trovata' });
  const user = req.session.user;
  if (user.role !== 'admin' && demo.createdBy !== user.username) {
    return res.status(403).json({ error: 'Non autorizzato' });
  }
  const entry = readHistory()[demo.id];
  if (!entry) return res.status(404).json({ error: 'Nessuno storico per questa demo' });
  res.json(entry);
});

// Trigger manuale "esegui ora" dalla UI. Risponde subito e lascia girare la
// pipeline in background (può richiedere minuti se ci sono pagine cambiate)
// — il client rilegge GET /recrawl-history/:demoId per vedere l'esito,
// stesso pattern di polling già usato per l'avanzamento dell'ingestion.
apiRouter.post('/recrawl-history/:demoId/run', requireAuth, (req, res) => {
  const demo = loadDemos().find(d => d.id === req.params.demoId);
  if (!demo) return res.status(404).json({ error: 'Demo non trovata' });
  const user = req.session.user;
  if (user.role !== 'admin' && demo.createdBy !== user.username) {
    return res.status(403).json({ error: 'Non autorizzato' });
  }
  if (demo.searchMode !== 'crawling' || !demo.knowledgeBaseId) {
    return res.status(400).json({ error: "La demo non è in modalità 'crawling'" });
  }
  runRecrawlForDemo(demo, { trigger: 'manual', triggeredBy: user.username })
    .catch(err => console.error(`[recrawl] run-now fallito per ${demo.id}:`, err.message));
  res.json({ started: true });
});

// ── Ingestion status (popup di avanzamento in config_*.html) ─────────────────
// Traduce lo stato grezzo di knowledge-engine (queued/running/.../completed +
// stats del JobRunner) nel vocabolario di fase già atteso dal frontend
// (STATUS_LABEL in config_comunicai.html/config_medicai.html): pending,
// crawling, embedding, indexing, ready, empty, failed, legacy.
const INGESTION_TERMINAL_PHASES = new Set(['ready', 'empty', 'failed', 'legacy']);

function computeIngestionState(kbId) {
  if (!kbId) return { phase: 'legacy', stats: {} };

  let job;
  try { job = knowledgeEngine.getJobStatus(kbId); } catch { job = null; }
  if (!job) return { phase: 'legacy', stats: {} };

  const stats = job.stats || {};
  let phase;
  switch (job.status) {
    case 'queued':
    case 'paused':
      phase = 'pending';
      break;
    case 'running':
      if (!stats.crawlComplete) phase = 'crawling';
      else if ((stats.pagesPendingIngest || 0) > 0) phase = 'embedding';
      else phase = 'indexing';
      break;
    case 'completed':
      phase = (stats.chunksIndexed || 0) > 0 ? 'ready' : 'empty';
      break;
    case 'cancelled':
    case 'failed':
    default:
      phase = 'failed';
      break;
  }

  const error = job.error || (job.status === 'cancelled' ? 'Indicizzazione annullata' : undefined);
  return { phase, stats, error };
}

apiRouter.get('/ingestion/:kbId/state', requireAuth, (req, res) => {
  res.json(computeIngestionState(req.params.kbId));
});

apiRouter.get('/ingestion/:kbId/progress', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 2000\n\n');

  const kbId = req.params.kbId;
  let closed = false;

  const timer = setInterval(() => {
    if (closed) return;
    const state = computeIngestionState(kbId);
    res.write(`event: update\ndata: ${JSON.stringify(state)}\n\n`);
    if (INGESTION_TERMINAL_PHASES.has(state.phase)) {
      closed = true;
      clearInterval(timer);
      res.end();
    }
  }, 1000);

  req.on('close', () => { closed = true; clearInterval(timer); });
});

// Messaggio di benvenuto/domande suggerite/logo personalizzati per demo — già
// atteso da tempo da ChatWidget.jsx (fetch a questa rotta), che finora falliva
// sempre in 404 e ricadeva silenziosamente sui default fissi per prodotto
// (FALLBACK_WELCOME/FALLBACK_SUGGESTIONS/logo di prodotto in themes.js).
// Pubblica come /demos/:id (nessun requireAuth): il widget la interroga da
// una pagina demo pubblica, non da un contesto autenticato admin.
apiRouter.get('/demos/:id/suggestions', (req, res) => {
  const demo = loadDemos().find(d => d.id === req.params.id);
  if (!demo) return res.status(404).json({ error: 'Demo non trovata' });

  let siteName = '';
  try { siteName = new URL(demo.clientUrl).hostname.replace(/^www\./, ''); }
  catch { /* clientUrl assente/non valido: siteName resta vuoto, non blocca la risposta */ }

  res.json({
    welcome: demo.welcome || '',
    questions: Array.isArray(demo.questions) ? demo.questions : [],
    siteName,
    logo: demo.logo || ''
  });
});

// ── Chat ─────────────────────────────────────────────────────────────────────
// La logica di business (tool-calling, system prompt, streaming SSE) vive in
// src/orchestrator.js + src/agents/*: il widget React si aspetta risposte in
// streaming SSE, non JSON sincrono (vedi widget-src/src/widget/ChatWidget.jsx).
// Per le demo in modalità 'crawling', search_configured_sites interroga prima
// la knowledge base indicizzata (RAG, src/pipeline/rag.js); la ricerca live su
// deep-search-engine.js resta come fallback quando il RAG non trova nulla, e
// come unico motore per le demo in modalità 'live' (vedi tool-executor-agent.js).
apiRouter.post('/chat/message', async (req, res) => {
  const client = getOpenAI();
  if (!client) return res.status(503).json({ success: false, error: 'OpenAI non disponibile' });
  await orchestrateChat(req, res, client, { rag: getRag() });
});

// Upload allegati chat (immagini/documenti) - salvati in data/uploads/, serviti da /uploads
apiRouter.post('/chat/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File troppo grande (max 15MB)' : err.message;
      return res.status(400).json({ success: false, error: message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Tipo di file non supportato' });
    }
    const kind = classifyMime(req.file.mimetype);
    res.json({
      success: true,
      data: { url: `/uploads/${req.file.filename}`, name: req.file.originalname, size: req.file.size, mimeType: req.file.mimetype, kind }
    });
  });
});

// Input vocale del widget: audio registrato dal browser → testo (Whisper).
// File tenuto in memoria e scartato subito dopo, non finisce mai su disco.
apiRouter.post('/chat/stt', (req, res) => {
  sttUpload.single('audio')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Audio troppo grande (max 15MB)' : err.message;
      return res.status(400).json({ success: false, error: message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'File audio richiesto' });
    }
    const client = getOpenAI();
    if (!client) return res.status(503).json({ success: false, error: 'OpenAI non disponibile' });
    try {
      const result = await transcribeAudio(req.file.buffer, req.file.originalname, req.file.mimetype, client);
      res.json({ success: true, data: { text: result.text } });
    } catch (error) {
      console.error('STT error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

apiRouter.post('/chat/clear', (req, res) => {
  const { sessionId } = req.body;
  clearChatSession(sessionId);
  res.json({ success: true });
});

apiRouter.post('/chat/tts', async (req, res) => {
  const { text, voice = 'alloy', speed = 1.0 } = req.body;
  if (!text) return res.status(400).json({ success: false, error: 'Testo richiesto' });

  const client = getOpenAI();
  if (!client) return res.status(503).json({ success: false, error: 'OpenAI non disponibile' });

  try {
    const result = await textToSpeech(text, voice, speed, client);
    if (result.success) return res.json({ success: true, data: { audio: result.audio } });
    return res.status(500).json({ success: false, error: result.error });
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Debug ─────────────────────────────────────────────────────────────────────
// NOTA: deep-search-engine.js restituisce contesto grezzo strutturato (non una
// risposta finale scritta da un AI): `result.content` qui sotto è quel contesto
// grezzo, utile per ispezionare cosa il crawler ha effettivamente trovato/estratto
// dal sito, non una risposta pronta per l'utente (quella si ottiene solo passando
// per l'endpoint di chat, dove viene sintetizzata a valle).
apiRouter.post('/debug/medicai-search', async (req, res) => {
  const { query, urls } = req.body;
  if (!query || !urls || !Array.isArray(urls) || urls.length === 0)
    return res.status(400).json({ success: false, error: 'Query e URLs richiesti' });

  try {
    const start   = Date.now();
    const context = await deepSearchConfiguredSites(query, urls, 'medicai');
    const ms      = Date.now() - start;
    res.json({ success: true, query, urls, duration: ms, result: { success: true, content: context }, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, query, urls, timestamp: new Date().toISOString() });
  }
});

// ── LiveAvatar: sessioni + proxy iframe ────────────────────────────────────
const liveavatarSessions = new Map();

apiRouter.post('/liveavatar/session', cors({
  origin: ['http://localhost:3000', 'http://localhost:3111', 'https://app.liveavatar.com'],
  credentials: true
}), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const apiKey = process.env.LIVEAVATAR_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'LiveAvatar API key not configured' });

    liveavatarSessions.set(sessionId, { created: new Date().toISOString(), apiKey, status: 'active' });
    console.log(`✅ LiveAvatar session created: ${sessionId}`);

    res.cookie('liveavatar_session', sessionId, {
      secure: true, sameSite: 'none', httpOnly: true, maxAge: 30 * 60 * 1000
    });

    res.json({
      success: true, sessionId,
      iframeUrl: `/api/liveavatar?sessionId=${sessionId}`,
      expires: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    });
  } catch (error) {
    console.error('LiveAvatar session error:', error);
    res.status(500).json({ error: 'Session creation failed' });
  }
});

apiRouter.get('/liveavatar', cors({
  origin: ['http://localhost:3000', 'http://localhost:3111', 'https://app.liveavatar.com'],
  credentials: true,
  methods: ['GET']
}), async (req, res) => {
  try {
    const { sessionId, chatSessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    console.log(`🔄 LiveAvatar proxy: liveSession=${sessionId}, chatSession=${chatSessionId || 'none'}`);

    const apiKey = liveAvatarConfig.apiKey;
    if (!apiKey) return res.status(503).json({ error: 'LiveAvatar service unavailable' });

    console.log(`🔄 LiveAvatar CONTENT proxy GET: ${sessionId} (apiKey: ${apiKey.slice(0,8)}...)`);

    if (!liveavatarSessions.has(sessionId)) {
      console.warn(`⚠️ LiveAvatar unknown session: ${sessionId}`);
      liveavatarSessions.set(sessionId, { created: new Date().toISOString(), apiKey, status: 'active' });
    }

    const avatarId = liveAvatarConfig.avatarId || '5059544e-f7b3-4ffa-8cc0-5b2160f87892';
    const externalAvatarUrl = `https://embed.liveavatar.com/v1/${avatarId}?sessionId=${encodeURIComponent(sessionId)}`;

    console.log(`📄 Building LiveAvatar scaled iframe: ${sessionId}`);

    const scaledHtml = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LiveAvatar</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent;
    }
    .avatar-scaler {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      transform-origin: top left center;
    }
    .avatar-scaler iframe {
      width: 100%;
      height: 100%;
      border: none !important;
      background: transparent !important;
      display: block;
    }
  </style>
</head>
<body>
  <div class="avatar-scaler">
    <iframe
      src="${externalAvatarUrl}"
      allow="microphone; camera; display-capture; autoplay; encrypted-media"
      sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation"
      title="LiveAvatar Assistant"
      scrolling="no"
    ></iframe>
  </div>
  <script>
    window.liveavatarProxySessionId = '${sessionId}';
    window.liveavatarProxyOrigin = '${req.headers.origin || 'https://app.liveavatar.com'}';
    console.log('✅ LiveAvatar scaled iframe loaded:', '${sessionId}');
    window.parent.postMessage({ type: 'avatar_session_ready', sessionId: '${sessionId}' }, '*');
  <\/script>
</body>
</html>`;

    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'ALLOWALL',
      'Referrer-Policy': 'no-referrer-when-downgrade',
      'Access-Control-Allow-Origin': req.headers.origin,
      'Access-Control-Allow-Credentials': 'true',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.cookie('liveavatar_proxy', 'true', { secure: true, sameSite: 'none', maxAge: 30 * 60 * 1000 });

    console.log(`✅ LiveAvatar scaled HTML sent: ${sessionId}`);
    res.status(200).send(scaledHtml);

  } catch (error) {
    console.error('❌ LiveAvatar proxy error:', error.message);

    const fallbackHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>LiveAvatar Assistant</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
          *{margin:0;padding:0;box-sizing:border-box;}
          body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#333;}
          .fallback{max-width:320px;padding:40px 30px;background:hsla(0,0%,100%,.95);border-radius:20px;box-shadow:0 25px 50px rgba(0,0,0,.25);text-align:center;}
          .emoji{font-size:4rem;margin-bottom:1rem;display:block;}
          .title{font-size:1.4rem;font-weight:700;color:#2d3748;margin-bottom:.5rem;}
          .subtitle{font-size:.95rem;color:#718096;margin-bottom:1.5rem;}
          .session{font-size:.8rem;color:#a0aec0;font-family:monospace;padding:8px;border-radius:6px;background:#f7fafc;margin-bottom:1.5rem;}
          .link{padding:12px 24px;background:#4299e1;color:white;text-decoration:none;border-radius:8px;font-weight:600;transition:all .2s;display:inline-block;}
          .link:hover{background:#3182ce;transform:translateY(-1px);}
        </style>
      </head>
      <body>
        <div class="fallback">
          <span class="emoji">🤖</span>
          <div class="title">LiveAvatar Assistant</div>
          <div class="subtitle">Caricamento in corso${typeof window !== 'undefined' && window.liveavatarProxySessionId ? '' : '...'}</div>
          <div class="session">Session: ${req.query.sessionId || 'N/A'}</div>
          <a href="https://liveavatar.com" target="_blank" rel="noopener" class="link">Visita LiveAvatar</a>
        </div>
        <script>
          console.warn('LiveAvatar fallback active (proxy error)');
          window.liveavatarProxyError = true;
          window.liveavatarProxySessionId = '${req.query.sessionId}';
        <\/script>
      </body>
      </html>`;

    res.status(200).send(fallbackHtml);
  }
});

// ── LiveAvatar Webhook (chat completion diretta, senza tool/RAG) ──────────────
const liveavatarWebhookSessions = new Map();

apiRouter.post('/liveavatar/webhook', async (req, res) => {
  try {
    const { message, sessionId, messageType = 'text' } = req.body;
    console.log('🤖 LiveAvatar webhook:', { sessionId, messageType, messageLength: message?.length });

    if (!message) return res.status(400).json({ success: false, error: 'Messaggio richiesto' });

    const apiKey = req.headers['x-liveavatar-api-key'] || req.headers['authorization'];
    if (!apiKey || apiKey !== process.env.LIVEAVATAR_API_KEY) {
      return res.status(401).json({ success: false, error: 'API key non valida' });
    }

    const sid = sessionId || `liveavatar_session_${Date.now()}`;
    if (!liveavatarWebhookSessions.has(sid)) liveavatarWebhookSessions.set(sid, []);
    const history = liveavatarWebhookSessions.get(sid);

    history.push({ role: 'user', content: message });

    const systemPrompt = 'Sei un assistente virtuale professionale per ComunicAI. Rispondi sempre in italiano.';
    const messagesForAPI = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10)
    ];

    const client = getOpenAI();
    if (!client) return res.status(503).json({ success: false, error: 'OpenAI non disponibile' });

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messagesForAPI,
      temperature: 0.3,
      max_tokens: 1000
    });

    const assistantMessage = response.choices[0].message.content;
    history.push({ role: 'assistant', content: assistantMessage });

    console.log(`📤 LiveAvatar response: ${assistantMessage.length} chars`);

    res.json({ success: true, message: assistantMessage, sessionId: sid, timestamp: new Date().toISOString() });

  } catch (error) {
    console.error('❌ LiveAvatar webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── LiveAvatar Avatar Context ─────────────────────────────────────────────────
apiRouter.get('/avatar-context', cors({
  origin: ['http://localhost:3000', 'http://localhost:3111', 'https://app.liveavatar.com', 'https://staging.ai4smartcity.ai'],
  credentials: true
}), async (req, res) => {
  try {
    const sessionId = req.query.sessionId || req.query.s;
    const product = req.session?.user?.currentProduct || req.query.sector || 'comunicai';
    const dateStr = req.query.d || getTodayYYYYMMDD();

    console.log(`🤖 Avatar context: session=${sessionId}, product=${product}, date=${dateStr}`);

    const contextData = generateDynamicContext(sessionId, product, dateStr);

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.json(contextData);

  } catch (error) {
    console.error('❌ Avatar context error:', error);
    res.status(500).json({
      error: 'Context generation failed',
      metadata: { last_update: getTodayYYYYMMDD(), version: "1.2.0" },
      verticals: {}
    });
  }
});

// ── Monitoring ────────────────────────────────────────────────────────────────
apiRouter.get('/monitoring/status', (req, res) => {
  try {
    const report = monitoring.generateReport();
    res.json({
      monitoring: monitoring.isMonitoring, config: monitoring.config,
      metrics: {
        apiCalls:      monitoring.metrics.apiCalls.length,
        searchResults: monitoring.metrics.searchResults.length,
        systemHealth:  monitoring.metrics.systemHealth.length,
        errors:        monitoring.metrics.errors.length,
        performance:   monitoring.metrics.performance.length
      },
      alerts: { total: monitoring.alerts.length, unacknowledged: monitoring.alerts.filter(a => !a.acknowledged).length },
      summary: report.summary
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.get('/monitoring/metrics', (req, res) => {
  try   { res.json(monitoring.getRecentMetrics()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.get('/monitoring/alerts', (req, res) => {
  try   { res.json(monitoring.getRecentAlerts()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.get('/monitoring/report', (req, res) => {
  try   { res.json(monitoring.generateReport()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.get('/monitoring/config', (req, res) => {
  try   { res.json(monitoring.config); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.post('/monitoring/config', (req, res) => {
  try {
    monitoring.config = { ...monitoring.config, ...req.body };
    monitoring.saveConfig();
    res.json({ success: true, config: monitoring.config });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.get('/monitoring/health-check', async (req, res) => {
  try   { res.json(await monitoring.performHealthCheck()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.post('/monitoring/alerts/:id/acknowledge', (req, res) => {
  try {
    const alert = monitoring.alerts.find(a => a.id === req.params.id);
    if (alert) { alert.acknowledged = true; res.json({ success: true, alert }); }
    else res.status(404).json({ error: 'Alert non trovato' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Server avviato sulla porta ${PORT}`);
  console.log(`   Login ComunicAI → http://localhost:${PORT}/login_comunicai.html`);
  console.log(`   Login MedicAI   → http://localhost:${PORT}/login_medicai.html`);
  console.log(`   Login TourismAI → http://localhost:${PORT}/login_tourism.html`);

  if (PORT == 3000) {
    console.log('\n📋 Credenziali default (password: password)');
    console.log('   admin / mario.rossi / giulia.bianchi');
    console.log('\n⚠️  Cambia le password in users.json prima di andare in produzione!\n');
  }
});
