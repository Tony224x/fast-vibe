let notificationPermissionAsked = false;

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

export function notifyTaskDone(label: string): void {
  showToast(`${label} ready`);

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
