const twilio = require('twilio');
require('dotenv').config();

/**
 * TwilioService - Production-ready service for WhatsApp and Email
 * Handles message sending with retry logic and error handling
 */
class TwilioService {
  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;
    this.authToken = process.env.TWILIO_AUTH_TOKEN;
    
    if (!this.accountSid || !this.authToken) {
      console.warn('⚠️ Twilio credentials not configured - WhatsApp features disabled');
      this.client = null;
    } else {
      this.client = twilio(this.accountSid, this.authToken);
      console.log('✓ Twilio client initialized');
    }
    
    this.fromWhatsApp = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886'; // Default sandbox
  }

  /**
   * Send WhatsApp message with retry logic
   * @param {string} to - Phone number (without whatsapp: prefix)
   * @param {string} message - Message text
   * @returns {Promise<object>} Twilio message result
   */
  async sendWhatsAppMessage(to, message) {
    if (!this.client) {
      throw new Error('Twilio client not initialized');
    }

    try {
      const result = await this.client.messages.create({
        body: message,
        from: this.fromWhatsApp,
        to: `whatsapp:${to}`
      });
      
      console.log(`📤 WhatsApp sent to ${to}: ${message.substring(0, 50)}...`);
      return result;
    } catch (error) {
      console.error('❌ Error sending WhatsApp message:', error.message);
      throw error;
    }
  }

  /**
   * Send WhatsApp message with automatic retry on failure
   * @param {string} to - Phone number (without whatsapp: prefix)
   * @param {string} message - Message text
   * @param {number} maxRetries - Maximum number of retries (default: 2)
   * @returns {Promise<object|null>} Twilio message result or null after all retries fail
   */
  async sendWhatsAppMessageWithRetry(to, message, maxRetries = 2) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        if (attempt > 1) {
          // Exponential backoff: wait 1s, 2s, 4s...
          const waitTime = Math.pow(2, attempt - 1) * 500;
          console.log(`🔄 Retry attempt ${attempt - 1}/${maxRetries} in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        return await this.sendWhatsAppMessage(to, message);
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ WhatsApp send attempt ${attempt} failed:`, error.message);
      }
    }
    
    console.error(`❌ WhatsApp send failed after ${maxRetries + 1} attempts for ${to}`);
    throw lastError;
  }

  /**
   * Send email via Twilio SendGrid
   * @param {string} to - Recipient email
   * @param {string} subject - Email subject
   * @param {string} body - Email body
   * @param {object} options - Additional options
   * @returns {Promise<object>} Twilio message result
   */
  async sendEmail(to, subject, body, options = {}) {
    if (!this.client) {
      throw new Error('Twilio client not initialized');
    }

    try {
      const result = await this.client.messages.create({
        body: body,
        subject: subject,
        from: process.env.TWILIO_EMAIL_SENDER,
        to: to,
        ...options
      });
      return result;
    } catch (error) {
      console.error('Error sending email:', error);
      throw error;
    }
  }

  /**
   * Parse incoming WhatsApp message from webhook
   * @param {object} req - Express request object
   * @returns {object} Parsed message data
   */
  async receiveWhatsAppMessage(req) {
    const { Body, From, MessageSid, MediaUrl0, MediaContentType0 } = req.body;
    
    const parsed = {
      from: From?.replace('whatsapp:', ''),
      message: Body || '',
      sid: MessageSid,
      timestamp: new Date().toISOString()
    };
    
    // Handle media if present
    if (MediaUrl0) {
      parsed.media = {
        url: MediaUrl0,
        contentType: MediaContentType0 || 'unknown'
      };
    }
    
    return parsed;
  }

  /**
   * Parse incoming email from webhook
   * @param {object} req - Express request object
   * @returns {object} Parsed email data
   */
  async receiveEmail(req) {
    const { subject, text, from, html } = req.body;
    return {
      from: from,
      subject: subject || '(no subject)',
      message: text || '',
      html: html || '',
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new TwilioService();
