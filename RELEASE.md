# v3.0.1

_29 avril 2026_

## 🐛 Fixes

- **Refit des terminaux après changement de space / ungroup** — `rerender()` reconstruisait le DOM via `renderLayout` mais n'appelait jamais `fitAll`, donc les canvas xterm restaient à la taille du space précédent jusqu'à ce qu'un autre événement force un refit. Le cache `lastBodyW/H` devenait également stale entre deux relocations DOM, ce qui pouvait court-circuiter un resize de splitter ultérieur.
  - Ajout de `invalidateFitCache()` dans `terminal.ts`
  - Appel `invalidateFitCache()` + `requestAnimationFrame(fitAll)` depuis `rerender()` dans `sidebar.ts`

## 📁 Fichiers impactés

`src/client/sidebar.ts`, `src/client/terminal.ts`, `package.json`, `package-lock.json`

---


# v2.0.1

_13 avril 2026_

## ✨ Features

- **Bouton Verify (simplify-style)** — Remplace le simple prompt de vérification par une revue en 3 phases inspirée de `/simplify` :
  - Phase 1 : `git diff` pour identifier les changements
  - Phase 2 : 3 sub-agents parallèles (réutilisation, qualité, efficacité)
  - Phase 3 : agrégation des findings et correction automatique
  - Prompt engine-agnostic (fonctionne avec Claude Code et Kiro CLI)

- **Scroll-to-bottom sur tous les terminaux** — Bouton flottant sur chaque pane pour revenir en bas du terminal, avec gestion correcte du stacking context (`isolation: isolate`)

## 🐛 Fixes

- **Erreurs d'écriture settings loguées** — Les erreurs d'écriture du fichier settings sont maintenant loguées au lieu d'être silencieusement ignorées

## 🔧 Chore

- Bump version `2.0.0` → `2.0.1`

## 📁 Fichiers impactés

`public/index.html`, `public/style.css`, `src/client/app.ts`, `src/client/session.ts`, `src/client/terminal.ts`, `src/client/ui-helpers.ts`, `src/client/xterm.d.ts`, `src/server.ts`, `package.json`

---


# v2.0.0 — "The Great Migration"

> Full JavaScript → TypeScript migration. Zéro feature perdue, zéro régression, type safety partout.

## 🦋 La Grande Migration

Le codebase entier passe de JavaScript à TypeScript — backend, frontend, tests, build tooling. Chaque fichier est typé, chaque module a sa responsabilité claire.

### Backend (5 modules)

| Module | Rôle | LOC |
|--------|------|-----|
| `src/types.ts` | Types partagés (Settings, Terminal, etc.) | 74 |
| `src/suggest-patterns.ts` | Pattern matching auto-suggest | 47 |
| `src/pty-manager.ts` | Gestion des PTY, buffers, lifecycle | 625 |
| `src/server.ts` | Express routes, WebSocket, API | 345 |
| `src/app.ts` | Entry point, server bootstrap | 105 |

Compilé avec `tsc` → `dist/`.

### Frontend (15 modules)

Le monolithe `public/app.js` (1350 lignes) est découpé en 15 modules TypeScript ciblés :

`app` · `state` · `utils` · `theme` · `terminal` · `session` · `settings` · `sidebar` · `bookmarks` · `autocomplete` · `ui-helpers` · `toast` · `preview` · `search` · `keyboard`

Bundlé avec **esbuild** → `public/bundle.js` (52 KB).

### Tests (5 suites)

| Suite | Scope |
|-------|-------|
| `server.test.ts` | Routes API, CSRF, settings |
| `pty-manager.test.ts` | PTY lifecycle, buffers, output |
| `utils.test.ts` | Utilitaires partagés |
| `websocket.test.ts` | WebSocket connections, origin check |
| `suggest-patterns.test.ts` | Pattern matching |

**146 tests**, tous passent via `ts-jest`.

## 📐 Architecture

```
src/
├── types.ts                  # Types partagés
├── suggest-patterns.ts       # Auto-suggest patterns
├── pty-manager.ts            # PTY manager
├── server.ts                 # Express + WS
├── app.ts                    # Entry point
└── client/
    ├── app.ts                # Client entry
    ├── state.ts              # État global (setState)
    ├── utils.ts              # Helpers
    ├── theme.ts              # Dark/light/system
    ├── terminal.ts           # xterm.js wrapper
    ├── session.ts            # Launch/stop logic
    ├── settings.ts           # Settings modal
    ├── sidebar.ts            # Status cards
    ├── bookmarks.ts          # Directory bookmarks
    ├── autocomplete.ts       # Path autocomplete
    ├── ui-helpers.ts         # DOM helpers
    ├── toast.ts              # Notifications
    ├── preview.ts            # iframe preview
    ├── search.ts             # Terminal search
    └── keyboard.ts           # Shortcuts
```

## 🔧 Build Tooling

- **TypeScript 6** — strict mode, types partagés via `src/types.ts`
- **esbuild** — bundle client en ~50ms
- **ts-jest** — tests natifs TypeScript, pas de transpilation séparée
- **Dual tsconfig** — `tsconfig.json` (backend Node) + `tsconfig.client.json` (frontend DOM)
- **Typecheck** — `npm run typecheck` vérifie backend + client sans émettre

## 📊 Chiffres

| Métrique | Valeur |
|----------|--------|
| Fichiers source TS | 20 |
| LOC source | 2 689 |
| LOC tests | 1 191 |
| Tests | 146 |
| Suites | 5 |
| Bundle client | 52 KB |
| Deps runtime | 3 (express, node-pty, ws) |
| Commits migration | 16 |

## 💀 Ce qui a été supprimé

- `server.js`, `pty-manager.js`, `suggest-patterns.js` — remplacés par les `.ts`
- `public/app.js` (1350 lignes) — remplacé par 15 modules client
- `public/utils.js` — absorbé dans `src/client/utils.ts`

## ⬆️ Upgrade

```bash
git pull
npm install    # nouvelles devDeps (typescript, esbuild, ts-jest, @types/*)
npm run build  # tsc + esbuild
npm start      # comme avant
```

Aucun changement d'API, aucun changement de comportement. Drop-in replacement.
