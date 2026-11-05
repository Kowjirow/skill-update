# skill-update

[English](README.md)

Une skill d'agent — pour Claude Code, Codex et tout agent qui lit `SKILL.md` — qui **tient à jour les skills que vous avez copiées depuis GitHub**, dans n'importe quel dossier, sans perdre vos propres retouches. Elle retrouve d'où vient chaque skill, montre ce qui a changé en amont et ce qui mérite un regard, fusionne la mise à jour avec vos changements, sauvegarde chaque fichier qu'elle remplace et tient un journal daté de chaque mise à jour.

## Installer

### Claude Code — comme plugin (recommandé)

```
/plugin marketplace add Kowjirow/skill-update
/plugin install skill-update@skill-update
```

Puis taper `/skill-update`, ou simplement demander de mettre à jour vos skills.

### Codex et autres agents — avec la CLI skills

Avec la [CLI skills de Vercel](https://github.com/vercel-labs/skills), qui installe dans Codex, Claude Code, Cursor et plus de 20 autres agents :

```bash
npx skills add Kowjirow/skill-update            # choisir le ou les agents à l'invite
npx skills add Kowjirow/skill-update -a codex   # ou viser Codex directement
```

Dans Codex, l'appeler par `$skill-update` (ou `/skills` pour parcourir), ou simplement demander de mettre à jour vos skills.

### À la main (skill à déposer)

Copier le dossier de la skill dans le dossier de skills de votre agent :

```bash
git clone https://github.com/Kowjirow/skill-update
cp -R skill-update/skills/skill-update ~/.claude/skills/   # Claude Code
cp -R skill-update/skills/skill-update ~/.agents/skills/   # Codex (anciennes installations : ~/.codex/skills/)
```

## Prérequis

- **Node.js 18+** — le script de la skill n'utilise rien d'autre de npm : aucune dépendance.
- **git** — chaque dépôt est lu avec git : ni API GitHub, ni jeton, ni quota, et tout hébergeur git convient (GitHub, GitLab, auto-hébergé, dossier local).
- **Accès réseau** aux dépôts d'où viennent vos skills, et à [skills.sh](https://skills.sh) pour `find` (facultatif : `--no-search`).
- Windows, macOS ou Linux.

## Ce qu'elle fait

La plupart des skills s'installent en copiant un dossier d'un dépôt dans `~/.claude/skills/`, dans le dossier de skills d'un projet, ou dans une bibliothèque personnelle rangée en sous-dossiers. Une fois copiées, plus rien ne dit d'où elles viennent, et les mettre à jour veut dire recopier à la main et refaire ses retouches. Quand on l'appelle, la skill :

1. **Demande où sont vos skills** — la première fois seulement : le dossier par défaut de votre agent (`~/.claude/skills`, `~/.agents/skills`) ou celui que vous choisissez. Les sous-dossiers conviennent : tout dossier qui contient un `SKILL.md` est une skill, à toute profondeur.
2. **Retrouve d'où vient chaque skill** — par les liens de ses fichiers, les dépôts déjà suivis, vos places de marché Claude Code, puis l'annuaire public skills.sh. Chaque candidat est vérifié fichier par fichier dans son historique git : elle trouve l'original plutôt qu'une copie, et le commit exact dont votre copie est tirée. Elle l'inscrit dans un fichier de suivi ; vous ne donnez une adresse que si elle ne peut pas trancher.
3. **Regarde ce qui a changé** — des deux côtés : en amont depuis votre copie, et vos propres retouches. Elle compare les empreintes git des fichiers : rien n'est téléchargé pour décider, et les fins de ligne ne comptent pas comme un changement.
4. **Signale ce qui mérite un regard** — les scripts d'une skill tournent avec les droits de votre agent ; avant que vous acceptiez, elle relève les nouveaux scripts, les lignes qui exécutent du code téléchargé (`curl https://… | sh`), les outils nouvellement pré-autorisés, la configuration de hooks et les changements de licence, et montre le diff exact sur demande.
5. **Met à jour, avec votre accord** — par une fusion à trois voies : l'amont est pris là où vous n'avez rien touché, fusionné là où vous avez tous deux modifié, et un vrai chevauchement est signalé comme conflit, la skill restant intacte. Chaque fichier remplacé ou retiré est d'abord sauvegardé, et chaque mise à jour est listée dans un journal Markdown daté.

## Ce que contient la skill

```
skills/skill-update/
├── SKILL.md                  la procédure, les sous-commandes, les gabarits de compte rendu et les règles
├── README.md                 ce qu'elle fait, prérequis et réglages, pour qui l'installe
├── agents/openai.yaml        nom affiché et invite par défaut pour Codex
├── references/lockfile.md    formats : fichier de suivi, configuration, journal, risques, rapport
├── examples/                 un compte rendu de vérification, de mise à jour, et une page de journal
└── scripts/
    ├── skill-update.mjs      la ligne de commande derrière chaque sous-commande
    ├── core.mjs              accès git, empreintes des fichiers, plan et fusion à trois voies
    ├── origin.mjs            retrouver le dépôt d'où vient une skill copiée
    ├── risks.mjs             ce qu'une mise à jour apporte qui mérite un regard
    └── i18n.mjs              messages en anglais et en français
```

Le dépôt porte aussi `.claude-plugin/` (plugin et place de marché Claude Code), `.codex-plugin/plugin.json` (plugin Codex) et les tests (`node --test`).

### Sous-commandes

Une sous-commande, en anglais, après le nom de la skill va droit à une action : `/skill-update revert brag` dans Claude Code, `$skill-update revert brag` dans Codex. Taper une sous-commande vaut accord pour cette action ; un risque élevé est toujours montré d'abord et redemandé.

| Sous-commande | Ce qu'elle fait |
| --- | --- |
| *(aucune)* | Déroulé complet : vérifier chaque skill, montrer ce qui a changé et ses risques, demander, mettre à jour. |
| `check [skill…]` | Vérifier seulement : ce qui a changé en amont, vos retouches, ce qu'il faut regarder. Ne modifie rien. |
| `update [skill…]` | Mettre à jour les skills nommées (ou demander lesquelles), avec fusion, sauvegardes, suivi et journal. |
| `diff <skill>` | Montrer le texte exact qu'une mise à jour changerait, fichier par fichier. |
| `revert <skill>` | Remettre la version d'avant la dernière mise à jour ; relancer pour remonter plus loin. Annule aussi un `add`. |
| `pin <skill> [pourquoi]` | Figer une skill à sa version (projet client, état sûr) ; `check` dit toujours ce qui attend. |
| `unpin <skill>` | Laisser de nouveau se mettre à jour une skill figée. |
| `add <url> [dossier]` | Copier une nouvelle skill depuis un dépôt, avec sa licence, et la suivre. Montre d'abord les fichiers et les risques. |
| `find [skill…]` | Retrouver d'où viennent les skills non suivies ; les correspondances exactes se suivent d'un coup. |
| `track <skill> <url>` | Inscrire d'où vient une skill copiée (le dossier et le commit sont trouvés pour vous). |
| `untrack <skill>` | Ne plus suivre une skill ; ses fichiers restent. |
| `scan` | Lister les skills trouvées et comment chacune est suivie, sans réseau. |
| `remind` | Une ligne quand des mises à jour attendent, d'après la dernière vérification ; peut tourner à chaque ouverture de session. |
| `plugins` | Plugins Claude Code en retard sur leur place de marché, avec la commande pour les mettre à jour. |
| `config [dossier]` | Voir ou changer le ou les dossiers de skills, le dossier du journal et la commande d'après mise à jour. |

Le script se lance aussi seul, avec les mêmes sous-commandes :

```bash
node skills/skill-update/scripts/skill-update.mjs check --lang fr
node skills/skill-update/scripts/skill-update.mjs update --all --dry-run
node skills/skill-update/scripts/skill-update.mjs find --track
```

Options communes : `--json` (sortie lisible par une machine), `--dry-run` (n'écrit rien), `--lang en|fr`, `--offline` (sans réseau), `--root <dossier>` (un seul dossier), `--help`.

## Notes

- **Rien n'est supprimé.** Les fichiers qu'une mise à jour remplace ou retire sont d'abord copiés dans `~/.claude/skill-update/backups/` (`~/.agents/skill-update/` sans Claude Code) ; `revert` s'en sert. Une skill en conflit n'est pas touchée du tout.
- **Confidentialité.** `find` n'envoie que le nom de la skill à l'annuaire skills.sh ; `--no-search` s'en tient à ce que votre machine sait déjà. Rien d'autre ne quitte votre machine, hormis les récupérations git.
- **Relire avant d'accepter.** Les signalements de risque invitent à regarder, ce ne sont pas des verdicts : une mise à jour peut apporter des instructions dont vous ne voulez pas. `diff` montre les lignes.
- **Bac à sable de Codex.** `check`, `update` et `find` ont besoin du réseau et d'écrire hors du projet ; les autoriser quand le bac à sable le demande.
- **Le journal** va par défaut dans `~/.claude/skill-update/logs/<date>.md` ; `config --log-dir` le place dans vos notes. Une commande `afterUpdate`, facultative, reçoit chaque rapport de mise à jour en JSON, pour tenir un registre ou commiter un coffre de notes.
- **Rappel à l'ouverture de session** dans Claude Code — à ajouter aux hooks `SessionStart` de `~/.claude/settings.json` :

  ```json
  { "type": "command", "command": "node \"<chemin>/skills/skill-update/scripts/skill-update.mjs\" remind --hook", "timeout": 10 }
  ```

## Sécurité

Ce que le script lit, écrit, envoie et lance.

- **Lit :**
  - les dossiers de skills réglés avec `config`, et leurs fichiers de suivi ;
  - son dossier d'état `~/.claude/skill-update/` (`~/.agents/skill-update/` sans Claude Code, ou `SKILL_UPDATE_HOME`) ;
  - `~/.agents/.skill-lock.json` (ou `$XDG_STATE_HOME/skills/.skill-lock.json`), écrit par `npx skills` ;
  - `~/.claude/plugins/installed_plugins.json` et `known_marketplaces.json`, pour `plugins` et `find`.
- **Écrit :**
  - dans un dossier de skills : seulement les fichiers de la skill mise à jour, ajoutée ou rétablie, et le fichier de suivi du dossier. Chaque chemin est vérifié avant la première écriture. Un nom de fichier venu d'un dépôt qui sort du dossier de la skill est refusé : `../`, chemin absolu, lien vers ailleurs. Rien n'est alors écrit pour cette skill ;
  - une skill qui est elle-même un clone git avance par git (`git merge --ff-only`) ;
  - son dossier d'état : réglages, cache de clones git nus, sauvegardes, fichiers de conflit, journaux, dernier contrôle ;
  - le dossier de journal réglé avec `config --log-dir`, s'il y en a un.
- **Réseau :**
  - récupérations git vers les dépôts suivis, ceux donnés à `add`, `track` et `find`, et les marketplaces de plugins (`plugins`) ;
  - `find` n'envoie que le nom d'une skill à `https://skills.sh/api/search`, avec un propriétaire quand les liens de la skill en nomment un.

  `--offline` ne récupère rien ; `find --no-search` saute l'annuaire.
- **Lance :**
  - git ;
  - votre commande `afterUpdate`, seulement si vous l'avez réglée. Elle démarre directement, sans shell : `&&`, `|`, `;` et `>` sont de simples arguments. L'agent ne la règle jamais de lui-même ;
  - `remind --hook` lance un `check` en arrière-plan.

  Il ne lance jamais un script contenu dans une skill.
- **Jamais :** aucune installation de paquet, aucun `sudo`, aucune télémétrie, aucune modification des réglages de l'agent (`settings.json`, hooks, serveurs MCP, permissions). Pour les plugins, il affiche seulement la commande `claude plugin` à lancer.

## Licence

MIT — voir [LICENSE](LICENSE).
