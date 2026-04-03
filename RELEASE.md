# v1.1.0

## 🔒 Safe by default

Les CLI se lancent désormais **sans bypass de permissions** par défaut.

| Engine | Mode safe (défaut) | Mode trust |
|--------|--------------------|------------|
| Claude | `claude` | `claude --dangerously-skip-permissions` |
| Kiro | `kiro-cli chat --tui` | `kiro-cli chat --trust-all-tools --tui` |

Activer **Trust Mode** dans les settings (⚙) pour retrouver le comportement précédent.

## 🐧 Support WSL

Nouvelle option **Run in WSL** dans les settings : les terminaux sont lancés dans WSL (`wsl.exe --cd <path>`) au lieu du shell Windows. Utile quand les CLI sont installées côté Linux.

## 📁 Favoris & explorateur natif

- **☆ Bookmarks** — sauvegarder des dossiers en favoris, persistés dans `.bookmarks.json`
- **☰ Liste** — sélectionner rapidement un favori
- **📁 Folder picker** — ouvre l'explorateur de fichiers natif de l'OS (WSL-aware : PowerShell + conversion automatique des chemins)

## 🧘 Zen mode

`Ctrl+Shift+F` masque la sidebar et la barre de lancement. Les terminaux occupent 100% de l'espace. Bouton `⛶` en bas à droite pour toggle.

## 🖥️ Native app mode

```bash
npm run app
```

Ouvre une fenêtre Chrome/Edge en mode application (sans barre d'URL, sans onglets). Zéro dépendance supplémentaire.

## 🐛 Bugfix

- Fix du conflit d'ID DOM en mode noPilot : le pane pilote est retiré du DOM au lieu d'être caché, évitant que le terminal xterm s'ouvre dans un conteneur invisible.
