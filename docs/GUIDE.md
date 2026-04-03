# fast-vibe — Guide utilisateur

## Démarrage rapide

```bash
npm install
npm start        # Mode navigateur → http://localhost:3333
npm run app      # Mode fenêtre native (sans barre d'URL)
```

## Interface

### Barre de lancement

| Élément | Description |
|---------|-------------|
| ☆ | Ajouter/retirer le dossier courant des favoris |
| ☰ | Ouvrir la liste des favoris sauvegardés |
| 📁 | Ouvrir l'explorateur de fichiers natif de l'OS |
| Champ texte | Saisir ou naviguer vers un dossier projet |
| Start / Stop | Lancer ou arrêter les terminaux |
| ⚙ | Ouvrir les paramètres |

### Navigation de dossiers

- Cliquer sur le champ texte pour parcourir les dossiers
- `↑` `↓` pour naviguer, `Tab` pour entrer dans un dossier, `Entrée` pour sélectionner
- `..` pour remonter d'un niveau
- Le bouton 📁 ouvre le sélecteur de dossier natif de votre OS

### Favoris

- Cliquer ☆ pour sauvegarder le chemin courant (l'étoile devient pleine ★)
- Cliquer ☰ pour voir et sélectionner un favori
- ✕ dans la liste pour supprimer un favori
- Les favoris sont persistés dans `.bookmarks.json`

## Paramètres (⚙)

| Paramètre | Description |
|-----------|-------------|
| Workers | Nombre d'instances parallèles (1-8) |
| Engine | `Claude Code` ou `Kiro CLI` |
| No Pilot | Coché = pas d'orchestrateur, tous les terminaux sont des workers indépendants |
| Preview URL | URL à charger dans le panneau de prévisualisation |

## Engines

| Engine | Commande lancée | Mode pilote |
|--------|-----------------|-------------|
| Claude Code | `claude --dangerously-skip-permissions` | ✅ Le pilote orchestre les workers via curl |
| Kiro CLI | `kiro-cli chat --trust-all-tools --tui` | ❌ Utiliser le mode "No Pilot" |

## Terminaux

- **Double-clic** sur l'en-tête d'un terminal pour l'agrandir (re-double-clic pour réduire)
- **Clic** sur un terminal pour le focus
- La sidebar affiche le statut de chaque terminal (PID, durée)

### Gestion du contexte

Depuis la sidebar, pour chaque terminal actif :

- **⊜ compact** — résume le contexte pour libérer de la mémoire
- **⊗ clear** — réinitialise complètement le contexte

## Mode Zen

Masque la barre de lancement et la sidebar pour maximiser l'espace terminal.

- Raccourci : `Ctrl+Shift+F`
- Ou cliquer le bouton `⛶` en bas à droite
- Re-appuyer pour revenir au mode normal

## Mode fenêtre native

```bash
npm run app
```

Lance le serveur et ouvre automatiquement une fenêtre Chrome/Edge en mode application (sans barre d'URL, sans onglets). Nécessite Chrome ou Edge installé.

## Panneau de prévisualisation

- Cliquer `⬛` dans la sidebar pour ouvrir/fermer le panneau
- Saisir une URL (ex: `http://localhost:3000`) et cliquer `→`
- `↻` pour rafraîchir

## Mode pilote (Claude Code)

En mode pilote, le terminal 0 est l'orchestrateur. Il contrôle les workers via l'API REST :

```bash
# Envoyer une tâche au worker 2
curl -s -X POST http://localhost:3333/api/terminal/2/send \
  -H "Content-Type: application/json" \
  -d '{"text":"implémenter le module auth"}'

# Lire la sortie du worker 2
curl -s http://localhost:3333/api/terminal/2/output?last=5000

# Compacter le contexte du worker 2
curl -s -X POST http://localhost:3333/api/terminal/2/compact

# Réinitialiser le worker 2
curl -s -X POST http://localhost:3333/api/terminal/2/clear
```

## API REST

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| `GET` | `/api/settings` | Lire les paramètres |
| `POST` | `/api/settings` | Modifier les paramètres |
| `POST` | `/api/launch` | Démarrer `{"cwd": "...", "workers": 4}` |
| `POST` | `/api/stop` | Arrêter tous les terminaux |
| `POST` | `/api/terminal/:id/send` | Envoyer du texte `{"text": "..."}` |
| `GET` | `/api/terminal/:id/output?last=N` | Lire les N derniers caractères |
| `POST` | `/api/terminal/:id/compact` | Compacter le contexte |
| `POST` | `/api/terminal/:id/clear` | Réinitialiser le contexte |
| `GET` | `/api/status` | Statut de tous les terminaux |
| `GET` | `/api/bookmarks` | Liste des favoris |
| `POST` | `/api/bookmarks` | Ajouter un favori `{"path": "..."}` |
| `DELETE` | `/api/bookmarks` | Supprimer un favori `{"path": "..."}` |
| `POST` | `/api/pick-folder` | Ouvrir le sélecteur de dossier natif |

## Prérequis

- Node.js 18+
- Un des CLI : [Claude Code](https://docs.anthropic.com/en/docs/claude-code) ou [Kiro CLI](https://kiro.dev)
- Windows : Visual Studio Build Tools (pour `node-pty`)
