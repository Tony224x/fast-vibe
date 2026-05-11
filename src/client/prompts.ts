// Catalogue de prompts pré-faits déclenchables depuis le header de chaque pane
// (bouton "Next steps" + menu "Prompts"). Les modèles Claude/Kiro répondent
// indifféremment en français — labels et corps en français car l'utilisateur
// travaille en français.

export type QuickPrompt = { id: string; label: string; hint: string; text: string };

export const QUICK_PROMPTS: QuickPrompt[] = [
  {
    id: 'next-steps',
    label: 'Next steps',
    hint: 'Propose les prochaines étapes concrètes',
    text:
      "Quelles sont les prochaines étapes ? Propose 3 à 5 actions concrètes, " +
      "ordonnées par priorité, avec pour chacune : (1) ce que ça apporte, " +
      "(2) le fichier ou la zone à toucher, (3) le risque éventuel. " +
      "Pas de code à ce stade — juste un plan court et actionnable.",
  },
  {
    id: 'plan',
    label: 'Plan détaillé',
    hint: "Plan d'implémentation avant tout code",
    text:
      "Avant d'écrire le moindre code, fais un plan d'implémentation détaillé : " +
      "(1) architecture / approche, (2) fichiers à modifier ou créer, " +
      "(3) edge cases à anticiper, (4) stratégie de test. " +
      "Attends ma validation avant d'implémenter.",
  },
  {
    id: 'run-tests',
    label: 'Lance les tests',
    hint: 'Exécute la suite de tests, fix ce qui casse',
    text:
      "Lance la suite de tests du projet. Si certains échouent, " +
      "investigue la cause racine (pas de patch surface) et corrige. " +
      "Reporte la sortie réelle des tests, pas une paraphrase.",
  },
  {
    id: 'find-bugs',
    label: 'Audit bugs',
    hint: "Cherche bugs et edge cases dans l'état actuel",
    text:
      "Audite l'état actuel du code pour bugs, edge cases, et comportements " +
      "incohérents. Liste les findings classés par sévérité (critique / " +
      "important / mineur). Propose ensuite un fix pour chaque finding " +
      "critique, mais ne touche pas au code tant que je n'ai pas validé.",
  },
  {
    id: 'simplify',
    label: 'Simplifie',
    hint: 'Cherche duplication, sur-ingénierie, code mort',
    text:
      "Revue de simplification sur les fichiers modifiés (ou récemment édités " +
      "si rien n'est en diff) : repère duplication avec utilitaires existants, " +
      "abstractions prématurées, paramètres en trop, code mort, commentaires " +
      "qui paraphrasent le code. Corrige directement les issues claires, " +
      "liste celles qui demandent une décision.",
  },
  {
    id: 'explain',
    label: "Explique l'état",
    hint: "Résume ce qui vient d'être fait",
    text:
      "Explique en 5 bullet points max ce que tu viens de faire, pourquoi, " +
      "et quel est l'état actuel du repo (fichiers touchés, tests qui passent " +
      "ou pas, ce qui reste à faire).",
  },
  {
    id: 'commit',
    label: 'Commit',
    hint: 'Crée un commit propre du diff actuel',
    text:
      "Revue le diff actuel (`git diff` + `git status`), puis crée un commit " +
      "ciblé avec un message conventional-commits clair (feat / fix / chore / " +
      "docs / refactor). Ne stage QUE les fichiers pertinents — surtout pas " +
      "les .env, secrets, ou artefacts de build.",
  },
];

export function getQuickPrompt(id: string): QuickPrompt | undefined {
  return QUICK_PROMPTS.find(p => p.id === id);
}
