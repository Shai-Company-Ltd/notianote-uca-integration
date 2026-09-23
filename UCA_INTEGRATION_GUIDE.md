# Intégration de l'Université Côte d'Azur (UCA) dans NotiaNote

Ce dossier contient l'ensemble du travail de recherche et d'implémentation pour l'intégration de la connexion CAS (Central Authentication Service) de l'Université Côte d'Azur (UCA) dans l'application mobile NotiaNote.

## 📁 Contenu de ce dossier

1. **`UCADriver.ts`** : Le moteur principal ("Driver") pour communiquer avec l'ENT de l'université.
2. **`UcaWebViewModal.js`** : L'interface (Modale) qui s'affiche au-dessus de l'application pour gérer la connexion via le site web de l'UCA.
3. **`test_uca.js`** : Un script de test autonome utilisé initialement pour comprendre le flux complexe de l'authentification CAS de l'UCA.

---

## 🏗️ Architecture et Fonctionnement

La sécurité de l'UCA et de son système CAS avec double authentification empêchait d'utiliser une simple requête HTTP (comme on le ferait via axios en arrière-plan). La seule manière viable et sécurisée de récupérer l'accès est la méthode dite **WebView + Extraction de cookies**.

### 1. La Modale WebView (`UcaWebViewModal.js`)
**Emplacement dans NotiaNote :** `NotiaNote-app/src/ui/auth/UcaWebViewModal.js`

- **Fonctionnement :** C'est une modale plein écran contenant un navigateur intégré (`react-native-webview`). L'étudiant est invité à se connecter avec son vrai mot de passe et à valider sa double authentification depuis le vrai site de l'université (`https://ent.uca.fr/cas/login`).
- **Extraction :** Chaque fois que l'URL change dans ce navigateur, la modale utilise la librairie `@react-native-cookies/cookies` pour vérifier si le cookie `CASTGC` ou `JSESSIONID` a été généré. Dès qu'un de ces cookies apparaît, cela signifie que la connexion est un succès.
- **Action finale :** La modale intercepte les cookies et appelle la fonction `onSuccess(cookies)`.

### 2. Le Moteur (`UCADriver.ts`)
**Emplacement dans NotiaNote :** `NotiaNote-app/src/core/drivers/UCADriver.ts`

- **Sauvegarde de la session :** Une fois les cookies récupérés par la modale, le driver crée un faux profil étudiant temporaire (avec tous les paramètres standards attendus par NotiaNote) et sauvegarde ces cookies de manière sécurisée dans `StorageHandler`.
- **Requêtes HTTP :** Le Driver contient la logique nécessaire pour "injecter" ces cookies dans chaque requête `fetch()` future vers les API de l'université (`fetchAPI()`).

### 3. L'Écran d'Accueil (`WelcomeScreen.js`)
**Emplacement dans NotiaNote :** `NotiaNote-app/src/ui/auth/WelcomeScreen.js`

Des modifications clés ont été apportées au fichier `WelcomeScreen.js` pour relier le tout :

1. **Le bouton UCA :** Ajout de la logique conditionnelle :
   ```javascript
   (activeCategory === 'universitaire' && selectedService !== 'uca')
   ```
   Cela permet d'empêcher l'affichage du formulaire classique (Identifiant / Mot de passe) dès lors que l'utilisateur sélectionne l'UCA, pour afficher à la place un bouton spécifique **"Se connecter au portail CAS"**.

2. **L'appel de la Modale :** Le bouton change la variable d'état `webViewService` à `'uca'`, ce qui affiche la modale `UcaWebViewModal`.
3. **Le callback onSuccess :** Une fois la modale fermée avec succès, l'écran de bienvenue appelle `UCADriver.loginWithCookies(data.cookies)`. Si le succès est validé par le driver, il appelle `setIsLoggedIn(true)` pour finaliser la connexion et rediriger l'utilisateur vers la page d'accueil de l'application.

## 🚀 Prochaines étapes de développement

Lorsque le projet reprendra :

1. L'application réussit déjà à extraire les cookies et générer le profil.
2. Il faudra implémenter la récupération réelle de l'emploi du temps. La méthode est déjà initiée dans `UCADriver.ts` avec la fonction `getTimetableFromICS()` qui devra pointer vers le lien d'export iCal (ADE Campus) de l'étudiant.
3. Il faudra configurer le moteur `HomePage.js` et les Handlers pour utiliser `UCADriver` si `currentAccount.serviceType === 'uca'`.
