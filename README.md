# Patrimoine : tableau de bord personnel

Une PWA installable sur ton téléphone pour suivre l'ensemble de ton patrimoine :
saisie rapide des comptes (PEA Boursorama, livrets, compte courant, épargne salariale)
et synchronisation automatique d'Interactive Brokers chaque matin.

```
 Téléphone (PWA)  ──lit / écrit──►  Gist GitHub secret  ◄──écrit──  GitHub Actions
 GitHub Pages                       patrimoine.json                  ibkr_sync.py (chaque matin)
                                                                       ▲
                                                                       └── IBKR Flex Web Service
```

- **Le dépôt** ne contient que le code : aucune donnée personnelle.
- **Le gist secret** contient tes valeurs (un total par compte et par date, aucun numéro de compte).
- **Rien ne tourne sur ton PC** : la synchro IBKR est faite par GitHub.

Compte environ 30 minutes pour l'installation complète.

---

## 1. Mettre l'appli en ligne (GitHub Pages)

1. Crée un dépôt **public** sur GitHub, par exemple `patrimoine` (Pages est gratuit pour les dépôts publics).
2. Envoie-y tous les fichiers de ce dossier, y compris le dossier caché `.github` :
   ```bash
   git init && git add . && git commit -m "Tableau de bord patrimoine"
   git branch -M main
   git remote add origin https://github.com/<ton-pseudo>/patrimoine.git
   git push -u origin main
   ```
3. Sur GitHub : **Settings › Pages › Build and deployment › Source : Deploy from a branch**,
   branche `main`, dossier `/ (root)`, puis **Save**.
4. Une minute plus tard, l'appli est en ligne sur `https://<ton-pseudo>.github.io/patrimoine/`.

## 2. Créer le token GitHub pour le téléphone

1. GitHub › photo de profil › **Settings › Developer settings › Personal access tokens › Tokens (classic)**
   › **Generate new token (classic)**.
2. Nom : `patrimoine` ; expiration : 1 an ; coche **uniquement** la case `gist`.
3. Copie le token (`ghp_…`) : il ne s'affiche qu'une fois.

> Ce token ne donne accès qu'à tes gists, pas à tes dépôts. Il sert aussi à la synchro IBKR (étape 4).

## 3. Installer l'appli sur le téléphone

1. Ouvre l'adresse GitHub Pages dans **Safari** (iPhone) ou **Chrome** (Android).
2. Appuie sur **Configurer la synchronisation**, colle le token, laisse l'ID du gist vide,
   puis **Tester / créer**. L'appli crée le gist et affiche son ID : **note-le**.
3. Ajoute l'appli à l'écran d'accueil :
   - iPhone : bouton Partager › **Sur l'écran d'accueil** ;
   - Android : menu ⋮ › **Installer l'application**.
4. Appuie sur **Mettre à jour** et saisis tes premières valeurs.

Pour l'utiliser aussi sur ton PC : ouvre la même adresse et colle le même token et le même ID de gist.

## 4. Brancher la synchro IBKR

### a) Créer la Flex Query dans IBKR

Dans le **Client Portal** IBKR : **Performance & Reports › Flex Queries**.

1. **Activity Flex Query** › **+** (créer).
2. Nom : `patrimoine-nav`.
3. Sections : coche **Net Asset Value (NAV) in Base** et sélectionne tous ses champs
   (au minimum `Report Date` et `Total`).
4. Delivery Configuration :
   - Format : **XML** ;
   - Period : **Last 30 Calendar Days** (le premier passage remplit tout le mois, ensuite il corrige les jours manquants).
5. General Configuration : Date Format **yyyyMMdd** (valeur par défaut), le reste par défaut.
6. Enregistre, puis note l'**ID de la requête** (Query ID) affiché dans la liste.

Ensuite, toujours dans **Flex Queries**, ouvre la configuration du **Flex Web Service**
(icône d'engrenage à côté de « Flex Web Service ») : active-le et génère un **jeton** (token).
Choisis la durée de validité la plus longue proposée et note la date d'expiration.

### b) Ajouter les secrets dans GitHub

Dépôt › **Settings › Secrets and variables › Actions › New repository secret**, quatre fois :

| Nom                  | Valeur                                    |
|----------------------|-------------------------------------------|
| `IBKR_FLEX_TOKEN`    | jeton du Flex Web Service                 |
| `IBKR_FLEX_QUERY_ID` | ID de la Flex Query                       |
| `GIST_ID`            | ID du gist (affiché dans l'appli)         |
| `GIST_TOKEN`         | token GitHub `ghp_…` de l'étape 2         |

### c) Tester

Dépôt › **Actions › Synchro IBKR › Run workflow**. Au bout d'une minute, la ligne
« OK : N valeur(s) mise(s) à jour » apparaît dans le journal. Actualise l'appli :
le compte Interactive Brokers (badge **Auto**) affiche ta valeur nette.

La synchro tourne ensuite toute seule du mardi au samedi vers 8 h 15.

> Le journal n'affiche jamais de montant (il est visible publiquement sur un dépôt public),
> et GitHub masque automatiquement les secrets.

### Tester le script sur ton PC (facultatif)

```bash
export IBKR_FLEX_TOKEN=... IBKR_FLEX_QUERY_ID=...
python sync/ibkr_sync.py --dry-run     # affiche les valeurs trouvées, n'écrit rien
```
Sous Windows (PowerShell) : `$env:IBKR_FLEX_TOKEN="..."` à la place de `export`.

---

## Utilisation au quotidien

- **Mettre à jour** : une fois par semaine ou par mois, saisis la valeur de chaque compte
  telle qu'affichée par ta banque. Laisse vide un compte qui n'a pas bougé.
- **Œil** en haut : floute les montants (pratique dans les transports).
- **Toucher un compte** : renommer, changer la couleur, voir et corriger l'historique, archiver.
- **Réglages** : ajouter un compte (assurance-vie, PER…), exporter une sauvegarde JSON.
- Un compte saisi à la main sans mise à jour depuis plus de 45 jours apparaît en rouge.

La courbe garde la dernière valeur connue de chaque compte jusqu'à la saisie suivante.
Les variations affichées incluent tes versements : ce n'est pas la performance pure.

## Entretien

| Quoi | Quand | Action |
|------|-------|--------|
| Jeton Flex IBKR | à son expiration | le régénérer et mettre à jour le secret `IBKR_FLEX_TOKEN` |
| Token GitHub | à son expiration | le régénérer, le recoller dans l'appli et dans le secret `GIST_TOKEN` |
| Synchro planifiée | après 60 jours sans commit | GitHub met en pause les tâches planifiées des dépôts inactifs : Actions › Synchro IBKR › **Enable workflow** |
| Modification du code | à chaque changement | augmenter `VERSION` dans `sw.js` pour que le téléphone récupère la nouvelle version |

## Sécurité, en bref

- Le gist est **secret** : il n'est ni listé ni indexé, mais toute personne qui aurait son lien
  pourrait le lire. Ne partage pas son ID et n'y mets jamais de numéro de compte.
- Le token GitHub est stocké uniquement dans le navigateur de ton téléphone.
  En cas de perte du téléphone, révoque-le sur GitHub (Settings › Developer settings).
- Le jeton IBKR ne permet que de lire des relevés : il ne peut passer aucun ordre.

## Structure

```
index.html             interface
style.css              styles (thème clair et sombre automatique)
app.js                 logique : calculs, graphique, synchro gist
sw.js                  fonctionnement hors ligne
manifest.webmanifest   installation sur l'écran d'accueil
icons/                 icônes de l'appli
sync/ibkr_sync.py      synchro IBKR (bibliothèque standard Python uniquement)
.github/workflows/     exécution planifiée par GitHub Actions
```

Format du fichier `patrimoine.json` :

```json
{
  "version": 1,
  "accounts": [{ "id": "pea-boursorama", "name": "PEA Boursorama", "color": "#1f5c46", "source": "manual" }],
  "entries":  [{ "date": "2026-10-08", "account": "pea-boursorama", "value": 21450.5, "source": "manual" }]
}
```
