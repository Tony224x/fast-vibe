#!/usr/bin/env python3
"""
faster-whisper sidecar pour fast-vibe.

Charge le modèle whisper une seule fois au boot et expose un endpoint
HTTP POST /transcribe sur 127.0.0.1 (loopback uniquement, pas accessible
hors-machine). Le navigateur enregistre l'audio via MediaRecorder et
fast-vibe (server.ts) proxy le multipart vers ce sidecar.

Pourquoi ce sidecar plutôt que d'embarquer whisper dans Node :
  - Pas de dépendance ML dans le runtime Node (3 deps only)
  - Le modèle charge une fois et reste en mémoire → latence ~1s/utterance
    après warmup (vs ~10s de cold start à chaque appel)
  - Découplé : on peut redémarrer fast-vibe sans recharger le modèle
  - Aligné avec la stack Python d'Anthony (Kalira)

Usage :
  pip install -r scripts/whisper_requirements.txt
  python scripts/whisper_sidecar.py

Variables d'env :
  FAST_VIBE_WHISPER_PORT  port HTTP (default 8765)
  WHISPER_MODEL           taille du modèle (tiny/base/small/medium/large-v3,
                          default 'small' = bon compromis FR / latence)
  WHISPER_LANGUAGE        langue par défaut (default 'fr')
  WHISPER_DEVICE          'cpu', 'cuda' ou 'auto' (default 'auto')
  WHISPER_COMPUTE_TYPE    'int8', 'float16', 'float32' (default 'int8')
"""
import os
import sys
import tempfile

# Lecture des paramètres d'env AVANT l'import faster_whisper (qui est lent).
PORT = int(os.environ.get("FAST_VIBE_WHISPER_PORT", "8765"))
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
LANGUAGE_DEFAULT = os.environ.get("WHISPER_LANGUAGE", "fr")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

print(f"[whisper-sidecar] starting model={MODEL_SIZE} device={DEVICE} compute={COMPUTE_TYPE}", flush=True)

try:
    from faster_whisper import WhisperModel
    from flask import Flask, request, jsonify
except ImportError as e:
    sys.stderr.write(
        f"[whisper-sidecar] missing dependency: {e}\n"
        "Run: pip install -r scripts/whisper_requirements.txt\n"
    )
    sys.exit(1)

print(f"[whisper-sidecar] loading whisper model (first run downloads ~1.5GB)...", flush=True)
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
print(f"[whisper-sidecar] model loaded, listening on 127.0.0.1:{PORT}", flush=True)

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": MODEL_SIZE, "device": DEVICE})


@app.post("/transcribe")
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "missing 'audio' field"}), 400
    f = request.files["audio"]
    lang = request.form.get("language", LANGUAGE_DEFAULT) or LANGUAGE_DEFAULT

    # On écrit dans un tempfile parce que faster-whisper veut un path ou un
    # file-like seekable. Le FileStorage de Flask ne l'est pas garanti
    # selon le format envoyé par le navigateur.
    # delete=False pour pouvoir close puis re-open sous Windows.
    suffix = ".webm"
    if f.filename and "." in f.filename:
        suffix = "." + f.filename.rsplit(".", 1)[-1]
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            f.save(tmp.name)
            tmp_path = tmp.name

        segments, info = model.transcribe(
            tmp_path,
            language=lang,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        return jsonify({
            "text": text,
            "language": info.language,
            "duration": info.duration,
        })
    except Exception as e:
        sys.stderr.write(f"[whisper-sidecar] transcribe failed: {e}\n")
        return jsonify({"error": str(e)}), 500
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    # debug=False et threaded=True : le modèle whisper n'est pas thread-safe
    # pour le multi-decode simultané, mais flask en threaded=True peut quand
    # même servir health en parallèle d'une transcription en cours.
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
