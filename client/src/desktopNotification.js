/**
 * Desktop notification and audio alert helpers.
 *
 * Uses the standard Web Notification API supported in modern browsers
 * (Chrome, Edge, Firefox, Safari) along with the Web Audio API for a subtle chime.
 */

// Synthesize a subtle two-tone chime without external audio assets.
export function playNotificationChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.setValueAtTime(880.0, now + 0.1); // A5

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.36);
  } catch {
    // Audio context failed or blocked by autoplay policy
  }
}

export function isNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotificationPermission() {
  if (!isNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission() {
  if (!isNotificationSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Trigger a native desktop notification if permission is granted.
 */
export function showDesktopNotification({ title, body, ticketId, onClick }) {
  if (!isNotificationSupported() || Notification.permission !== 'granted') return null;

  try {
    const options = {
      body: body || 'TicketDesk alert',
      tag: ticketId ? `ticket-${ticketId}` : undefined,
      renotify: true,
    };

    const notif = new Notification(title, options);

    notif.onclick = () => {
      try {
        window.focus();
      } catch {}
      if (typeof onClick === 'function') {
        onClick();
      } else if (ticketId) {
        window.location.hash = `#/tickets/${ticketId}`;
      }
      notif.close();
    };

    return notif;
  } catch {
    return null;
  }
}
