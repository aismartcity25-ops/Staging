import { useState } from 'react';
import { formatMessage } from './formatMessage.js';
import {
  HeadsetIcon,
  VolumeIcon,
  StopIcon,
  CopyIcon,
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  FileTextIcon
} from './icons.jsx';

// Formatta "tipo · dimensione" per la card di un documento allegato (es. "PDF · 2.4 MB").
function formatAttachmentMeta(attachment) {
  const kindLabel = (attachment.mimeType || '').split('/')[1]?.toUpperCase() || 'FILE';
  const kb = attachment.size ? attachment.size / 1024 : 0;
  const sizeLabel = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
  return `${kindLabel} · ${sizeLabel}`;
}

// Allegato immagine/documento su un messaggio (utente o AI): anteprima
// inline per le immagini, card con bottone download per i documenti.
function Attachment({ attachment }) {
  if (!attachment) return null;

  if (attachment.kind === 'image') {
    return (
      <div className="chatbot__attachment chatbot__attachment--image">
        <img src={attachment.url} alt={attachment.name || 'Immagine allegata'} />
      </div>
    );
  }

  return (
    <div className="chatbot__attachment chatbot__attachment--document">
      <div className="chatbot__attachment-icon">
        <FileTextIcon />
      </div>
      <div className="chatbot__attachment-info">
        <div className="chatbot__attachment-title">{attachment.name}</div>
        <div className="chatbot__attachment-desc">{formatAttachmentMeta(attachment)}</div>
      </div>
      {attachment.url && (
        <a
          className="chatbot__attachment-download"
          href={attachment.url}
          download={attachment.name}
          title="Scarica"
          aria-label="Scarica"
        >
          <DownloadIcon />
        </a>
      )}
    </div>
  );
}

// Soglia oltre la quale una risposta AI viene troncata e resa collassabile.
const COLLAPSE_LENGTH = 320;

// Chip di citazione cliccabili → navigano l'iframe del sito nella demo (roadmap #1 H).
function Citations({ citations, onOpenCitation }) {
  if (!citations || !citations.length) return null;
  // La stessa fonte non deve mai comparire piu' di una volta tra le citazioni
  // (il backend gia' deduplica, questo e' solo un ulteriore livello di sicurezza).
  const uniqueCitations = Array.from(new Map(citations.map((c) => [c.url, c])).values());
  return (
    <div className="chatbot__citations">
      {uniqueCitations.map((c, i) => (
        <button
          key={i}
          className="chatbot__citation-chip"
          type="button"
          onClick={() => onOpenCitation && onOpenCitation(c.url)}
          title={c.url}
        >
          <span className="chatbot__citation-icon">🔗</span>
          <span className="chatbot__citation-text">{c.title || c.url}</span>
        </button>
      ))}
    </div>
  );
}

// Mini embed Google Maps quando l'utente chiede indicazioni per raggiungere un luogo.
function MapEmbed({ query }) {
  if (!query) return null;
  return (
    <div className="chatbot__map-embed">
      <iframe
        title={`Mappa: ${query}`}
        src={`https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
}

// Badge di confidence / graceful failure (roadmap #3 G).
function Confidence({ message }) {
  if (message.type !== 'ai') return null;
  if (!message.citations || message.citations.length === 0) return null;
  const verified = !message.lowConfidence;
  return (
    <div className={`chatbot__confidence ${verified ? 'verified' : 'indicative'}`}>
      {verified ? '✓ Fonti verificate' : 'ℹ️ Risposta indicativa — verifica con i contatti'}
    </div>
  );
}

function MessageBubbleContent({ message, onOpenCitation }) {
  const [expanded, setExpanded] = useState(false);
  const timeString = message.timestamp ? new Date(message.timestamp).toLocaleTimeString() : '';

  const rawContent = message.content || '';
  const isCollapsible = message.type === 'ai' && rawContent.length > COLLAPSE_LENGTH;
  const displayContent =
    isCollapsible && !expanded ? `${rawContent.slice(0, COLLAPSE_LENGTH).trimEnd()}…` : rawContent;

  return (
    <div className="chatbot__message-content">
      <Attachment attachment={message.attachment} />
      {displayContent && (
        // eslint-disable-next-line react/no-danger
        <p dangerouslySetInnerHTML={{ __html: formatMessage(displayContent) }} />
      )}
      {isCollapsible && (
        <button
          type="button"
          className="chatbot__collapse-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Mostra meno' : 'Mostra tutto'}
          <ChevronDownIcon size={14} className={`chatbot__collapse-icon ${expanded ? 'is-open' : ''}`} />
        </button>
      )}
      <div className="message-time">{timeString}</div>
      <Citations citations={message.citations} onOpenCitation={onOpenCitation} />
      <Confidence message={message} />
      <MapEmbed query={message.mapQuery} />
    </div>
  );
}

export default function Message({ message, onPlayAudio, onOpenCitation }) {
  const isUser = message.type === 'user';
  const [isPlaying, setIsPlaying] = useState(false);
  const [copied, setCopied] = useState(false);

  const handlePlayAudio = () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    setIsPlaying(true);
    if (onPlayAudio) onPlayAudio(message.content, () => setIsPlaying(false));
  };

  const handleCopy = (e) => {
    e.stopPropagation();
    const plain = message.content.replace(/<[^>]+>/g, '');
    navigator.clipboard?.writeText(plain).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`chatbot__message ${isUser ? 'chatbot__message--user' : 'chatbot__message--ai'}`}>
      {!isUser && (
        <div className="chatbot__message-icon">
          <div className="chatbot__icon chatbot__icon--gradient">
            <HeadsetIcon />
          </div>
        </div>
      )}
      <div className="chatbot__message-content-wrapper">
        {!isUser ? (
          <div className="chatbot__message-bubble-wrap">
            <div className={`chatbot__message-actions ${isPlaying || copied ? 'force-visible' : ''}`}>
              <button
                className={`chatbot__message-audio-btn ${isPlaying ? 'playing' : ''}`}
                onClick={handlePlayAudio}
                title={isPlaying ? 'Ferma audio' : 'Riproduci audio'}
              >
                {isPlaying ? <StopIcon /> : <VolumeIcon />}
              </button>
              <button
                className={`chatbot__copy-btn ${copied ? 'copied' : ''}`}
                onClick={handleCopy}
                title="Copia messaggio"
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                <span>{copied ? 'Copiato!' : 'Copia'}</span>
              </button>
            </div>
            <MessageBubbleContent message={message} onOpenCitation={onOpenCitation} />
          </div>
        ) : (
          <MessageBubbleContent message={message} onOpenCitation={onOpenCitation} />
        )}
      </div>
    </div>
  );
}

const STATUS_LABELS = {
  searching: 'Sto cercando le informazioni richieste…'
};

// statusPhase arriva dall'evento SSE `status` (vedi orchestrator.js): copre
// il gap silenzioso fra l'inizio della richiesta e la ripresa dello
// streaming vero e proprio (es. durante l'esecuzione di un tool di ricerca),
// cosi' l'utente vede un'indicazione invece dei soli puntini per diversi
// secondi e la risposta finale non sembra comparire tutta insieme.
export function TypingIndicator({ statusPhase } = {}) {
  const label = statusPhase && STATUS_LABELS[statusPhase];
  return (
    <div className="chatbot__message chatbot__message--ai">
      <div className="chatbot__message-icon">
        <div className="chatbot__icon chatbot__icon--gradient chatbot__icon--typing">
          <HeadsetIcon />
        </div>
      </div>
      <div className="chatbot__message-content">
        {label && <div className="chatbot__typing-status">{label}</div>}
        <div className="typing-indicator" role="status" aria-label={label || "L'assistente sta scrivendo"}>
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
  );
}
