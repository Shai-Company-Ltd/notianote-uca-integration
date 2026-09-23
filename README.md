# NotiaNote × UCA — Intégration du portail étudiant

Ce dépôt documente et contient le code de recherche pour l'intégration du portail étudiant de l'**Université Clermont Auvergne (UCA)** dans l'application **NotiaNote**.

---

## 🎯 Objectif

L'idée est simple : permettre aux étudiants de l'UCA de se connecter à NotiaNote avec leurs identifiants universitaires, exactement comme ils le font sur le site `ent.uca.fr`, et de récupérer automatiquement :
- Leur emploi du temps (via ADE Campus)
- Leurs notes (via Pégase / Apogée)
- Leurs cours en ligne (via Moodle UCA)

Vous pouvez également tester directement l'intégration sur **[notianote.fr](https://notianote.fr)**.

---

## 🔒 Le Problème : le CAS de l'UCA

L'université utilise un système d'authentification centralisée appelé **CAS (Central Authentication Service)**. Ce système est conçu pour bloquer les connexions automatiques (robots, scripts) et impose souvent une **double authentification** (code par email ou SMS).

Il est donc **impossible** de récupérer les données de l'étudiant avec une simple requête HTTP classique en arrière-plan — l'université détecterait la requête comme un bot et bloquerait l'accès.

---

## ✅ La Solution : WebView + Extraction de Cookies

La seule méthode viable, utilisée dans NotiaNote, est celle du **WebView avec interception de cookies**.

### Comment ça marche, étape par étape :

```
┌─────────────────────────────────────────────────────────┐
│                  Application NotiaNote                   │
│                                                         │
│  1. L'étudiant clique sur "Se connecter via l'UCA"      │
│     ↓                                                   │
│  2. Une modale s'ouvre avec un navigateur intégré       │
│     (react-native-webview) pointant sur :               │
│     https://ent.uca.fr/cas/login                        │
│     ↓                                                   │
│  3. L'étudiant se connecte NORMALEMENT sur le vrai      │
│     site de l'université (login + double auth)          │
│     ↓                                                   │
│  4. Dès que l'URL change vers "ent.uca.fr" sans         │
│     "/cas/login", NotiaNote détecte la connexion        │
│     réussie et extrait les cookies de session :         │
│     - CASTGC  ← Cookie principal CAS                   │
│     - JSESSIONID  ← Session ENT                        │
│     ↓                                                   │
│  5. Ces cookies sont sauvegardés de manière sécurisée   │
│     dans le téléphone via StorageHandler                │
│     ↓                                                   │
│  6. Le profil étudiant est créé localement.             │
│     Toutes les requêtes futures vers l'ENT injectent    │
│     automatiquement ces cookies dans les headers HTTP.   │
└─────────────────────────────────────────────────────────┘
```

---

## 📁 Contenu du dépôt

### `UcaWebViewModal.js` — La modale de connexion

C'est l'interface React Native qui s'affiche quand l'étudiant choisit l'UCA. Elle contient un `<WebView>` qui ouvre le vrai site de l'université.

**Points clés :**
- URL de départ : `https://ent.uca.fr/cas/login?service=https://ent.uca.fr/`
- À chaque changement d'URL (`onNavigationStateChange`), on vérifie si les cookies `CASTGC` ou `JSESSIONID` sont apparus.
- Si oui → connexion réussie → on passe les cookies au callback `onSuccess()`.
- La librairie utilisée pour lire les cookies : `@react-native-cookies/cookies`

```js
// Détection de la connexion réussie
if (navState.url.includes('ent.uca.fr') && !navState.url.includes('cas/login')) {
    const cookies = await CookieManager.get('https://ent.uca.fr');
    if (cookies && (cookies['CASTGC'] || cookies['JSESSIONID'])) {
        onSuccess({ cookies }); // ← On transmet les cookies à NotiaNote
    }
}
```

---

### `UCADriver.ts` — Le moteur de récupération de données

Une fois les cookies en main, ce fichier gère **toutes les requêtes vers l'ENT**. Il injecte les cookies dans chaque appel HTTP via les headers.

#### `fetchAPI(endpoint)` — Requête générique

Toutes les requêtes passent par cette méthode. Elle injecte les cookies automatiquement :

```ts
headers: {
    'Cookie': 'CASTGC=abc123; JSESSIONID=xyz456', // Cookies extraits de la WebView
    'User-Agent': 'NotiaNote/2.7.0 (Mobile App)',
}
```

Elle gère aussi les réponses HTML (cas fréquent dans les vieux systèmes universitaires) et les renvoie en texte brut pour parsing ultérieur.

#### `loginWithCookies(cookies)` — Création du profil étudiant

Crée un profil étudiant local dans NotiaNote au format attendu par l'`UltimateLoginEngine`. Les modules activés : notes, emploi du temps, vie scolaire.

#### `getTimetable()` — Emploi du temps (ADE Campus)

Deux méthodes tentées en cascade :
1. **API JSON** (endpoint `/api/ade/planning`) — Si l'université expose une API.
2. **Fichier ICS** (iCal) — Méthode universelle. L'université fournit souvent un lien `.ics` exportable depuis ADE Campus. Le fichier est parsé manuellement ligne par ligne.

Format iCal parsé (exemple d'un cours) :
```
BEGIN:VEVENT
SUMMARY:MATHEMATIQUES - CM
LOCATION:Amphi A
DTSTART:20260923T080000Z
DTEND:20260923T100000Z
UID:abc-123@uca.fr
END:VEVENT
```

#### `getGrades()` — Notes (Pégase / Apogée)

Appelle `/dossier-etudiant/notes`. Si la réponse est du HTML (ce qui arrive souvent avec Apogée), un parseur par regex extrait les lignes du tableau :

```ts
// Regex pour extraire <tr><td>Matière</td><td>14.5/20</td>...</tr>
const rowRegex = /<tr[^>]*>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*>([0-9.,]+)\/([0-9.,]+)<\/td>/g;
```

#### `getMoodleCourses()` — Cours Moodle

Exploite le fait que l'UCA utilise un CAS commun pour tous ses services. En ouvrant `https://moodle.uca.fr/auth/cas/login` avec les cookies CAS, Moodle connecte l'étudiant automatiquement (SSO). Ensuite, l'API interne de Moodle (`/lib/ajax/service.php`) renvoie la liste des cours de l'étudiant.

---

### `test_uca.js` — Script de test initial

Script utilisé pour comprendre et déboguer le flux d'authentification CAS. Il n'est pas utilisé en production. Il simule les redirections CAS et affiche les cookies obtenus à chaque étape.

---

## 📍 Emplacement dans NotiaNote-app

| Fichier de ce dépôt | Emplacement dans NotiaNote |
|---|---|
| `UcaWebViewModal.js` | `src/ui/auth/UcaWebViewModal.js` |
| `UCADriver.ts` | `src/core/drivers/UCADriver.ts` |

---

## 🚧 État d'avancement

| Fonctionnalité | Statut |
|---|---|
| Connexion via WebView CAS | ✅ Fonctionnel |
| Extraction des cookies (`CASTGC`) | ✅ Fonctionnel |
| Sauvegarde de la session | ✅ Fonctionnel |
| Affichage du profil dans NotiaNote | ✅ Fonctionnel |
| Emploi du temps (ADE / ICS) | 🟡 À connecter (logique prête) |
| Notes (Pégase / HTML scraping) | 🟡 À tester sur la vraie URL |
| Cours Moodle | 🟡 À tester (logique prête) |

---

## ⚠️ Points d'attention

- **Expiration des cookies** : Les cookies CAS expirent après quelques heures / jours. Il faudra gérer le re-login automatique (ou demander à l'étudiant de se reconnecter).
- **Changements du site** : Si l'UCA modifie ses URLs ou son HTML, les regex de scraping devront être mises à jour.
- **Autres universités** : Cette architecture (WebView CAS + cookies) est réutilisable pour n'importe quelle université française utilisant CAS (Shibboleth, LDAP, etc.).
