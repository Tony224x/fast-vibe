# v1.2.0 — "Stay in the Flow"

> Persistent settings, auto-focus, resizable panes.

## ✨ Auto-focus on task completion

Quand un terminal finit sa tâche (prompt CLI détecté après 1.5s de silence), le focus bascule automatiquement dessus avec un flash vert. Plus besoin de cliquer pour enchaîner.

- Détecte les prompts Claude (`❯`), Kiro, et bash (`$`)
- Ignore les petits bursts (démarrage, outputs courts)
- Configurable dans les settings (activé par défaut)

## ↕️ Panes redimensionnables

Barre de resize draggable entre le pilot et les workers. Glisser pour ajuster la répartition de l'espace. Les terminaux se re-fit automatiquement.

## 💾 Persistence complète

Tous les paramètres sont maintenant sauvegardés entre les redémarrages :

- Settings → `.settings.json`
- Bookmarks → `.bookmarks.json`
- Dernier chemin projet → pré-rempli au prochain lancement

## 🐛 Bugfix

- **WSL auto-launch** — la commande CLI attendait que le shell WSL soit prêt (détection de prompt) au lieu d'un timeout fixe de 500ms qui arrivait trop tôt.
