# Leçons — Démarrage PTY / workers (fast-vibe)

## Ne PAS screen-scraper le prompt shell pour lancer un CLI dans un PTY
**Erreur** : lancer `cmd.exe`/`bash` puis "taper" la commande (`claude …`) en
détectant le prompt via regex (`/[$#>]\s*$/`) + fallback timeout. C'est une
course de timing : la regex fire sur n'importe quel `>`, et le fallback tape
même si le shell n'est pas prêt → commande perdue → pane noir figé sur un
prompt nu qui n'exit jamais (donc aucune recovery).
**Règle** : spawner le binaire CIBLE **directement** dans le PTY (argv), pas via
un shell wrapper. Résoudre le path absolu (`where.exe`/`which`, cf.
`_resolveBinary`) car node-pty/CreateProcess ne gère pas PATHEXT sur Windows ;
fallback au nom nu si la résolution échoue (laisse node-pty tenter + garde les
tests verts vu que node-pty y est mocké). Bonus : kill cible le process réel
(moins d'orphelins → `--resume` fiable) et −1 process/worker.

## `server.on('error')` DOIT exit(1) sur EADDRINUSE
**Erreur** : un handler `server.on('error')` qui se contente de logger. Sur
`EADDRINUSE` (port déjà pris par un ancien process/orphelin), `listen()` ne
réussit jamais : le process ne sert ni n'exit → un superviseur qui surveille
l'exit ne relance jamais → "l'app ne démarre pas" (hang silencieux, fenêtre
jamais ouverte).
**Règle** : sur EADDRINUSE, logger clairement puis `process.exit(1)` pour que le
superviseur (backoff) relance. Un hang muet est pire qu'un crash.

## Échelonner les spawns multiples (anti thundering-herd)
**Erreur** : `for (i…) spawn(i)` synchrone pour N workers. Sur Windows/ConPTY,
N spawns simultanés (PTY + binaire) créent un pic CPU/disque qui ralentit le
démarrage et amplifie les courses de timing.
**Règle** : 1er spawn synchrone (réactivité + état immédiat pour les tests),
les suivants échelonnés (`setTimeout`, ~150ms). Garder un **jeton de génération**
incrémenté à chaque launch/restore/killAll : les spawns différés le vérifient
avant de s'exécuter (sinon un spawn en vol ressuscite un worker juste tué).

## Ne PAS muter l'état d'un slot dans un *builder* avant que l'op risquée réussisse
**Erreur** : `_buildLaunch` (constructeur d'argv) flippait `slot.resume = true`
en construisant la commande, AVANT que `pty.spawn` soit confirmé. Si le spawn
throw (binaire introuvable), `resume` reste à `true` pour une session que claude
n'a JAMAIS créée → le prochain Restart fait `--resume <uuid>` d'une session
inexistante → "No conversation found" garanti (1 tentative gâchée + churn d'UUID
avant l'auto-heal). Trouvé par revue adversariale, pas par les tests.
**Règle** : un builder reste en LECTURE SEULE. Toute mutation d'état persistant
(flags de session, compteurs) se fait APRÈS la confirmation de l'op risquée
(ici : après `pty.spawn` réussi, dans `spawn()`). Tester les DEUX moitiés du
contrat : le builder ne mute pas (garde anti-régression) + le spawn réussi mute.

## Tests : node-pty est mocké, l'état n'est pas immédiat avec le stagger
Les spawns au-delà du 1er sont différés → un test qui interagit avec un worker
d'index > 0 juste après `launchAll` doit `await` au-delà du stagger (cf.
`server.test.ts` Suggest API beforeAll). Le 1er worker (index 0) reste
synchrone, donc les tests 1-worker ne changent pas.
