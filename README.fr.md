# Carnet santé Helper (extension Chrome / Edge)

[English](README.md) · **Français** · [中文](README.zh.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Kreyòl ayisyen](README.ht.md)

Téléchargez en lot et organisez automatiquement vos rapports du [Carnet santé Québec](https://carnetsante.gouv.qc.ca) :

- **Prélèvements** (résultats de laboratoire)
- **Imagerie médicale** (examens d'imagerie)

Le portail n'offre aucun export en lot ; cette extension le fait pour vous, dans votre propre session connectée. L'interface parle 13 langues et suit le mode clair/sombre de votre système.

## Ce que vous obtenez

Chaque PDF classé par date et par nom, plus un index récapitulatif — dans le dossier de téléchargements de votre navigateur (par défaut) ou dans le dossier de votre choix :

```
Downloads/
└── Carnet santé/
    ├── Prélèvements/
    │   └── 2026-02-01 - Hémogramme.pdf
    ├── Imagerie médicale/
    │   └── 2026-05-15 - Radiographie thorax.pdf
    ├── index-20261107-1530.csv      ← tableau récapitulatif de tous les rapports
    └── donnees-20261107-1530.json   ← les mêmes données, lisibles par machine
```

Les rapports déjà téléchargés sont **ignorés automatiquement** : vous pouvez relancer périodiquement, seuls les nouveaux rapports sont récupérés.

## Installation — une fois par ordinateur

**Option A · avec le script d'installation (mises à jour faciles)**

Sur une nouvelle machine (ce dépôt est privé — Git et votre connexion GitHub requis) :

macOS / Linux — Terminal :
```sh
gh repo clone bellchu/CarnetSanteHelper ~/Code/CarnetSanteHelper
bash ~/Code/CarnetSanteHelper/tools/install.sh
```

Windows — PowerShell :
```powershell
gh repo clone bellchu/CarnetSanteHelper $HOME\Code\CarnetSanteHelper
cd $HOME\Code\CarnetSanteHelper
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

Dépôt déjà cloné ? Depuis le dépôt, lancez `bash tools/install.sh` (macOS/Linux) ou `powershell -ExecutionPolicy Bypass -File tools\install.ps1` (Windows). Le script met le code à jour, copie le chemin de l'extension dans le presse-papiers et ouvre la page des extensions du navigateur.

**Option B · sans Git — télécharger un ZIP**

1. Sur GitHub : bouton vert **Code** → **Download ZIP** → décompressez (p. ex. `CarnetSanteHelper-main`).
2. Copiez le chemin complet du **dossier décompressé** (pas le fichier ZIP). Sous Windows : Maj+clic droit sur le dossier → **Copier en tant que chemin d'accès**.

**Ensuite, dans Chrome ou Edge (l'unique étape manuelle — règle de sécurité du navigateur pour les extensions non publiées) :**

1. Ouvrez `chrome://extensions` (Edge : `edge://extensions`).
2. Activez le **mode développeur** (en haut à droite).
3. Cliquez sur ** Charger l'extension non empaquetée** → collez le chemin (⌘⇧V / Ctrl+Shift+V) → Entrée.

✅ **C'est réussi quand :** une carte « Carnet santé Helper » apparaît sur la page. Astuce : épinglez-la — icône pièce de puzzle dans la barre d'outils → épingler — pour l'avoir toujours à portée de clic.

**Mise à jour :** relancez le script (ou retéléchargez le ZIP), puis cliquez sur **Recharger ↻** sur la carte de l'extension. Ce dernier clic ne peut pas être automatisé — c'est une règle du navigateur, pas un bug.

## Première utilisation — 4 étapes

1. **Connectez-vous** à [carnetsante.gouv.qc.ca](https://carnetsante.gouv.qc.ca) et restez sur n'importe quelle page du portail.
2. **Cliquez sur l'icône de l'extension.** En une ou deux secondes, la fenêtre devrait afficher *Connecté : votre nom*. Si elle signale l'absence de session : actualisez l'onglet du portail, puis rouvrez la fenêtre.
3. **Première fois ? Cochez « Simulation »** et appuyez sur *Simuler* — cela compte les rapports qui seraient téléchargés, sans rien télécharger. Les chiffres vous conviennent ? Décochez, puis appuyez sur *Télécharger*.
4. **Suivez la progression** dans la fenêtre (barre, compteurs par section, journal en direct). À la fin, ouvrez vos fichiers avec le bouton 📁 en haut de la fenêtre. **Ne fermez pas l'onglet du portail pendant l'exécution.**

## Réglages (⚙)

| Réglage | Rôle |
|---|---|
| Dossier des rapports | **Choisissez n'importe quel dossier de votre disque** (Chrome/Edge bureau) : les rapports y sont écrits directement, avec sous-dossiers. Choisissez « Autoriser à chaque visite » lors de l'accès pour éviter les réautorisations. Retour au dossier de téléchargements si indisponible |
| Dossier racine / sous-dossiers | Structure d'archivage, par défaut `Carnet santé/Prélèvements` et `Imagerie médicale` (aperçu en direct dans les réglages ; les chemins absolus sont convertis en chemins relatifs — le navigateur interdit d'écrire ailleurs) |
| Modèle de nom de fichier | Variables `{date} {label} {prescriber} {section} {id} {year}`, par défaut `{date} - {label}` |
| Délai entre rapports | Par défaut 400 ms — merci de le garder au-dessus de 0, c'est poli envers le site |
| Période | Détectée automatiquement : à l'ouverture, l'extension sonde vos données les plus anciennes et ne propose que des périodes existant réellement (évite les erreurs sur plages vides) ; plages fixes si la détection échoue |
| Ignorer les téléchargés | Interrupteur de dédoublonnage ; *Effacer le journal* force un re-téléchargement complet |

## Fonctionnement et confidentialité

Le portail est une application Angular sans API publique. L'extension réutilise votre session : elle lit le jeton OIDC du portail dans la page, appelle les mêmes endpoints privés `/api/1` que le site lui-même (imagerie : liste → métadonnées → PDF ; prélèvements : listes annuelles → PDF en base64 dans le JSON), et sauvegarde via `chrome.downloads` ou l'API File System Access.

Tout se passe localement dans votre navigateur. **L'extension ne contacte aucun service tiers et ne collecte n'envoie rien** ; le jeton sert uniquement à récupérer vos propres dossiers.

## Dépannage

| Symptôme | Solution |
|---|---|
| « Aucune session détectée » | Connectez-vous au portail, restez sur sa page, actualisez une fois, rouvrez la fenêtre |
| « Failed to fetch » | Blocage réseau/CORS : actualisez l'onglet connecté du portail, puis réessayez |
| Une boîte de sauvegarde s'ouvre pour chaque fichier | Le réglage « Demander où enregistrer chaque fichier » est actif — désactivez-le dans `chrome://settings/downloads`, puis relancez |
| ⚠ sur le dossier / cible avec ⚠ | Autorisation expirée (possible après un redémarrage du navigateur) : rechoisissez le dossier dans ⚙ Réglages |
| Fichiers absents du dossier choisi | Dossier déplacé / débranché → repli automatique vers les téléchargements — voir les erreurs/journal dans la fenêtre |
| Beaucoup d'échecs / 401 en cours | Jeton probablement expiré — l'extension le renouvelle une fois automatiquement ; sinon actualisez la page du portail et relancez (le déjà-téléchargé est ignoré) |
| « Prélèvements non disponibles » | La fonction n'est pas activée pour votre compte — l'extension ignore cette section et continue avec l'imagerie |
| Certaines années en HTTP 500 | Le serveur est chatouilleux sur les plages de dates — l'extension réessaie automatiquement (format → année par année) ; les rares restes sont journalisés et ignorés, souvent au-delà de la rétention en ligne (~3 ans) |
| Fichiers introuvables | Bouton 📁 en haut de la fenêtre ; ou regardez les téléchargements du navigateur (sous `Carnet santé/`) |

## Limites et développement

- Dépend des endpoints privés `/api/1` du portail ; une refonte gouvernementale pourrait demander une mise à jour (endpoints regroupés en tête de `lib/pipeline.js`).
- Vaccination sur un autre portail ; valeurs de laboratoire annuelles (`ResultatsAnalyse`) non incluses.
- Pour organiser **vos propres** dossiers de santé — utilisez-le raisonnablement (le délai par défaut n'est pas là pour rien).

Développeurs : `npm test` — 36 tests unit + intégration simulants tout le pipeline face à un `/api/1` factice. Arborescence : `lib/` (logique + orchestration), `content/` (jeton + appels API), `background/` (téléchargements & état), `popup/`, `options/`, `folder/`.
