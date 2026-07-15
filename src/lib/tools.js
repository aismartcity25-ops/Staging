'use strict';

/**
 * tools.js — Schemi dei tool OpenAI (SINGLE SOURCE).
 *
 * Prima duplicati identici in server.js (oggetto `tools`) e
 * chat-service.js (funzione getTools()). Ora un'unica definizione.
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_websites',
      description: 'Search the web for up-to-date information. Use this when you need current information that you might not know.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to find information' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_configured_sites',
      description: 'Search the indexed knowledge base for this client\'s website(s). Use this when the user asks about services, information, or content covered by the indexed knowledge base (built from the configured source URLs). This tool queries only the knowledge base produced by the ingestion pipeline.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to find information in the knowledge base' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_sms',
      description: 'Send an SMS message to a user. Use this when the user wants to receive information via SMS.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Phone number in international format (e.g., +393331234567)' },
          message: { type: 'string', description: 'The SMS message' }
        },
        required: ['phone', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send an email to a user. Use this when the user wants to receive information via email.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Email address' },
          subject: { type: 'string', description: 'Email subject' },
          message: { type: 'string', description: 'Email body content' }
        },
        required: ['to', 'subject', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'text_to_speech',
      description: 'Convert text to speech (TTS). Use this when the user wants to listen to the response or needs audio output.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to convert to speech' },
          voice: { type: 'string', description: "Voice to use: 'alloy', 'echo', 'fable', 'onyx', 'nova', or 'shimmer'", enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
          speed: { type: 'number', description: 'Speed of speech: 0.25 (slow) to 4.0 (fast), default is 1.0' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_document',
      description: 'Generate a downloadable PDF document for the user (e.g. a summary, an information sheet, or requested content in document form). Use this only when the user explicitly asks to receive something as a PDF/document/file to download.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title, also used as the file name' },
          content: { type: 'string', description: 'The full plain-text content of the document' }
        },
        required: ['title', 'content']
      }
    }
  }
];

/** Tutti i tool. */
function getTools() {
  return TOOLS;
}

/** Tool disponibili, escludendo search_websites quando ci sono URL configurati. */
function getToolsForDemo(hasConfiguredUrls) {
  return hasConfiguredUrls ? TOOLS.filter(t => t.function.name !== 'search_websites') : TOOLS;
}

module.exports = { TOOLS, getTools, getToolsForDemo };
