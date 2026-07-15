/**
 * Chat Service - Shared module for chat functionality
 * Used by both server.js and demo-router.js
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { UniversalPDFCompiler } = require('./create-universal-pdf-compiler.js');

// Load prompts for system prompt building
let buildSystemPrompt;
try {
  const prompts = require('./prompts.js');
  buildSystemPrompt = prompts.buildSystemPrompt;
} catch (e) {
  console.warn('Could not load prompts.js:', e.message);
  // Fallback system prompt
  buildSystemPrompt = (product, searchUrls, customInstructions) => {
    let prompt = `Sei un assistente AI per ${product === 'medicai' ? 'servizi sanitari' : 'servizi comunali'}.`;
    if (searchUrls && searchUrls.length > 0) {
      prompt += `\n\nInformazioni disponibili sui siti: ${searchUrls.join(', ')}`;
    }
    if (customInstructions) {
      prompt += `\n\nIstruzioni aggiuntive: ${customInstructions}`;
    }
    return prompt;
  };
}

// Load deep search engine
let deepSearchConfiguredSites;
try {
  const deepSearch = require('./deep-search-engine.js');
  deepSearchConfiguredSites = deepSearch.searchConfiguredSites;
} catch (e) {
  console.warn('Could not load deep-search-engine.js:', e.message);
  deepSearchConfiguredSites = async (query, urls) => `Deep search not available: ${e.message}`;
}

// Chat sessions storage
const chatSessions = new Map();

// Language detection
function detectLanguage(text) {
  const italianPatterns = /\b(il|lo|la|di|da|in|con|per|tra|frra|gli|sono|essere|avere|fare|volevo|possso|come|cosa|dove|quando|perché|grazie|buongiorno|buonasera|prego|scusi|perdoni|chiedere|rispondere|comunicare|informare|richiedere|ottenere|documento|certificato|ufficio|anagrafe|tributi|imposta|tassa|servizio|appuntamento|prenotazione)\b/i;
  const germanPatterns = /\b(der|die|das|ein|eine|und|oder|aber|nicht|sein|haben|werden|können|müssen|sollen|wollen|bitte|danke|guten|morgen|abend|herr|frau|ich|du|wir|sie|es|hat|ist|war|werden)\b/i;
  const frenchPatterns = /\b(le|la|les|un|une|du|des|et|ou|mais|ne|pas|être|avoir|pouvoir|vouloir|doit|falloir|savoir|merci|bonjour|bonsoir|madame|monsieur|je|tu|nous|vous|ils|elle|est|sont|était|été)\b/i;
  const arabicPatterns = /[\u0600-\u06FF]/;
  
  if (arabicPatterns.test(text)) return 'ar';
  if (italianPatterns.test(text)) return 'it';
  if (germanPatterns.test(text)) return 'de';
  if (frenchPatterns.test(text)) return 'fr';
  return 'en';
}

// Load demos
function loadDemos() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'demos.json'), 'utf8'));
  } catch {
    return [];
  }
}

// Filter history for API (exclude tool_calls)
function filterHistoryForAPI(history) {
  return history.filter(msg => {
    if (msg.role === 'assistant' && msg.tool_calls) {
      return false;
    }
    return true;
  });
}

// Define available tools for AI (without SMS/Email)
function getTools() {
  return [
    {
      type: "function",
      function: {
        name: "search_websites",
        description: "Search the web for up-to-date information.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" }
          },
          required: ["query"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_configured_sites",
        description: "Search specific configured websites for information.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
            configuredUrls: { type: "array", items: { type: "string" }, description: "List of URLs to search" }
          },
          required: ["query", "configuredUrls"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "text_to_speech",
        description: "Convert text to speech (TTS).",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to convert" },
            voice: { type: "string", enum: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] },
            speed: { type: "number" }
          },
          required: ["text"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "auto_compile_pdf",
        description: "Auto-compila moduli PDF italiani. Trigger: 'auto-compila il modulo', 'compilazione automatica PDF', 'compila il modulo'. Returns analysis + download link.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string", description: "PDF filename (for chat reference)" },
            sessionData: { type: "object", description: "User data from chat context for field filling" }
          },
          required: ["filename"]
        }
      }
    }
  ];

}

// Search configured sites wrapper
async function searchConfiguredSites(query, configuredUrls, product = 'comunicai', openai) {
  try {
    if (!configuredUrls || configuredUrls.length === 0) {
      return 'Nessun sito configurato per la ricerca.';
    }
    return await deepSearchConfiguredSites(query, configuredUrls, product, openai);
  } catch (err) {
    console.error('searchConfiguredSites error:', err.message);
    return `Non sono riuscito a cercare le informazioni richieste.`;
  }
}

// Search websites for general queries
async function searchWebsites(query, openai) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 800,
      messages: [
        { role: 'system', content: 'Sei un assistente informativo italiano. Rispondi in modo utile e preciso alla domanda dell\'utente usando la tua conoscenza generale. Rispondi sempre in italiano.' },
        { role: 'user', content: query }
      ]
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Web search error:', error.message);
    return 'Non sono riuscito a trovare informazioni.';
  }
}

// Text to speech - OpenAI TTS only
async function textToSpeech(text, voice = 'shimmer', speed = 0.9, openai) {
  try {
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1-hd',
      voice: voice || 'shimmer',
      input: text,
      speed: speed || 0.9
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    const base64 = buffer.toString('base64');
    return { success: true, audio: `data:audio/mpeg;base64,${base64}` };
  } catch (error) {
    console.error('OpenAI TTS error:', error.message);
    return { success: false, error: error.message };
  }
}

// Main chat function
async function handleChat(req, res, openai) {
  const { message, sessionId, demoId, product = 'comunicai' } = req.body;
  
  if (!message) {
    return res.status(400).json({ success: false, error: 'Message is required' });
  }

  // Check if OpenAI client is available
  if (!openai) {
    return res.status(503).json({ success: false, error: 'OpenAI client not available. Check API configuration.' });
  }

  console.log(`📬 Chat message:`, { demoId: demoId || '(none)', product, messageLength: message.length });

  // Get or create session
  const sid = sessionId || `session_${Date.now()}`;
  if (!chatSessions.has(sid)) {
    chatSessions.set(sid, []);
  }
  const sessionHistory = chatSessions.get(sid);

  // Get demo config if provided
  let searchUrls = [];
  let customInstructions = '';
  let demoProduct = product;
  
  if (demoId) {
    try {
      const demos = loadDemos();
      const demo = demos.find(d => d.id === demoId);
      if (demo) {
        searchUrls = demo.searchUrls || [];
        customInstructions = demo.instructions || '';
        demoProduct = demo.product || product;
        console.log(`✅ Demo loaded: ${demoId}`, { product: demoProduct, urlCount: searchUrls.length });
      }
    } catch (e) {
      console.error(`❌ Error loading demo: ${e.message}`);
    }
  }

  // Build system prompt
  let systemPrompt = buildSystemPrompt(demoProduct, searchUrls, customInstructions);
  
  if (demoId) {
    try {
      const demos = loadDemos();
      const demo = demos.find(d => d.id === demoId);
      if (demo && demo.instructions) {
        systemPrompt += "\n\n" + demo.instructions;
      }
    } catch (e) {}
  }

  // Add user message to history
  sessionHistory.push({ role: 'user', content: message });

  // Build messages for API
  const messagesForAPI = [
    { role: 'system', content: systemPrompt },
    ...filterHistoryForAPI(sessionHistory.slice(-10))
  ];

  // Select tools
  let availableTools = getTools();
  if (searchUrls && searchUrls.length > 0) {
    availableTools = getTools().filter(tool => tool.function.name !== 'search_websites');
  }

  try {
    // First call to OpenAI
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messagesForAPI,
      tools: availableTools,
    });

    const choice = response.choices[0];
    
    // Check if AI used a tool
    if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
      const toolCalls = choice.message.tool_calls;
      const toolResults = [];
      
      for (const toolCall of toolCalls) {
        const { function: fn } = toolCall;
        let result;
        
        try {
          const parsedArgs = JSON.parse(fn.arguments);
          
          switch (fn.name) {
            case 'search_configured_sites':
              const urlsToSearch = parsedArgs.configuredUrls && parsedArgs.configuredUrls.length > 0 
                ? parsedArgs.configuredUrls : searchUrls;
              result = await searchConfiguredSites(parsedArgs.query, urlsToSearch, demoProduct, openai);
              break;
            case 'search_websites':
              result = await searchWebsites(parsedArgs.query, openai);
              break;
            case 'text_to_speech':
              result = await textToSpeech(parsedArgs.text, parsedArgs.voice, parsedArgs.speed, openai);
              break;
            case 'auto_compile_pdf':
              const compiler = new UniversalPDFCompiler();
              result = {
                success: true,
                message: `PDF Compiler attivato! Carica il modulo PDF su /api/pdf/upload?sessionId=${sid} per analisi automatica e compilazione.\n\nCampi supportati: ${analysis ? analysis.fieldsSummary : 'Rilevati automaticamente'}`,
                uploadUrl: `/api/pdf/upload?sessionId=${sid}`,
                filename: parsedArgs.filename,
                status: 'ready_for_upload'
              };
              break;
            default:
              result = { error: 'Tool not implemented' };
          }
        } catch (parseError) {
          result = { error: 'Invalid arguments' };
        }
        
        toolResults.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          name: fn.name,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        });
      }
      
      // Second call with tool results
      const messagesForSecondCall = [...messagesForAPI, choice.message, ...toolResults];
      const finalResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messagesForSecondCall
      });
      
      const finalMessage = finalResponse.choices[0].message.content;
      sessionHistory.push({ role: 'assistant', content: finalMessage });

      return res.json({
        success: true,
        data: { response: finalMessage, sessionId: sid }
      });
    } else {
      // No tool used
      const responseText = choice.message.content;
      sessionHistory.push({ role: 'assistant', content: responseText });

      return res.json({
        success: true,
        data: { response: responseText, sessionId: sid }
      });
    }
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Errore nella comunicazione con il servizio AI' });
  }
}

// Clear chat session
function clearChatSession(sessionId) {
  if (sessionId && chatSessions.has(sessionId)) {
    chatSessions.delete(sessionId);
  }
}

module.exports = {
  chatSessions,
  handleChat,
  clearChatSession,
  textToSpeech
};

