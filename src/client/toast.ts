let notificationPermissionAsked = false;
let sharedAudioCtx: AudioContext | null = null;

export function showToast(message: string, duration = 3000): void {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function beep(): void {
  try {
    if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
    if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
    const osc = sharedAudioCtx.createOscillator();
    const gain = sharedAudioCtx.createGain();
    osc.connect(gain);
    gain.connect(sharedAudioCtx.destination);
    osc.frequency.value = 800;
    gain.gain.value = 0.1;
    osc.start();
    osc.stop(sharedAudioCtx.currentTime + 0.15);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  } catch {}
}

export function notifyTaskDone(label: string): void {
  showToast(`${label} ready`);
  beep();

  if (document.hidden && typeof Notification !== 'undefined') {
    if (!notificationPermissionAsked) {
      notificationPermissionAsked = true;
      Notification.requestPermission();
    }
    if (Notification.permission === 'granted') {
      new Notification('fast-vibe', { body: `${label} ready`, icon: '/favicon.ico' });
    }
  }
}
