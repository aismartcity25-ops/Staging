/**
 * Lightweight toast notifications, shared across config_*.html pages.
 * Requires toast.css and a <div id="toastContainer"> element on the page.
 */

function showToast(message, type = 'info', { duration } = {}) {
  const container = document.getElementById('toastContainer');
  if (!container) return null;

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;

  const icon = document.createElement('span');
  if (type === 'info') {
    icon.className = 'toast-spinner';
  } else {
    icon.className = 'toast-icon';
    icon.textContent = type === 'error' ? '⚠️' : '✅';
  }

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Chiudi');
  closeBtn.textContent = '×';
  closeBtn.onclick = () => dismissToast(el);

  el.appendChild(icon);
  el.appendChild(msg);
  el.appendChild(closeBtn);
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  // 'info' toasts represent an ongoing step (e.g. "verifica in corso") and
  // are meant to be dismissed explicitly by the caller once the outcome is
  // known, so they don't auto-dismiss unless a duration is passed in.
  const effectiveDuration = duration ?? (type === 'error' ? 8000 : type === 'success' ? 5000 : 0);
  if (effectiveDuration) {
    setTimeout(() => dismissToast(el), effectiveDuration);
  }
  return el;
}

function dismissToast(el) {
  if (!el || !el.isConnected) return;
  el.classList.remove('show');
  setTimeout(() => el.remove(), 250);
}

if (typeof window !== 'undefined') {
  window.showToast = showToast;
  window.dismissToast = dismissToast;
}
