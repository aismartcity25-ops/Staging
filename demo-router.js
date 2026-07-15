const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const chatService = require('./chat-service.js');

// Lazy initialization for OpenAI Client
let openai = null;

function getOpenAIClient() {
  if (!openai) {
    if (process.env.OPENAI_API_KEY) {
      openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
      console.log('✓ OpenAI client initialized in demo-router');
    } else {
      console.warn('⚠️ OPENAI_API_KEY not found in environment - AI features will be disabled');
    }
  }
  return openai;
}

// Importiamo le funzioni helper da server.js
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8'));
  } catch (error) {
    console.error('Error loading users.json:', error.message);
    return [];
  }
}

function loadDemos() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'demos.json'), 'utf8'));
  } catch (error) {
    console.error('Error loading demos.json:', error.message);
    return [];
  }
}

function saveDemos(demos) {
  try {
    fs.writeFileSync(path.join(__dirname, 'demos.json'), JSON.stringify(demos, null, 2));
  } catch (error) {
    console.error('Error saving demos.json:', error.message);
  }
}

// Demo-specific routes only (no duplicate API routes - those are in server.js)
// Demo Create API
router.post('/api/demos', (req, res) => {
  const { clientUrl, searchUrls, instructions, colors } = req.body;

  if (!clientUrl || !searchUrls || !Array.isArray(searchUrls) || searchUrls.length === 0) {
    return res.status(400).json({ error: 'Dati mancanti o non validi' });
  }

  // Validate URLs
  try {
    new URL(clientUrl);
    searchUrls.forEach(url => new URL(url));
  } catch {
    return res.status(400).json({ error: 'URL non valido' });
  }

  // Default colors if not provided
  const defaultColors = {
    primary: '#00b4ff',
    secondary: '#0066cc',
    userBg: '#3b82f6',
    userText: '#ffffff',
    aiBg: '#e5e7eb',
    aiText: '#1f2937'
  };

  const demo = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    createdBy: req.session.user.username,
    product: req.session.user.currentProduct,
    clientUrl,
    searchUrls,
    instructions: instructions || '',
    colors: colors || defaultColors,
  };

  const demos = loadDemos();
  demos.push(demo);
  saveDemos(demos);

  res.json({
    success: true,
    demo,
    demoUrl: `/demo.html?id=${demo.id}`
  });
});

// Demo Get by ID
router.get('/api/demos/:id', (req, res) => {
  const demos = loadDemos();
  const demo = demos.find(d => d.id === req.params.id);
  if (!demo) return res.status(404).json({ error: 'Demo non trovata' });
  res.json(demo);
});

// Demo List for current user
router.get('/api/demos', (req, res) => {
  const demos = loadDemos();
  const user = req.session.user;
  const filtered = user.role === 'admin'
    ? demos
    : demos.filter(d => d.createdBy === user.username);
  res.json(filtered.reverse());
});

// Demo Chat API - Uses shared chat service
router.post('/api/chat/message', async (req, res) => {
  const client = getOpenAIClient();
  await chatService.handleChat(req, res, client);
});

// Demo TTS API - Uses shared chat service
router.post('/api/chat/tts', async (req, res) => {
  const { text, voice = 'alloy', speed = 1.0 } = req.body;
  
  if (!text) {
    return res.status(400).json({ success: false, error: 'Text is required' });
  }

  try {
    const client = getOpenAIClient();
    const result = await chatService.textToSpeech(text, voice, speed, client);
    if (result.success) {
      return res.json({
        success: true,
        data: { audio: result.audio }
      });
    } else {
      return res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('TTS error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Demo Chat Clear API
router.post('/api/chat/clear', (req, res) => {
  const { sessionId } = req.body;
  chatService.clearChatSession(sessionId);
  res.json({ success: true });
});

module.exports = router;