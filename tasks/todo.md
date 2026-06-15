# Fiabiliser & optimiser le démarrage (2026-06-15)

Plan : `~/.claude/plans/quizzical-yawning-fog.md`

## Implémentation
- [x] 1. Spawn Claude en direct (`_buildLaunch`, src/pty-manager.ts) — fallback `'claude'`, argv, WSL/non-WSL, `mode:'direct'`
- [x] 1b. Supprimer `_injectShellCommand` (devenu mort)
- [x] 2. Stagger des spawns (`_spawnStaggered` + gen guard) dans `launchAll` / `restoreAll` / `killAll`
- [x] 3. EADDRINUSE → `exit(1)` (src/server.ts `server.on('error')`)
- [x] 4. Watchdog démarrage (`slot.startupTimer`, src/pty-manager.ts spawn/kill/onExit + `Slot` dans src/types.ts)
- [x] 5. Test : `_buildLaunch` claude → `mode:'direct'`, `injectCmd:null`, argv session flag

## Vérification
- [x] `npm run build` — 0 erreur TS
- [x] `npm test` — suite verte (156/156)
- [x] Stress-test 8 workers × 3 cycles via API → 24/24 TUI Claude
- [x] Probe EADDRINUSE (server.js sur port pris → log clair + exit 1)
- [x] Probe resume (reboot server.js → restore → 2/2 resumed, 0 fallback)
- [x] Probe binaire absent (resolve→bogus → spawn-error + crashed, pas de boucle)
- [x] Restauré workers=2 + 0 worker vivant + 0 orphelin claude
- [x] Revue adversariale (subagent) → 1 défaut réel (`resume` flippé dans `_buildLaunch` avant spawn réussi → poison si spawn throw). Corrigé : flip déplacé dans `spawn()` après succès. 2 tests contrat ajoutés (builder lecture seule + spawn flippe). Suite 157/157.

---

# RAM — réduction & anti-fuite (2026-05-29)

## Diagnostic (prouvé)
- RAM dominée par les workers `claude` (50–420 MB chacun, croît avec le contexte). 6 workers ≈ 1.3 GB. Serveur node ≈ 44 MB (sain).
- Inhérent au design N instances IA. Facteurs contrôlables ci-dessous.

## Fixes

- [x] **1. Fix orphelins Windows (app.ts)** — `child.kill('SIGINT')` sur Windows fait TerminateProcess → `cleanup()`/`killAll()` du serveur ne tourne jamais → arbres `cmd.exe→claude` orphelins à chaque arrêt/restart superviseur. Sur Windows : `taskkill /T /F /PID <child.pid>` pour tuer tout l'arbre. POSIX : SIGINT gracieux + SIGKILL backstop.
- [x] **2. Auto-compact workers idle (pty-manager + server + types)** — nouveau setting `autoCompactIdleMin` (0=off, default 0). Track `lastActivityMs` par slot (maj dans onData + sendInput). Sweep périodique (toutes les 2 min) : workers claude alive, idle > seuil, au prompt (dernière ligne ❯) → `/compact` une fois (flag `compactedWhileIdle`, reset à la prochaine activité).
- [x] **3. Réduire scrollback xterm (terminal.ts)** — `scrollback: 5000` → `2000`. Constante nommée + commentaire RAM.
- [x] **4. Cap + warning workers (pty-manager + server + client)** — cap dur sur addWorker (max 8 workers vivants, hors tombstones). 400 si dépassé. Warning UI quand workers vivants ≥ 6 (toast/estimation RAM).

## Vérif RAM
- [x] `npm run typecheck` + `npm run build` OK
- [x] `npm test` OK (158/158)
- [x] Probe : addWorker au-delà du cap renvoie -1/400 ; sweep gating off/claude/kiro ; compact idle+prompt only, pas de double.
- [x] UI auto-compact câblée (state, app hydration, modale, settings, profils).

---

# Suppression du pilot (2026-05-29)
fast-vibe = N workers indépendants. Plus de pilote orchestrateur. `noPilot:true` était déjà le défaut → on supprime les branches `!noPilot` et les artefacts pilot.

- [x] **types.ts** : retirer `noPilot` de Settings/LaunchOptions/DEFAULTS ; `role` → `'worker'` only ; retirer noPilot du state restore interface.
- [x] **pty-manager.ts** : retirer `noPilot`, `isPilot`, `writePilotPrompt`, `PILOT_PROMPT_FILE`, branche spawn pilot (`--disallowedTools Agent --append-system-prompt-file`) ; `count = workerCount` ; role always worker ; countLiveWorkers sans exclusion pilote ; launchAll/restoreAll sans noPilot.
- [x] **server.ts** : retirer noPilot des settings/launch/restore/status ; supprimer le garde "Pilot cannot be removed".
- [x] **client** : state.ts, session.ts (pane pilot, indices, labels, info), layout.ts, ui-helpers.ts (supprimer initPilotResize + startIdx), keyboard.ts, terminal.ts, settings.ts (checkbox), app.ts (hydration, initPilotResize, menu pilot).
- [x] **index.html** : supprimer pane pilot statique, handle resize pilot, checkbox No pilot, MAJ tagline.
- [x] **style.css** : retirer styles `.pilot` / resize handle pilot.
- [x] **tests** : MAJ pty-manager/server/websocket tests (retirer assertions pilot).
- [x] **docs** : CLAUDE.md, README.md, docs/GUIDE.md ; suppression `.pilot-prompt.md` + entrée .gitignore.
- [x] Backward-compat : `noPilot` dans anciens .settings.json/.session-state.json/profils → ignoré sans casser (loadSettings merge tolère les clés en trop).
- [x] Vérif : typecheck + build OK ; tests 151/151 verts ; serveur lancé sur :3344 (build frais) → settings expose `autoCompactIdleMin` (clamp 0..240 vérifié : 15→15, 99999→240, -5→0, NaN→0), plus de `noPilot` dans le code (clé legacy on-disk tolérée par le merge) ; HTML servi → 0 pane pilot, 0 checkbox no-pilot, input auto-compact présent, seul `sidebar-resize-handle` subsiste.
