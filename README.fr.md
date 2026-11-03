# skill-update

[English](README.md)

Une skill pour Claude Code (`/skill-update`) et Codex (`$skill-update`) qui tient à jour les skills que vous avez **copiées depuis GitHub**, dans n'importe quel dossier, sans perdre vos propres retouches.

La plupart des skills s'installent en copiant un dossier d'un dépôt dans `~/.claude/skills/`, dans le `.claude/skills/` d'un projet, ou dans une bibliothèque personnelle rangée en sous-dossiers. Une fois copiées, plus rien ne dit d'où elles viennent, et les mettre à jour veut dire recopier à la main et refaire ses retouches. `skill-update` règle cela :

- **N'importe quel dossier, à toute profondeur.** Au premier lancement, vous choisissez le dossier : celui de votre agent (`~/.claude/skills` pour Claude Code, `~/.agents/skills` pour Codex), ou le vôtre. Tout dossier qui contient un `SKILL.md` est trouvé, même dans des sous-dossiers (`video/brag`) ou un emballage de plugin.
- **Sait d'où vient chaque skill.** `track` retrouve le dossier du dépôt, et même le commit exact dont votre copie est tirée, et l'inscrit dans un fichier de suivi.
- **Garde vos retouches.** Une mise à jour est une fusion à trois voies (`git merge-file`) : vos patchs locaux survivent ; un vrai chevauchement est signalé comme conflit et la skill n'est pas touchée.
- **Prudent.** Montre les commits amont avant d'écrire, demande avant de mettre à jour, copie chaque fichier remplacé ou retiré dans un dossier de sauvegarde, ne supprime jamais une skill.
- **Un journal daté.** Chaque mise à jour est listée dans `<date>.md` : les skills, leurs commits avant et après, les fichiers changés et les intitulés des commits amont. Le dossier du journal se place où vous rangez vos notes.
- **Ni API, ni jeton, ni quota.** Il passe directement par git (clones nus et partiels en cache) : GitHub, GitLab, tout hébergeur git ou un dossier local, quelle que soit la branche par défaut.
- **Le reste aussi.** Adopte les skills installées par `npx skills`, fait avancer les skills qui sont des clones git, et liste les plugins Claude Code en retard sur leur place de marché avec la commande pour les mettre à jour.
- **Messages en français et en anglais**, selon la langue du système ou `--lang`.

Prérequis : Node.js 18+ et git. Aucune dépendance.

## Installer

**Claude Code**, comme plugin :

```
/plugin marketplace add <owner>/skill-update
/plugin install skill-update@skill-update
```

ou à la main : copier `skills/skill-update/` dans `~/.claude/skills/`.

**Codex** : copier `skills/skill-update/` dans `~/.agents/skills/` (ou dans le `.agents/skills/` d'un projet). Le dépôt porte aussi un manifeste de plugin Codex, `.codex-plugin/plugin.json`, et `agents/openai.yaml` donne à Codex le nom affiché de la skill.

**Tout agent**, avec la CLI skills : `npx skills add <owner>/skill-update`.

## Utiliser

Taper `/skill-update` dans Claude Code ou `$skill-update` dans Codex, ou demander « mets à jour mes skills ». La skill demande votre dossier de skills la première fois, vérifie chaque skill, montre ce qui a changé et met à jour ce que vous acceptez. Claude Code et Codex partagent la même configuration : un dossier utilisé par les deux n'est suivi qu'une fois.

Le script se lance aussi seul :

```bash
node skills/skill-update/scripts/skill-update.mjs config --root claude         # ou agents, codex, <dossier>
node skills/skill-update/scripts/skill-update.mjs check --lang fr
node skills/skill-update/scripts/skill-update.mjs track brag https://github.com/latent-spaces/brag/tree/main/skills/brag
node skills/skill-update/scripts/skill-update.mjs update --all --dry-run
node skills/skill-update/scripts/skill-update.mjs update --all
node skills/skill-update/scripts/skill-update.mjs plugins
```

`--json` donne une sortie lisible par une machine, sur toutes les commandes. `--help` liste les options.

## Fonctionnement

Pour chaque skill suivie, le fichier de suivi garde la source, le dossier dans le dépôt et le commit auquel la copie correspond. `check` récupère la source et compare trois versions de chaque fichier par leur empreinte git : le commit enregistré (base), la tête actuelle (amont) et votre copie (local). Les fins de ligne ne comptent pas comme un changement. `update` prend ensuite l'amont là où vous n'avez rien touché, fusionne là où vous avez tous deux modifié, et met en sauvegarde ce que l'amont a supprimé. Détails : [references/lockfile.md](skills/skill-update/references/lockfile.md).

Chaque mise à jour ajoute une section à `<dossier du journal>/<AAAA-MM-JJ>.md` (`config --log-dir <dossier>`, par défaut `~/.claude/skill-update/logs`). Une commande `afterUpdate`, facultative, reçoit le rapport de mise à jour en JSON : pour tenir un registre ou commiter.

## Tests

```bash
node --test
```

## Remerciements

Inspiré de [yizhiyanhua-ai/skills-updater](https://github.com/yizhiyanhua-ai/skills-updater), qui vérifie les installations par plugin et par `npx skills`. `skill-update` ajoute ce qu'il laisse de côté : les skills copiées à la main dans n'importe quel dossier, de vraies fusions à trois voies, et git au lieu de l'API GitHub.

## Licence

MIT
