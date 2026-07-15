// Enhanced Voice Interface System
// Speech-to-Text and Text-to-Speech integration for DEMO Platform
// Using OpenAI TTS only

const OpenAI = require('openai');

class VoiceInterface {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this.isProcessing = false;
    this.openai = null;
    
    // Voice configuration
    this.voiceConfig = {
      openai: {
        voice: 'alloy',
        model: 'tts-1-hd',
        speed: 1.0
      }
    };
    
    // Voice commands
    this.voiceCommands = {
      'stop ascolto': 'stop_listening',
      'ferma microfono': 'stop_listening',
      'inizia ascolto': 'start_listening',
      'attiva microfono': 'start_listening',
      'aiuto': 'show_help',
      'help': 'show_help',
      'ripeti': 'repeat_last',
      'cancella': 'clear_chat',
      'reset': 'reset_session'
    };
    
    this.initTTS();
  }

  async initTTS() {
    try {
      // Initialize OpenAI TTS
      if (process.env.OPENAI_API_KEY) {
        this.openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });
        console.log('✅ OpenAI TTS initialized');
      }
      
      console.log('🔊 Voice Interface initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize TTS:', error);
    }
  }

  async initialize() {
    try {
      // Initialize Speech Recognition
      if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
        this.recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        this.recognition.lang = 'it-IT';
        this.recognition.interimResults = false;
        this.recognition.maxAlternatives = 1;
        
        // Event handlers
        this.recognition.onstart = () => {
          this.isListening = true;
          this.onVoiceEvent('start');
        };
        
        this.recognition.onend = () => {
          this.isListening = false;
          this.onVoiceEvent('end');
        };
        
        this.recognition.onresult = (event) => {
          const transcript = event.results[0][0].transcript;
          this.onVoiceEvent('result', transcript);
        };
        
        this.recognition.onerror = (event) => {
          this.onVoiceEvent('error', event.error);
        };
        
        console.log('✅ Speech Recognition initialized');
        return true;
      } else {
        console.warn('⚠️ Speech Recognition not supported in this browser');
        return false;
      }
    } catch (error) {
      console.error('❌ Failed to initialize Voice Interface:', error);
      return false;
    }
  }

  startListening() {
    if (!this.recognition) {
      throw new Error('Speech Recognition not initialized');
    }
    
    if (this.isProcessing) {
      console.warn('⚠️ Already processing voice input');
      return false;
    }
    
    try {
      this.isProcessing = true;
      this.recognition.start();
      return true;
    } catch (error) {
      console.error('❌ Failed to start listening:', error);
      this.isProcessing = false;
      return false;
    }
  }

  stopListening() {
    if (this.recognition && this.isListening) {
      try {
        this.recognition.stop();
        this.isProcessing = false;
        return true;
      } catch (error) {
        console.error('❌ Failed to stop listening:', error);
        return false;
      }
    }
    return false;
  }

  async processVoiceInput(audioData) {
    try {
      // Process audio data (placeholder for actual STT processing)
      // In a real implementation, this would send audio to STT service
      
      const transcript = await this.transcribeAudio(audioData);
      const processedText = this.processVoiceCommand(transcript);
      
      return {
        success: true,
        transcript: transcript,
        processedText: processedText,
        isCommand: this.isVoiceCommand(transcript)
      };
    } catch (error) {
      console.error('❌ Error processing voice input:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async transcribeAudio(audioData) {
    // Placeholder for actual STT implementation
    // This would integrate with OpenAI Whisper or similar service
    
    if (this.openai) {
      // OpenAI Whisper integration would go here
      return "Transcription placeholder";
    } else {
      // Fallback to browser STT
      return new Promise((resolve) => {
        // Browser STT is handled by the recognition.onresult event
        resolve("Browser transcription");
      });
    }
  }

  processVoiceCommand(text) {
    const textLower = text.toLowerCase().trim();
    
    // Check for voice commands
    for (const [command, action] of Object.entries(this.voiceCommands)) {
      if (textLower.includes(command)) {
        return this.executeVoiceCommand(action, text);
      }
    }
    
    return text;
  }

  isVoiceCommand(text) {
    const textLower = text.toLowerCase().trim();
    return Object.keys(this.voiceCommands).some(command => textLower.includes(command));
  }

  executeVoiceCommand(action, originalText) {
    switch (action) {
      case 'stop_listening':
        this.stopListening();
        return "Ascolto interrotto";
      case 'start_listening':
        this.startListening();
        return "Ascolto attivato";
      case 'show_help':
        return this.getVoiceHelp();
      case 'repeat_last':
        return "Ripetere l'ultimo messaggio";
      case 'clear_chat':
        return "Cancellare la chat";
      case 'reset_session':
        return "Resetta sessione";
      default:
        return originalText;
    }
  }

  getVoiceHelp() {
    return `
      Comandi vocali disponibili:
      - "Inizia ascolto" o "Attiva microfono" - Avvia il riconoscimento vocale
      - "Ferma ascolto" o "Ferma microfono" - Interrompe il riconoscimento vocale
      - "Aiuto" - Mostra questa guida
      - "Ripeti" - Ripete l'ultimo messaggio
      - "Cancella" - Cancella la chat
      - "Reset" - Resetta la sessione
      
      Per parlare con il chatbot, attiva il microfono e pronuncia chiaramente la tua richiesta.
    `;
  }

  async textToSpeech(text, options = {}) {
    try {
      const config = { ...this.voiceConfig.openai, ...options };
      
      if (this.openai) {
        // Use OpenAI TTS
        const mp3 = await this.openai.audio.speech.create({
          model: config.model || 'tts-1-hd',
          voice: config.voice || 'alloy',
          input: text,
          speed: config.speed || 1.0
        });
        
        // Convert to base64
        const buffer = Buffer.from(await mp3.arrayBuffer());
        const base64 = buffer.toString('base64');
        
        return {
          success: true,
          audio: `data:audio/mpeg;base64,${base64}`,
          duration: this.estimateAudioDuration(text, config.speed),
          provider: 'openai'
        };
      } else {
        throw new Error('No TTS provider available');
      }
    } catch (error) {
      console.error('❌ TTS error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  estimateAudioDuration(text, speakingRate = 1.0) {
    // Rough estimation: 150 words per minute
    const words = text.split(' ').length;
    const baseDuration = (words / 150) * 60; // seconds
    return Math.max(baseDuration / speakingRate, 1); // minimum 1 second
  }

  async generateVoiceResponse(text, userContext = {}) {
    try {
      // Analyze text for voice characteristics
      const voiceAnalysis = this.analyzeVoiceCharacteristics(text, userContext);
      
      // Generate speech
      const speechResult = await this.textToSpeech(text, voiceAnalysis);
      
      if (speechResult.success) {
        return {
          success: true,
          audio: speechResult.audio,
          duration: speechResult.duration,
          provider: speechResult.provider,
          text: text,
          voiceCharacteristics: voiceAnalysis
        };
      } else {
        throw new Error(speechResult.error);
      }
    } catch (error) {
      console.error('❌ Error generating voice response:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  analyzeVoiceCharacteristics(text, userContext) {
    const config = { ...this.voiceConfig.openai };
    
    // Adjust voice based on context
    if (userContext.accessibility && userContext.accessibility.voiceOutput) {
      config.speed = 0.8; // Slower for accessibility
    }
    
    // Adjust based on urgency
    if (userContext.urgency === 'high') {
      config.speed = 1.2; // Faster for urgent responses
    }
    
    // Adjust based on sentiment
    if (userContext.sentiment === 'negative') {
      config.pitch = -2; // Soothing tone
    }
    
    return config;
  }

  // Event handlers
  onVoiceEvent(eventType, data = null) {
    // This would be connected to the frontend
    // For now, we'll log events
    console.log(`🎤 Voice Event: ${eventType}`, data);
    
    // Emit events for frontend
    if (window && window.dispatchEvent) {
      const event = new CustomEvent('voiceEvent', {
        detail: { type: eventType, data: data }
      });
      window.dispatchEvent(event);
    }
  }

  // Voice quality assessment
  assessVoiceQuality(audioData) {
    // Placeholder for voice quality analysis
    // Would analyze clarity, volume, background noise, etc.
    return {
      clarity: 0.8,
      volume: 0.7,
      backgroundNoise: 0.3,
      overallQuality: 0.75
    };
  }

  // Voice training and adaptation
  adaptToUserVoice(userId, voiceSamples) {
    // Placeholder for voice adaptation
    // Would learn user's speech patterns, accent, speed, etc.
    console.log(`🔊 Adapting to user ${userId} voice patterns`);
    return {
      success: true,
      adaptationLevel: 0.8
    };
  }

  // Accessibility features
  getAccessibilityFeatures() {
    return {
      slowSpeech: {
        description: 'Parla più lentamente per utenti con difficoltà di comprensione',
        speed: 0.8
      },
      clearSpeech: {
        description: 'Pronuncia più chiaramente per utenti con problemi udittivi',
        clarity: 'enhanced'
      },
      visualFeedback: {
        description: 'Mostra trascrizione testuale mentre si parla',
        showTranscription: true
      },
      confirmationMode: {
        description: 'Richiede conferma per azioni importanti',
        requireConfirmation: true
      }
    };
  }

  // Voice command validation
  validateVoiceCommand(command) {
    const validCommands = Object.keys(this.voiceCommands);
    const commandLower = command.toLowerCase().trim();
    
    // Find closest match
    let bestMatch = null;
    let bestScore = 0;
    
    for (const validCommand of validCommands) {
      const score = this.calculateSimilarity(commandLower, validCommand);
      if (score > bestScore && score > 0.7) {
        bestScore = score;
        bestMatch = validCommand;
      }
    }
    
    return {
      isValid: bestMatch !== null,
      matchedCommand: bestMatch,
      confidence: bestScore,
      suggestions: bestScore < 1.0 ? validCommands.slice(0, 3) : []
    };
  }

  calculateSimilarity(str1, str2) {
    // Simple similarity calculation
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const longerSet = new Set(longer.split(''));
    const shorterSet = new Set(shorter.split(''));
    
    let intersection = 0;
    for (const char of longerSet) {
      if (shorterSet.has(char)) {
        intersection++;
      }
    }
    
    return intersection / longerSet.size;
  }

  // Cleanup
  cleanup() {
    if (this.recognition) {
      this.recognition.stop();
      this.recognition = null;
    }
    this.isListening = false;
    this.isProcessing = false;
  }
}

module.exports = { VoiceInterface };