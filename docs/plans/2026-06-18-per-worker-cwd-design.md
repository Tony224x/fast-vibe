# Design — Workspace (cwd) par worker

Date : 2026-06-18
Statut : validé

## Problème

Aujourd'hui le `cwd` est **unique et partagé** par tous les workers
(`PtyManager.cwd`, posé une fois au `launchAll`). Impossible d'ouvrir un worker
sur un autre dossier, ni de re-pointer le workspace d'un terminal déjà lancé.

## Objectif

Chaque worker a son **propre `cwd`**, modifiable à tout moment, qui surcharge le
`cwd` global. On peut aussi spawn un worker (qui démarre sur le global) puis le
re-pointer.

## Décisions (issues du brainstorming)

- **Scope** : `cwd` indépendant par worker, modifiable à tout moment.
- **UI** : action « Change folder… » dans la rangée d'actions du pane header
  (se replie dans le menu `⋯` quand le pane est étroit). Réutilise le picker
  natif existant (`/api/pick-folder`).
- **Worker en cours** : changement **silencieux** (pas de confirmation), comme
  le bouton Restart. Le worker est tué et respawné dans le nouveau dossier.
- **Claude** : changer de dossier démarre une **session vierge** (nouveau
  `sessionId`, `resume=false`) — l'ancienne conversation pointait sur l'ancien
  projet, la reprendre n'aurait pas de sens.
- **Persistance** : le `cwd` par worker est persisté dans `.session-state.json`
  et relu au restore.
- **Spawn d'un nouveau worker** : hérite du `cwd` global (1 clic), puis
  re-pointable via « Change folder… ».

## Architecture

### `types.ts`
- `Slot.cwd?: string` — dossier propre du worker. Absent = `cwd` global.

### `pty-manager.ts`
- `spawn()` : `const workdir = slot.cwd || cwd || this.cwd;`
  → un seul point de changement ; stagger / restart / restore honorent tous le
  `slot.cwd` sans toucher aux appelants (qui passent `this.cwd` en fallback).
- `changeWorkerCwd(index, cwd): boolean` :
  1. garde index/slot/`!removed` ;
  2. `slot.cwd = cwd` ;
  3. Claude → `slot.sessionId = randomUUID(); slot.resume = false` ;
  4. `this.restart(index)` (kill + respawn différé — réutilise l'existant) ;
  5. `notifyStateChange()` (persiste cwd + sessionId).
- `restoreAll()` : `cwd: w?.cwd` lors de la reconstruction des slots.

### `server.ts`
- `SessionState.workers[]` : ajout de `cwd?: string`.
- `schedulePersistSessionState()` : mappe `cwd: s.cwd`.
- `POST /api/terminal/:id/cwd` body `{ cwd }` :
  - 404 si id hors borne ; 400 si `cwd` manquant ou dossier inexistant
    (`fs.existsSync`, même garde que `/api/launch`) ;
  - `ptyManager.changeWorkerCwd(id, cwd)` → `{ ok, id, cwd }`.

### Frontend
- `layout.ts` : bouton `data-action="change-folder"` (icône dossier) dans
  `.pane-actions-overflow`.
- `app.ts` : dispatch `change-folder` → `changeFolderTerminal(idx)`.
- `ui-helpers.ts` : `changeFolderTerminal(id)` → picker natif
  (`/api/pick-folder`) → `POST /api/terminal/:id/cwd` → toast.

## Data flow (changement de dossier)

```
clic « Change folder » (pane idx)
  → changeFolderTerminal(idx)
  → POST /api/pick-folder            → { folder }
  → POST /api/terminal/idx/cwd {cwd} → changeWorkerCwd(idx, cwd)
       slot.cwd = cwd ; (claude) sessionId neuf ; restart(idx)
       → kill(idx) → spawn(idx) avec workdir = slot.cwd
  → persistSessionState (.session-state.json : workers[idx].cwd)
  → toast
```

## Tests

- `pty-manager.test.ts` : `spawn` utilise `slot.cwd` quand présent ;
  `changeWorkerCwd` met à jour le cwd + régénère le sessionId (Claude) +
  respawn ; `restoreAll` relit le `cwd` par worker.
- `server.test.ts` : `POST /api/terminal/:id/cwd` → 200 (dossier valide),
  400 (dossier inexistant / cwd manquant), 404 (id invalide) ; round-trip de
  persistance du `cwd` dans le state.

## Hors scope (YAGNI)

- Affichage permanent du chemin dans le header.
- Demander le dossier au moment du spawn.
- Logs par-dossier (les logs restent sous le `cwd` global).
