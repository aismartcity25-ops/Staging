const twilio = require('twilio');
const express = require('express');
const router = express.Router();
require('dotenv').config();

// ── Branding Configuration ─────────────────────────────────────────
const BOT_BRAND = 'ComunicAI';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ── Session Store with Timeout ──────────────────────────────────────────────
const whatsappSessions = new Map();

function getSession(phoneNumber) {
  const session = whatsappSessions.get(phoneNumber);

  if (session && (Date.now() - session.lastActivity) < SESSION_TIMEOUT_MS) {
    return session;
  }

  const newSession = {
    sessionId: null,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };

  whatsappSessions.set(phoneNumber, newSession);
  return newSession;
}

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of whatsappSessions.entries()) {
    if ((now - session.lastActivity) > SESSION_TIMEOUT_MS) {
      whatsappSessions.delete(phone);
    }
  }
}, 5 * 60 * 1000);

// ── Helper: Internal call to the main chat endpoint ─────────────────────────
/**
 * Calls the same chat endpoint used by the web widget.
 * This ensures WhatsApp uses the EXACT SAME AI logic, tools, and configured sites.
 */
async function callChatEngine(message, sessionId, demoId = 'default') {
  const baseUrl = process.env.INTERNAL_BASE_URL || `http://localhost:${process.env.PORT || 3111}`;
  const url = `${baseUrl}/api/chat/message`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        sessionId,
        demoId
      })
    });

    if (!response.ok) {
      throw new Error(`Chat API error: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('❌ Chat engine call failed:', error.message);
    throw error;
  }
}

// ── Load demos helper ───────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');

function loadDemos() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../demos.json'), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Find the first available demo ID, or use 'default' if none exist.
 */
function getDefaultDemoId() {
  const demos = loadDemos();
  return demos.length > 0 ? demos[0].id : 'default';
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/twilio/webhook
 * Main webhook for receiving WhatsApp messages from Twilio.
 * Routes incoming WhatsApp messages through the SAME chat engine used by the web widget.
 */
router.post('/', async (req, res) => {
  try {
    const { MessageSid, From, Body, To } = req.body;

    console.log('📱 Twilio Webhook received:', {
      MessageSid,
      From,
      Body: Body?.substring(0, 50) + (Body?.length > 50 ? '...' : ''),
      To
    });

    // ── Twilio Signature Validation (mandatory in production) ──
    const isProduction = process.env.NODE_ENV === 'production';
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const signature = req.headers['x-twilio-signature'];

    if (signature && authToken) {
      const webhookUrl = process.env.TWILIO_WEBHOOK_URL || `https://${req.headers.host}${req.originalUrl}`;
      const isValid = twilio.validateRequest(authToken, signature, webhookUrl, req.body);

      if (!isValid) {
        console.warn('⚠️ Invalid Twilio signature - request rejected');
        return res.status(403).send('Invalid signature');
      }
    } else if (isProduction) {
      console.warn('⚠️ Missing Twilio signature in production environment');
      return res.status(403).send('Signature required');
    }

    // ── Handle WhatsApp Message ──
    if (MessageSid && From && Body) {
      const phoneNumber = From.replace('whatsapp:', '');
      console.log(`📨 WhatsApp from ${phoneNumber}: ${Body}`);

      // Get or create session
      const session = getSession(phoneNumber);
      session.lastActivity = Date.now();

      // Ensure session has a chat sessionId
      if (!session.sessionId) {
        session.sessionId = `wa_${phoneNumber}_${Date.now()}`;
      }

      // Use the configured default demo, or the first available
      const demoId = session.demoId || getDefaultDemoId();
      console.log(`💬 Using demo: ${demoId} | session: ${session.sessionId}`);

      // ── Route through the main chat engine ─────────────────────────────
      let responseText = 'Mi dispiace, il servizio non è al momento disponibile. Riprova più tardi.';

      try {
        const chatResult = await callChatEngine(Body, session.sessionId, demoId);
        if (chatResult.success && chatResult.data && chatResult.data.response) {
          responseText = chatResult.data.response;
          // Update sessionId from chat engine if it changed
          if (chatResult.data.sessionId) {
            session.sessionId = chatResult.data.sessionId;
          }
        }
      } catch (chatError) {
        console.error('❌ Chat engine error:', chatError.message);
      }

      // Import twilioService for sending reply
      const twilioService = require('../services/twilio-service');

      // Send reply via Twilio
      try {
        await twilioService.sendWhatsAppMessage(phoneNumber, responseText);
        console.log(`✅ Reply sent to ${phoneNumber}`);
      } catch (sendError) {
        console.error('❌ Error sending WhatsApp reply:', sendError.message);
      }

      // Respond to Twilio webhook (must return 200)
      res.status(200).send();

    } else if (req.body.subject || req.body.text) {
      // ── Handle Email Message ──
      const twilioService = require('../services/twilio-service');
      const emailData = await twilioService.receiveEmail(req);
      console.log('📧 Email received:', emailData);
      res.status(200).send();

    } else {
      console.log('❓ Unknown message type:', req.body);
      res.status(200).send();
    }

  } catch (error) {
    console.error('❌ Twilio webhook error:', error);
    res.status(500).send('Error processing message');
  }
});

/**
 * POST /api/twilio/webhook/clear-session
 * Clear WhatsApp session for a phone number
 */
router.post('/clear-session', (req, res) => {
  const { phoneNumber } = req.body;
  if (phoneNumber && whatsappSessions.has(phoneNumber)) {
    whatsappSessions.delete(phoneNumber);
    res.json({ success: true, message: `Session cleared for ${phoneNumber}` });
  } else {
    res.json({ success: false, message: 'No session found' });
  }
});

/**
 * GET /api/twilio/webhook/health
 * Health check endpoint for Twilio webhook
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'whatsapp',
    brand: BOT_BRAND,
    sessions: whatsappSessions.size,
    integratedWith: '/api/chat/message',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;