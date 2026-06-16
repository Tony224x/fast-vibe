# Leçon — Flake CI jest sur runner Windows (teardown worker)

## Symptôme
Run CI `jest --ci --coverage` sur `master` (commit `2eada13`) **rouge en exit 1**,
alors que le **même arbre byte-identique** (`tree eec6b30`, commit dev `3921698`)
passait **vert deux fois** (events `push` + `pull_request`). Donc : flake, pas un
bug produit.

Signature dans le log GitHub (à reconnaître) :
- 3 suites sur 5 affichent `PASS`, la 4e émet sa sortie `console.log` puis **rien** ;
- **~4.5 s de silence**, puis `##[error]Process completed with exit code 1` ;
- **aucun** `● test failed`, **aucun** résumé `Tests: X passed`, **aucune** erreur.

## Cause racine
Ce n'est PAS un timer du suggesteur (hypothèse initiale fausse : le suggesteur
n'est **jamais** spawné par les tests — tous les `generateSuggestion` tournent en
mode `off`/`static`, et l'unique test `ai` n'appelle pas `generateSuggestion`).

La vraie cause : le **pool de workers jest** + `coverage` + `forceExit: true`
(jest.config.ts) se court-circuitent au teardown sur un runner lent. Un worker
pas encore drainé est tué par `forceExit` avant d'avoir rapporté sa suite →
le parent considère la suite incomplète → **exit 1 fantôme** (sans test rouge).
Sur une machine rapide c'est invisible (10/10 et 6/6 verts en local) ; ça ne
sort qu'au timing serré d'un runner GitHub contraint.

## Fix
`test:ci` = `jest --ci --coverage --runInBand`. En in-band il n'y a **plus de
pool de workers** : une seule passe séquentielle, plus rien à tuer au teardown,
**exit déterministe**. Coût négligeable (suite ~12 s / 157 tests). Commit `9f7370f`.

## Règles anti-récidive
1. **Avant de soupçonner le code produit sur un échec CI** : comparer les arbres
   (`git rev-parse <a>^{tree}` vs `<b>^{tree}`). Arbres identiques + un pass / un
   fail = **flake**, on cherche le non-déterminisme (workers, timers, ordre), pas
   un bug logique.
2. **Exit 1 jest SANS test rouge ni résumé** = problème de cycle de vie process
   (workers/handles/teardown), pas une assertion. `forceExit: true` est déjà un
   pansement sur des handles non nettoyés ; pour un gate CI, `--runInBand` rend
   le tout déterministe.
3. **`--detectOpenHandles` ne voit que les handles encore vivants en fin de
   suite.** Un timer armé puis auto-résolu en cours de suite (≤10 s) passe sous
   le radar — absence de rapport ≠ absence de fuite. Pour reproduire un flake de
   teardown, c'est le **timing du runner** qu'il faut imiter, pas juste detect.
4. **RTK mange/falsifie la sortie git & gh** (faux SHAs dans `git log --oneline`,
   logs tronqués). Pour la vérité terrain : `git rev-parse`/`reflog` via l'outil
   **PowerShell** (hors hook RTK), et récupérer les logs CI avec
   `gh run view --log | Out-File` plutôt que via le pipe Bash.
5. **Latent (hors-scope de ce fix, à surveiller)** : le mock node-pty tire un
   `pid = Math.random()` → collision possible si un test assertait l'unicité ;
   le timer resize 50 ms (`pty-manager.ts:612`) et les timers suggesteur ne sont
   ni `.unref()` ni clearés. Pas la cause du flake CI, mais hygiène à corriger.
