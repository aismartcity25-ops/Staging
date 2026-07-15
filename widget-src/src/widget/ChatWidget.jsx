import { useEffect, useRef, useState } from 'react';
import { THEMES, FALLBACK_SUGGESTIONS, FALLBACK_WELCOME, resolveTheme, getParticleHue } from './themes.js';
import { Shard, Spark } from './particles.js';
import Message, { TypingIndicator } from './Message.jsx';
import { useResizableWindow } from './useResizableWindow.js';
import { extractMapQuery } from './formatMessage.js';
import {
  MessageCircle,
  XIcon,
  SendIcon,
  PaperclipIcon,
  ImageIcon,
  MicIcon,
  MicOffIcon,
  GripVerticalIcon,
  GripHorizontalIcon,
  LoaderIcon,
  FileTextIcon
} from './icons.jsx';

// Stato particelle condiviso a livello di modulo (stesso comportamento
// dell'originale: un'unica animazione canvas per lo shatter dell'orb).
let particles = [];
let animationFrameId = null;

/**
 * ChatBubbleWidget — bolla chat con effetto liquid glass, animazione
 * "shatter" all'apertura, finestra ridimensionabile, upload file/immagine,
 * input vocale (mock) e TTS.
 *
 * Props:
 * - product: 'comunicai' | 'medicai'
 * - demoId: id demo per caricare suggerimenti/welcome personalizzati dall'API
 * - colors: override colori custom { primary, secondary, userBg, userText, aiBg, aiText }
 * - apiEndpoint: endpoint per l'invio messaggi (default '/api/chat/message')
 */
export default function ChatWidget({ product = 'comunicai', demoId = '', colors = null, apiEndpoint = '/api/chat/message' }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [bubbleState, setBubbleState] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [windowOpening, setWindowOpening] = useState(false);
  const [windowClosing, setWindowClosing] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [, setWelcomeText] = useState('');
  const [, setSiteName] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState(null);
  const [attachmentError, setAttachmentError] = useState('');

  const { dimensions, windowRef, startResize } = useResizableWindow();

  const theme = resolveTheme(product, colors);

  const messagesEndRef = useRef(null);
  const canvasCtxRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const silenceRafRef = useRef(null);

  // Applica i colori custom come CSS variables.
  useEffect(() => {
    if (colors) {
      const root = document.documentElement;
      if (colors.userBg) root.style.setProperty('--cw-user-bg', colors.userBg);
      if (colors.userText) root.style.setProperty('--cw-user-text', colors.userText);
      if (colors.aiBg) root.style.setProperty('--cw-ai-bg', colors.aiBg);
      if (colors.aiText) root.style.setProperty('--cw-ai-text', colors.aiText);
    }
  }, [colors]);

  useEffect(() => {
    document.documentElement.setAttribute('data-product', product);
  }, [product]);

  // Canvas per le particelle dello shatter, posizionato sopra la bolla.
  useEffect(() => {
    let canvas = document.getElementById('particle-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'particle-canvas';
      canvas.style.cssText =
        'position:fixed;bottom:24px;right:24px;width:64px;height:64px;pointer-events:none;z-index:99998;';
      document.body.appendChild(canvas);
    }
    canvas.width = 64;
    canvas.height = 64;
    canvasCtxRef.current = canvas.getContext('2d');
  }, []);

  useEffect(() => {
    const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    setSessionId(newSessionId);

    const fallbackWelcome = FALLBACK_WELCOME[product] || FALLBACK_WELCOME.comunicai;
    setWelcomeText(fallbackWelcome);
    setMessages([{ id: '1', type: 'ai', content: fallbackWelcome, timestamp: new Date() }]);

    // Carica i suggerimenti reali della demo, se disponibile un demoId.
    if (demoId) {
      fetch(`/api/demos/${demoId}/suggestions`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data) return;
          if (data.welcome) {
            setWelcomeText(data.welcome);
            setMessages([{ id: '1', type: 'ai', content: data.welcome, timestamp: new Date() }]);
          }
          if (Array.isArray(data.questions) && data.questions.length) setSuggestions(data.questions);
          if (data.siteName) setSiteName(data.siteName);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, demoId]);

  // Naviga l'iframe del sito nella demo verso la fonte citata.
  const openCitation = (url) => {
    if (!url) return;
    const frame = document.getElementById('siteFrame');
    if (frame) frame.src = url;
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const renderParticles = () => {
    const ctx = canvasCtxRef.current;
    if (!ctx || particles.length === 0) {
      animationFrameId = null;
      return;
    }
    ctx.clearRect(0, 0, 64, 64);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (p instanceof Shard && p.pullBack && p.pullTarget) {
        const dx = p.pullTarget.x - p.x;
        const dy = p.pullTarget.y - p.y;
        p.vx += dx * p.pullStrength;
        p.vy += dy * p.pullStrength;
        p.vx *= 0.88;
        p.vy *= 0.88;
      }
      p.update();
      p.draw(ctx);
      if (!p.alive) particles.splice(i, 1);
    }
    if (particles.length > 0) {
      animationFrameId = requestAnimationFrame(renderParticles);
    } else {
      animationFrameId = null;
      ctx.clearRect(0, 0, 64, 64);
    }
  };

  const toggleChat = () => {
    if (!isOpen) {
      setBubbleState('shatter');
      const cx = 32;
      const cy = 32;
      const hue = getParticleHue(product, colors);
      for (let i = 0; i < 38; i++) particles.push(new Shard(cx, cy, hue));
      for (let i = 0; i < 55; i++) particles.push(new Spark(cx, cy, hue));
      if (!animationFrameId) renderParticles();
      setTimeout(() => {
        particles.forEach((p) => {
          if (p instanceof Shard) {
            p.pullBack = true;
            p.pullTarget = { x: cx, y: cy };
            p.pullStrength = 0.04 + Math.random() * 0.03;
          }
        });
      }, 1500);
      setTimeout(() => {
        setIsOpen(true);
        setWindowOpening(true);
        setBubbleState('reassemble');
        setTimeout(() => {
          setWindowOpening(false);
          setBubbleState('');
          particles = [];
        }, 600);
      }, 800);
    } else {
      setWindowClosing(true);
      setTimeout(() => {
        setIsOpen(false);
        setWindowClosing(false);
      }, 320);
    }
  };

  const suggestionsFollowUp = FALLBACK_SUGGESTIONS[product] || FALLBACK_SUGGESTIONS.comunicai;
  // Preferisce i suggerimenti reali della demo, altrimenti quelli di fallback per prodotto.
  const chipSuggestions = suggestions.length ? suggestions : suggestionsFollowUp;

  // Invia un messaggio (con eventuale allegato gia' caricato) e riceve la
  // risposta AI in streaming (SSE): un messaggio AI vuoto viene aggiunto
  // subito e riempito progressivamente man mano che arrivano i chunk di
  // testo, poi completato con citazioni/confidence/attachment nell'evento
  // finale. Condivisa da handleSubmit e handleFileUpload.
  const sendMessage = async (messageText, attachment) => {
    setIsLoading(true);
    const aiMessageId = `ai_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: aiMessageId, type: 'ai', content: '', timestamp: new Date(), streaming: true }
    ]);

    let fullText = '';

    try {
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageText, sessionId, demoId, attachment })
      });

      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.includes('text/event-stream') || !response.body) {
        const errJson = await response.json().catch(() => null);
        throw new Error(errJson?.error || 'Errore di rete');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let meta = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const line = rawEvent.replace(/^data:\s*/, '');
          if (!line) continue;

          const event = JSON.parse(line);
          if (event.type === 'chunk') {
            fullText += event.text;
            setMessages((prev) => prev.map((m) => (m.id === aiMessageId ? { ...m, content: fullText } : m)));
          } else if (event.type === 'done') {
            meta = event;
          } else if (event.type === 'error') {
            throw new Error(event.error || 'Errore nella risposta AI');
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMessageId
            ? {
                ...m,
                content: fullText,
                streaming: false,
                citations: meta?.citations || [],
                confidence: typeof meta?.confidence === 'number' ? meta.confidence : undefined,
                lowConfidence: !!meta?.lowConfidence,
                attachment: meta?.attachment || null,
                mapQuery: extractMapQuery(messageText, fullText)
              }
            : m
        )
      );
    } catch (error) {
      console.error('Error:', error);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMessageId
            ? { ...m, content: '❌ Mi dispiace, si è verificato un errore. Riprova più tardi.', streaming: false }
            : m
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (text) => {
    const messageText = text || input;
    if ((!messageText.trim() && !pendingAttachment) || isLoading) return;
    if (pendingAttachment?.uploading) return;

    if (showSuggestions) setShowSuggestions(false);

    const attachment = pendingAttachment;
    const userMessage = { id: Date.now().toString(), type: 'user', content: messageText, timestamp: new Date(), attachment };

    setInput('');
    setPendingAttachment(null);
    setMessages((prev) => [...prev, userMessage]);
    await sendMessage(messageText, attachment);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Carica il file scelto e lo tiene "in sospeso" vicino alla barra di testo:
  // l'invio effettivo avviene solo quando l'utente preme invio/send, cosi'
  // puo' aggiungere un messaggio di testo prima di spedire l'allegato.
  const handleFileUpload = async (e, type) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || isLoading) return;

    setAttachmentError('');
    const localPreviewUrl = type === 'image' ? URL.createObjectURL(file) : null;
    setPendingAttachment({
      name: file.name,
      size: file.size,
      mimeType: file.type,
      kind: type,
      url: localPreviewUrl,
      uploading: true
    });

    try {
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await fetch('/api/chat/upload', { method: 'POST', body: formData });
      const uploadResult = await uploadRes.json();

      if (!uploadResult.success) throw new Error(uploadResult.error || 'Upload error');

      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
      setPendingAttachment({ ...uploadResult.data, uploading: false });
    } catch (error) {
      console.error('Upload error:', error);
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
      setPendingAttachment(null);
      setAttachmentError('Non sono riuscito a caricare il file. Riprova.');
    }
  };

  const removePendingAttachment = () => {
    if (pendingAttachment?.url) URL.revokeObjectURL(pendingAttachment.url);
    setPendingAttachment(null);
    setAttachmentError('');
  };

  // Ferma la registrazione e rilascia il microfono (traccia audio).
  const stopVoiceInput = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  // Silenzio (RMS del segnale sotto soglia) per SILENCE_DURATION_MS di
  // seguito → ferma automaticamente la registrazione, senza bisogno che
  // l'utente clicchi una seconda volta: se non parla affatto entro questo
  // intervallo dal click iniziale, oppure smette di parlare dopo aver
  // detto qualcosa, la registrazione si interrompe da sola e parte la
  // trascrizione.
  const SILENCE_THRESHOLD = 0.02;
  const SILENCE_DURATION_MS = 2500;

  const startSilenceDetection = (stream) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return; // browser senza Web Audio API: solo stop manuale
    const audioContext = new AudioContextClass();
    audioContextRef.current = audioContext;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.fftSize);

    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(stopVoiceInput, SILENCE_DURATION_MS);
    };

    const monitorVolume = () => {
      analyser.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / dataArray.length);
      if (rms > SILENCE_THRESHOLD) resetSilenceTimer();
      silenceRafRef.current = requestAnimationFrame(monitorVolume);
    };

    resetSilenceTimer(); // timer attivo da subito: se non parla per niente, si ferma comunque dopo SILENCE_DURATION_MS
    monitorVolume();
  };

  const stopSilenceDetection = () => {
    if (silenceRafRef.current) cancelAnimationFrame(silenceRafRef.current);
    silenceRafRef.current = null;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
  };

  const startVoiceInput = async () => {
    setAttachmentError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      startSilenceDetection(stream);
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stopSilenceDetection();
        audioStreamRef.current?.getTracks().forEach((track) => track.stop());
        audioStreamRef.current = null;
        setIsRecording(false);

        const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        audioChunksRef.current = [];
        if (audioBlob.size === 0) return;

        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append('audio', audioBlob, 'voice-input.webm');
          const res = await fetch('/api/chat/stt', { method: 'POST', body: formData });
          const result = await res.json();
          if (!result.success || !result.data?.text) throw new Error(result.error || 'Trascrizione non riuscita');
          setInput((prev) => (prev ? `${prev} ${result.data.text}` : result.data.text));
        } catch (error) {
          console.error('STT error:', error);
          setAttachmentError('Non sono riuscito a trascrivere l\'audio. Riprova.');
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error('getUserMedia error:', error);
      setAttachmentError(
        error?.name === 'NotAllowedError'
          ? 'Permesso al microfono negato. Abilitalo dalle impostazioni del browser per usare l\'input vocale.'
          : 'Non sono riuscito ad accedere al microfono.'
      );
    }
  };

  const toggleVoiceInput = () => {
    if (isRecording) {
      stopVoiceInput();
    } else {
      startVoiceInput();
    }
  };

  const handlePlayAudio = async (text, onComplete) => {
    try {
      const response = await fetch('/api/chat/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: 'nova', speed: 0.8 })
      });

      const result = await response.json();

      if (result.success && result.data?.audio) {
        const audio = new Audio(result.data.audio);
        audio.onended = () => onComplete && onComplete();
        audio.onerror = () => onComplete && onComplete();
        audio.play();
      } else if (onComplete) {
        onComplete();
      }
    } catch (error) {
      console.error('TTS error:', error);
      if (onComplete) onComplete();
    }
  };

  return (
    <>
      <button
        className={`chatbot-bubble-button ${bubbleState}`}
        onClick={toggleChat}
        style={{ '--cw-glow': theme.glowColor, '--cw-glow-alt': theme.glowColorAlt }}
      >
        <div className="bubble-inner">{isOpen ? <XIcon /> : <MessageCircle />}</div>
        {bubbleState === 'shatter' && (
          <>
            <div className="chatbot-bubble-shockwave wave1" />
            <div className="chatbot-bubble-shockwave wave2" />
            <div className="chatbot-bubble-shockwave wave3" />
          </>
        )}
        <div className={`chatbot-bubble-flash ${bubbleState === 'shatter' ? 'active' : ''}`} />
        <div className={`chatbot-bubble-reform-ring ${bubbleState === 'reassemble' ? 'active' : ''}`} />
      </button>

      {isOpen && (
        <div
          className={`chatbot-bubble-window${windowOpening ? ' window--opening' : ''}${
            windowClosing ? ' window--closing' : ''
          }`}
          ref={windowRef}
          style={{ width: dimensions.width, height: dimensions.height }}
        >
          <div className="resize-handle resize-handle-n" onMouseDown={(e) => startResize(e, 'n')}>
            <GripVerticalIcon />
          </div>
          <div className="resize-handle resize-handle-s" onMouseDown={(e) => startResize(e, 's')}>
            <GripVerticalIcon />
          </div>
          <div className="resize-handle resize-handle-e" onMouseDown={(e) => startResize(e, 'e')}>
            <GripHorizontalIcon />
          </div>
          <div className="resize-handle resize-handle-w" onMouseDown={(e) => startResize(e, 'w')}>
            <GripHorizontalIcon />
          </div>
          <div className="resize-handle resize-handle-ne" onMouseDown={(e) => startResize(e, 'ne')}>
            <GripVerticalIcon size={12} />
          </div>
          <div className="resize-handle resize-handle-nw" onMouseDown={(e) => startResize(e, 'nw')}>
            <GripVerticalIcon size={12} />
          </div>
          <div className="resize-handle resize-handle-se" onMouseDown={(e) => startResize(e, 'se')}>
            <GripVerticalIcon size={12} />
          </div>
          <div className="resize-handle resize-handle-sw" onMouseDown={(e) => startResize(e, 'sw')}>
            <GripVerticalIcon size={12} />
          </div>

          <div className="chatbot-bubble-header">
            <div className="chatbot-bubble-header-icon">
              <img src={theme.logo} alt={theme.name} />
            </div>
            <span className="chatbot-bubble-header-title">Assistente {theme.name}</span>
          </div>

          <div className="chatbot-bubble-messages">
            {messages.map((msg) =>
              msg.streaming && !msg.content ? (
                <TypingIndicator key={msg.id} />
              ) : (
                <Message key={msg.id} message={msg} onPlayAudio={handlePlayAudio} onOpenCitation={openCitation} />
              )
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="chatbot-bubble-input">
            {pendingAttachment && (
              <div className="chatbot-bubble-pending-attachment">
                {pendingAttachment.kind === 'image' ? (
                  <img
                    src={pendingAttachment.url}
                    alt={pendingAttachment.name}
                    className="chatbot-bubble-pending-attachment-thumb"
                  />
                ) : (
                  <div className="chatbot-bubble-pending-attachment-icon">
                    <FileTextIcon />
                  </div>
                )}
                <span className="chatbot-bubble-pending-attachment-name">{pendingAttachment.name}</span>
                {pendingAttachment.uploading && <LoaderIcon className="chatbot__spin" size={14} />}
                <button
                  type="button"
                  className="chatbot-bubble-pending-attachment-remove"
                  onClick={removePendingAttachment}
                  title="Rimuovi allegato"
                  aria-label="Rimuovi allegato"
                >
                  <XIcon size={14} />
                </button>
              </div>
            )}
            {attachmentError && <div className="chatbot-bubble-attachment-error">{attachmentError}</div>}
            {showSuggestions && messages.length > 0 && (
              <div className="chatbot-bubble-suggestions">
                {chipSuggestions.map((suggestion, i) => (
                  <button
                    key={i}
                    className="chatbot-bubble-suggestion chip-animate"
                    type="button"
                    disabled={isLoading}
                    onClick={() => handleSubmit(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
            <div className="chatbot-bubble-input-row">
              <button
                className="chatbot-bubble-input-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || !!pendingAttachment}
                title="Carica documento"
              >
                <PaperclipIcon />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.doc,.docx,.txt,.xls,.xlsx,.ppt,.pptx"
                style={{ display: 'none' }}
                onChange={(e) => handleFileUpload(e, 'document')}
              />
              <button
                className="chatbot-bubble-input-btn"
                onClick={() => imageInputRef.current?.click()}
                disabled={isLoading || !!pendingAttachment}
                title="Carica immagine"
              >
                <ImageIcon />
              </button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => handleFileUpload(e, 'image')}
              />
              <input
                type="text"
                className="chatbot-bubble-text-input"
                placeholder="Scrivi un messaggio..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
              />
              <button
                className={`chatbot-bubble-input-btn ${isRecording ? 'chatbot-bubble-input-btn--recording' : ''}`}
                onClick={toggleVoiceInput}
                disabled={isLoading || isTranscribing}
                title={isTranscribing ? 'Trascrizione in corso…' : (isRecording ? 'Ferma registrazione' : 'Registra messaggio vocale')}
              >
                {isTranscribing ? <LoaderIcon className="chatbot__spin" /> : (isRecording ? <MicOffIcon /> : <MicIcon />)}
              </button>
              <button
                className="chatbot-bubble-send"
                onClick={() => handleSubmit()}
                disabled={(!input.trim() && !pendingAttachment) || isLoading || pendingAttachment?.uploading}
                title={isLoading ? 'Invio in corso…' : 'Invia messaggio'}
              >
                {isLoading ? <LoaderIcon className="chatbot__spin" /> : <SendIcon />}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Riferimento ai temi disponibili, utile per selettori esterni (es. demo/App.jsx).
export { THEMES };
