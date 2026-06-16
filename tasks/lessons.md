# Lessons — Index (fast-vibe)

> Lu en début de session. Une ligne par leçon, lien vers la fiche détaillée.

- [pty-startup.md](lessons/pty-startup.md) — Démarrage workers : spawn direct (pas de screen-scrape du prompt), exit(1) sur EADDRINUSE, stagger des spawns + jeton de génération, impact tests du stagger, builder en lecture seule (ne pas muter `resume` avant un spawn réussi).
- [ci-jest-flake.md](lessons/ci-jest-flake.md) — Flake CI jest (exit 1 sans test rouge, arbres identiques) = race teardown du pool de workers + forceExit sur runner lent ; fix `--runInBand`. Diagnostic : comparer les arbres, RTK falsifie git/gh (passer par PowerShell + `gh run view --log`).
