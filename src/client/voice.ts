// Voice capture via MediaRecorder + faster-whisper sidecar.
//
// Architecture :
//   browser MediaRecorder (webm/opus) ──► POST /api/transcribe ──►
//   server proxies to ──► python scripts/whisper_sidecar.py ──►
//   transcript JSON ──► insert in compose textarea.
//
// On a abandonné l'ancien Web Speech API (Chrome ⇄ Google Cloud) à cause
// de drops réseau persistants (proxy, VPN, hiccups Google). MediaRecorder
// est universel et 100% local : l'audio ne sort pas de la machine.
//
// UX :
//   - Push-to-talk : maintenir Ctrl+Espace pendant qu'on parle, relâcher.
//   - Toggle : clic sur le bouton mic dans la popover compose.
//   - One-shot : le transcript apparaît dans la textarea APRÈS le release
//     (pas de transcript temps réel comme Web Speech). En pratique on a
//     ~1s de latence après le release sur un small whisper warmé.

import { focusedIndex, launched, terminals } from './state';
import { showToast } from './toast';
import { terminalKinds } from './state';

const TRANSCRIBE_URL = '/api/transcribe';
const HOTKEY_CODE = 'Space'; // Ctrl+Space
// Mime preference : webm/opus en premier (Chrome, Edge, Firefox récent),
// puis mp4 (Safari) puis ogg (fallback). MediaRecorder.isTypeSupported
// pick le 1er supporté.
const MIME_PREFERRED = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];
const VOICE_LANG = 'fr';
// Blob plus petit que ça = trop court (clic mort), on n'envoie pas.
const MIN_BLOB_BYTES = 2048;

let recording = false;
let targetIdx = -1;
let hotkeyHeld = false;
let supported = false;
let badge: HTMLElement | null = null;
let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let mimeUsed = '';
let pendingTranscription = false;
// Cached résultat du check pré-flight (HTTPS ou localhost requis par
// getUserMedia pour accéder au micro). Calculé une fois au init.
let preflightWarning: string | null = null;

function ensureBadge(): HTMLElement {
  if (badge) return badge;
  badge = document.createElement('div');
  badge.id = 'voice-badge';
  badge.className = 'voice-badge hidden';
  badge.innerHTML = '<span class="voice-dot"></span><span class="voice-label">Écoute…</span>';
  document.body.appendChild(badge);
  return badge;
}

function setBadge(active: boolean, label?: string): void {
  const b = ensureBadge();
  b.classList.toggle('hidden', !active);
  b.classList.toggle('recording', active);
  if (label) {
    const lbl = b.querySelector('.voice-label');
    if (lbl) lbl.textContent = label;
  }
}

function setTextareaListening(idx: number, active: boolean): void {
  document.querySelectorAll('.pane-compose-popover.voice-listening')
    .forEach((el) => el.classList.remove('voice-listening'));
  if (active && idx >= 0) {
    const wrapper = document.querySelector(`[data-compose-popover="${idx}"]`) as HTMLElement | null;
    if (wrapper) wrapper.classList.add('voice-listening');
  }
}

function setMicButtonsActive(active: boolean, idx: number): void {
  document.querySelectorAll('.compose-btn-voice').forEach((el) => {
    const btn = el as HTMLButtonElement;
    const btnIdx = parseInt(btn.dataset.index || '-1', 10);
    btn.classList.toggle('recording', active && btnIdx === idx);
    btn.setAttribute('aria-pressed', String(active && btnIdx === idx));
  });
}

function ensureComposeOpen(idx: number): HTMLTextAreaElement | null {
  const wrapper = document.querySelector(`[data-compose-popover="${idx}"]`) as HTMLElement | null;
  if (!wrapper) return null;
  wrapper.classList.remove('hidden');
  const ta = wrapper.querySelector('.compose-textarea') as HTMLTextAreaElement | null;
  return ta;
}

function paneCanCompose(idx: number): boolean {
  const kind = terminalKinds[idx];
  return kind !== 'docker-logs' && kind !== 'docker-rebuild';
}

function pickTargetIdx(): number {
  if (focusedIndex >= 0 && terminals[focusedIndex] && paneCanCompose(focusedIndex)) return focusedIndex;
  for (let i = 0; i < terminals.length; i++) {
    if (terminals[i] && paneCanCompose(i)) return i;
  }
  return -1;
}

// getUserMedia (et donc MediaRecorder) exige HTTPS sauf sur localhost.
// Si l'user accède via IP LAN (192.168.x.x), c'est un refus silencieux.
function checkPreflight(): string | null {
  const proto = window.location.protocol;
  const host = window.location.hostname;
  if (proto === 'https:') return null;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
  return (
    `Voice désactivé : MediaRecorder requiert HTTPS ou localhost. ` +
    `Tu es sur ${proto}//${host} → accède via http://localhost:3333 ` +
    `depuis cette même machine.`
  );
}

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_PREFERRED) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* throws on some browsers */ }
  }
  return '';
}

async function getStream(): Promise<MediaStream> {
  if (mediaStream && mediaStream.active) return mediaStream;
  // Conserver le stream entre sessions évite de re-prompter l'user à chaque
  // fois et de re-allumer le indicateur micro du browser.
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    } as MediaTrackConstraints,
    video: false,
  });
  return mediaStream;
}

export function isVoiceRecording(): boolean { return recording; }

export async function startVoiceCapture(idx?: number): Promise<void> {
  if (!supported) {
    showToast('Voice indisponible — navigateur sans MediaRecorder');
    return;
  }
  if (preflightWarning) {
    showToast(preflightWarning);
    return;
  }
  if (recording || pendingTranscription) return;
  if (!launched) {
    showToast('Lance une session avant de dicter');
    return;
  }
  const t = (typeof idx === 'number' && idx >= 0) ? idx : pickTargetIdx();
  if (t < 0) {
    showToast('Aucun pane disponible pour la dictée');
    return;
  }
  if (!paneCanCompose(t)) {
    showToast('Ce pane ne supporte pas la compose (Docker)');
    return;
  }
  const ta = ensureComposeOpen(t);
  if (!ta) {
    showToast('Compose introuvable');
    return;
  }
  targetIdx = t;
  ta.focus();

  let stream: MediaStream;
  try {
    stream = await getStream();
  } catch (e: unknown) {
    const err = e as Error;
    if (err.name === 'NotAllowedError') {
      showToast('Micro refusé — autorise l’accès dans le navigateur');
    } else if (err.name === 'NotFoundError') {
      showToast('Aucun micro détecté');
    } else {
      showToast(`Micro inaccessible : ${err.message}`);
    }
    return;
  }

  mimeUsed = pickMime();
  try {
    mediaRecorder = new MediaRecorder(stream, mimeUsed ? { mimeType: mimeUsed } : undefined);
  } catch (e: unknown) {
    showToast(`MediaRecorder error : ${(e as Error).message}`);
    return;
  }
  audioChunks = [];
  mediaRecorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = () => { void onRecorderStop(); };
  mediaRecorder.onerror = (e: Event) => {
    const err = (e as unknown as { error?: { name?: string; message?: string } }).error;
    showToast(`Recorder error : ${err?.name || 'unknown'}`);
    cleanupAfterRecord();
  };

  try {
    mediaRecorder.start();
  } catch (e: unknown) {
    showToast(`start() failed : ${(e as Error).message}`);
    return;
  }
  recording = true;
  setBadge(true, 'Écoute…');
  setMicButtonsActive(true, targetIdx);
  setTextareaListening(targetIdx, true);
}

export function stopVoiceCapture(): void {
  if (!recording || !mediaRecorder) return;
  try { mediaRecorder.stop(); } catch { /* already stopped */ }
}

export function toggleVoiceCapture(idx?: number): void {
  if (recording) stopVoiceCapture();
  else void startVoiceCapture(idx);
}

function cleanupAfterRecord(): void {
  recording = false;
  pendingTranscription = false;
  setBadge(false);
  setMicButtonsActive(false, targetIdx);
  setTextareaListening(targetIdx, false);
  audioChunks = [];
  mediaRecorder = null;
}

async function onRecorderStop(): Promise<void> {
  recording = false;
  setMicButtonsActive(false, targetIdx);
  setTextareaListening(targetIdx, false);

  if (audioChunks.length === 0) {
    setBadge(false);
    return;
  }
  const blobType = mimeUsed.split(';')[0] || 'audio/webm';
  const blob = new Blob(audioChunks, { type: blobType });
  audioChunks = [];

  if (blob.size < MIN_BLOB_BYTES) {
    setBadge(false);
    // Trop court pour valoir le coup d'envoyer (clic accidentel).
    return;
  }

  // Indicateur visuel : badge passe en mode "Transcription…" jusqu'à
  // réception du résultat. Ça évite un toast intrusif pour chaque dictée.
  pendingTranscription = true;
  setBadge(true, 'Transcription…');

  const ext = blobType.endsWith('mp4') ? 'mp4'
    : blobType.endsWith('ogg') ? 'ogg'
    : 'webm';
  const form = new FormData();
  form.append('audio', blob, `audio.${ext}`);
  form.append('language', VOICE_LANG);

  let result: { text?: string; error?: string } | null = null;
  try {
    // X-Requested-With: requis par le middleware CSRF du serveur sur
    // toutes les routes mutantes (POST/DELETE). Sans ça → 403.
    const resp = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { 'X-Requested-With': 'FastVibe' },
      body: form,
    });
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      result = await resp.json();
    } else {
      result = { error: `HTTP ${resp.status} : ${await resp.text()}` };
    }
    if (!resp.ok) {
      const msg = result?.error || `Transcription HTTP ${resp.status}`;
      showToast(msg.length > 200 ? msg.slice(0, 200) + '…' : msg);
      cleanupAfterRecord();
      return;
    }
  } catch (e: unknown) {
    showToast(`Erreur transcription : ${(e as Error).message}`);
    cleanupAfterRecord();
    return;
  }

  setBadge(false);
  pendingTranscription = false;
  const text = (result?.text || '').trim();
  if (text) appendToTextarea(targetIdx, text);
}

function appendToTextarea(idx: number, text: string): void {
  const wrapper = document.querySelector(`[data-compose-popover="${idx}"]`) as HTMLElement | null;
  if (!wrapper) return;
  const ta = wrapper.querySelector('.compose-textarea') as HTMLTextAreaElement | null;
  if (!ta) return;
  const sep = (ta.value && !ta.value.endsWith(' ') && !ta.value.endsWith('\n')) ? ' ' : '';
  ta.value = ta.value + sep + text;
  const end = ta.value.length;
  try { ta.setSelectionRange(end, end); } catch { /* noop */ }
  ta.scrollTop = ta.scrollHeight;
  // Arme l'Enter pour submit immédiat : après une dictée, l'user s'attend
  // à appuyer sur Enter pour envoyer, pas Ctrl+Enter (UX message vocal).
  // Le flag est cleared dans le keydown handler de app.ts dès que l'user
  // tape autre chose qu'Enter (édition manuelle → retour au Ctrl+Enter).
  ta.dataset.voiceArmed = '1';
  // Focus pour que l'user puisse éditer / soumettre directement.
  try { ta.focus(); } catch { /* noop */ }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.code !== HOTKEY_CODE) return;
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
  // Whitelistées : .compose-textarea (cible de la voice elle-même),
  // .xterm-helper-textarea (textarea cachée d'xterm.js qui mange tous les
  // keydowns du pane focus → sans ça, le hotkey ne marche jamais quand un
  // terminal a le focus, c.-à-d. quasi tout le temps).
  const tgt = e.target as HTMLElement | null;
  if (tgt) {
    const tag = tgt.tagName;
    const cls = typeof tgt.className === 'string' ? tgt.className : '';
    const isCompose = tgt.classList?.contains('compose-textarea');
    const isXtermHelper = cls.includes('xterm-helper-textarea');
    if (!isCompose && !isXtermHelper && (tag === 'INPUT' || (tgt as HTMLElement).isContentEditable)) {
      return;
    }
  }
  e.preventDefault();
  e.stopPropagation();
  if (hotkeyHeld) return; // ignore auto-repeat
  hotkeyHeld = true;
  void startVoiceCapture();
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.code !== HOTKEY_CODE) return;
  if (!hotkeyHeld) return;
  hotkeyHeld = false;
  e.preventDefault();
  e.stopPropagation();
  stopVoiceCapture();
}

export function initVoice(): void {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    supported = false;
    return;
  }
  supported = true;
  preflightWarning = checkPreflight();

  // Capture phase pour gagner contre les keydowns d'xterm / compose Ctrl+Enter.
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', () => {
    if (recording) stopVoiceCapture();
    hotkeyHeld = false;
  });
}
