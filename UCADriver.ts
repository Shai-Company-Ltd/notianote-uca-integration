// CookieManager uses CommonJS module.exports — must use require
const CookieManager = require('@react-native-cookies/cookies');
import { htmlToText } from 'html-to-text';

export default class UCADriver {
    private cookies: any;
    private baseURL: string = 'https://ent.uca.fr';

    constructor(cookies: any) {
        this.cookies = cookies;
    }

    /**
     * Génère le string de cookie pour les requêtes HTTP (fetch)
     */
    private getCookieString(): string {
        return Object.keys(this.cookies)
            .map(key => `${key}=${this.cookies[key].value || this.cookies[key]}`)
            .join('; ');
    }

    /**
     * Requete générique avec gestion des cookies et des erreurs
     */
    static async parseEcoleDirecte(title: string, id: string, url: string, body: string, success: (data: any) => Promise<any>, verbe = "post") {
        try {
            const StorageHandlerMod = require('../StorageHandler').default;
            const accounts = await StorageHandlerMod.getData("accounts") as any[];
            const account = accounts?.find(a => String(a.id) === String(id));
            if (!account) return -1;

            // Get CookieManager safely (CommonJS module)
            let cookies: any = {};
            try {
                const CM = require('@react-native-cookies/cookies');
                const cm = CM.default || CM;
                cookies = await cm.get('https://ent.uca.fr', true);
                if (!cookies || Object.keys(cookies).length === 0) {
                    cookies = await cm.get('https://ent.uca.fr');
                }
            } catch (cookieErr) {
                console.warn('[UCADriver] CookieManager.get failed:', cookieErr);
            }

            // If no cookies, session is expired — return graceful empty data
            if (!cookies || Object.keys(cookies).length === 0) {
                console.warn(`[UCADriver] No cookies found for ${title} — session expired, returning empty data`);
                if (url.includes("notes.awp")) {
                    return await success({ periodes: [] });
                }
                return await success({});
            }

            const driver = new UCADriver(cookies);
            
            if (url.includes("notes.awp")) {
                const grades = await driver.getGrades(account.odin);
                return await success(grades);
            }

            if (url.includes("emploidutemps.awp")) {
                return await success([]);
            }

            if (url.includes("messages.awp")) {
                return await success({ messages: { received: [], sent: [] } });
            }

            if (url.includes("viescolaire.awp")) {
                return await success({ absences: [], retards: [], sanctions: [], encouragements: [] });
            }

            if (url.includes("cahierdetexte")) {
                return await success({});
            }

            return await success({});
        } catch (e) {
            console.error(`[UCADriver] parseEcoleDirecte Error on ${title}:`, e);
            // Don't throw — return graceful empty data to avoid cascade crashes
            return -1;
        }
    }

    private async fetchAPI(endpoint: string, options: any = {}) {
        const url = endpoint.startsWith('http') ? endpoint : `${this.baseURL}${endpoint}`;
        const headers = {
            'User-Agent': 'NotiaNote/2.7.0 (Mobile App)',
            'Cookie': this.getCookieString(),
            'Accept': 'application/json',
            ...(options.headers || {})
        };

        try {
            const response = await fetch(url, { ...options, headers });

            if (response.status === 401 || response.status === 403) {
                throw new Error('SESSION_EXPIRED');
            }

            // Certaines API d'université renvoient du XML ou du HTML dégueulasse au lieu du JSON
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return await response.json();
            } else {
                return await response.text(); // Fallback pour parser du HTML avec Cheerio si besoin
            }
        } catch (error) {
            console.error(`[UCADriver] Erreur sur ${endpoint}:`, error);
            throw error;
        }
    }

    // ==========================================
    // 1. GESTION DE LA SESSION & COMPTE
    // ==========================================
    /**
     * Authentifie et sauvegarde le compte UCA.
     * @param cookies     Cookies CAS récupérés depuis le WebView ENT.
     * @param webViewIdentity Identité extraite par le hook JS du WebView ENT.
     * @param webViewHtml HTML de la page ENT (pour extraction d'identité fallback).
     * @param adeData     Données ADE récupérées par le WebView caché edt.uca.fr :
     *                      { icalUrl?: string, subjects?: string[] }
     */
    public static async loginWithCookies(
        cookies: any,
        webViewIdentity: any = {},
        webViewHtml = '',
        adeData: { icalUrl?: string | null; subjects?: string[] } = {},
        password?: string,
        dossierData: { adressesText?: string; inscriptionsText?: string; photoUrl?: string } = {}
    ) {
        try {
            console.log("[UCADriver] Enregistrement du compte UCA avec les cookies...");

            const cookieStr = Object.keys(cookies)
                .map((k: string) => `${k}=${cookies[k].value || cookies[k]}`)
                .join('; ');

            // The ENT API differs between UCA portal versions.  Do not rely on
            // one endpoint or on a flat JSON shape: both have changed before.
            const apiUserInfo = await UCADriver.fetchUserInfo(cookieStr);
            let dossierInfo: any = {};
            try {
                const [adressesRes, inscriptionsRes] = await Promise.all([
                    fetch('https://ent.uca.fr/scolarite/stylesheets/etu/adresses.faces', { headers: { Cookie: cookieStr } }).catch(() => null),
                    fetch('https://ent.uca.fr/scolarite/stylesheets/etu/inscriptions.faces', { headers: { Cookie: cookieStr } }).catch(() => null)
                ]);
                const htmlToTextCustom = (html: string) => {
                    return html.replace(/<[^>]*>?/gm, ' ')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'")
                        .replace(/&#233;/g, "é")
                        .replace(/&nbsp;/g, ' ');
                };

                let adressesText = '';
                let adressesHtmlStr = '';
                if (adressesRes && adressesRes.ok) {
                    adressesHtmlStr = await adressesRes.text();
                    adressesText = htmlToTextCustom(adressesHtmlStr);
                    console.log("[UCADriver] adressesText (first 500 chars):", adressesText.substring(0, 500));
                } else {
                    console.log("[UCADriver] adressesRes failed or null. Status:", adressesRes?.status);
                    if (dossierData.adressesText) adressesText = dossierData.adressesText;
                }

                let inscriptionsText = '';
                let inscriptionsHtmlStr = '';
                if (inscriptionsRes && inscriptionsRes.ok) {
                    inscriptionsHtmlStr = await inscriptionsRes.text();
                    inscriptionsText = htmlToTextCustom(inscriptionsHtmlStr);
                    console.log("[UCADriver] inscriptionsText (first 500 chars):", inscriptionsText.substring(0, 500));
                } else {
                    console.log("[UCADriver] inscriptionsRes failed or null. Status:", inscriptionsRes?.status);
                    if (dossierData.inscriptionsText) inscriptionsText = dossierData.inscriptionsText;
                }

                if (adressesText) {
                    const mailMatch = adressesText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                    if (mailMatch) {
                        const ucaMails = mailMatch.filter(m => m.toLowerCase().includes('uca.fr') || m.toLowerCase().includes('etu.uca.fr'));
                        if (ucaMails.length > 0) {
                            dossierInfo.mail = ucaMails[0];
                        } else if (mailMatch.length > 0) {
                            dossierInfo.mail = mailMatch[0];
                        }
                    }
                    const nomMatch = adressesText.match(/Nom\s*:\s*([A-Za-zÉÈÊËÀÂÄÎÏÔÖÙÛÜÇéèêëàâäîïôöùûüç\-\s]+)/i);
                    if (nomMatch) dossierInfo.sn = nomMatch[1].trim();

                    const prenomMatch = adressesText.match(/Prénom\s*:\s*([A-Za-zÉÈÊËÀÂÄÎÏÔÖÙÛÜÇéèêëàâäîïôöùûüç\-\s]+)/i);
                    if (prenomMatch) dossierInfo.givenName = prenomMatch[1].trim();
                }

                if (inscriptionsText) {
                    // La classe se trouve souvent après l'année ex: "2026/2027ZT137C421BUT1 R&T - AubièreN FR"
                    // On cherche les mots-clés typiques de formation.
                    const formationRegex = /(?:BUT1|BUT2|BUT3|L1|L2|L3|M1|M2|Licence|Master|B\.U\.T|BUT)[\s\wÀ-ÿ&.-]+/i;
                    const formationMatch = inscriptionsText.match(formationRegex);
                    if (formationMatch) {
                        dossierInfo.className = formationMatch[0].trim().substring(0, 35);
                    } else {
                        // Fallback très large
                        const fallbackMatch = inscriptionsText.match(/(?:BUT|Licence|Master|Prépa|Cycle)\s+[^\n\r]{2,30}/i);
                        if (fallbackMatch) dossierInfo.className = fallbackMatch[0].trim();
                    }

                    const etablissementMatch = inscriptionsText.match(/(?:UNIVERSITE CLERMONT AUVERGNE|Établissement\s*:\s*([^\n\r]+))/i);
                    if (etablissementMatch) {
                        dossierInfo.ou = "Université Clermont Auvergne"; // On hardcode proprement
                    }
                }

                // Tentative d'extraction de la photo de profil (Trombinoscope / Avatar)
                const combinedHtml = adressesHtmlStr + inscriptionsHtmlStr;
                const photoMatch = combinedHtml.match(/<img[^>]+src=["']([^"']*(?:photo|avatar|trombinoscope|picture)[^"']*)["']/i)
                    || combinedHtml.match(/<img[^>]+id=["'](?:photo|userImage)[^"']*["'][^>]*src=["']([^"']+)["']/i);
                if (photoMatch && photoMatch[1]) {
                    let photoUrl = photoMatch[1];
                    if (photoUrl.startsWith('/')) {
                        photoUrl = `https://ent.uca.fr${photoUrl}`;
                    }
                    console.log("[UCADriver] Photo de profil trouvée :", photoUrl);
                    dossierInfo.photo = photoUrl;
                }

                if (!dossierInfo.photo && dossierData.photoUrl) {
                    console.log("[UCADriver] Utilisation de la photo de profil du cache webview :", dossierData.photoUrl);
                    dossierInfo.photo = dossierData.photoUrl;
                }

            } catch (e) {
                console.log("[UCADriver] Erreur lors du fetch natif du dossier", e);
            }

            // Extract photo directly from the WebView identity BEFORE the merge.
            // extractIdentityFromData() discards payloads that only contain photo (no uid/name/email),
            // so we pull it out explicitly as a guaranteed fallback.
            const webViewPhotoRaw: string = webViewIdentity?.photo || "";

            const userInfo = {
                ...UCADriver.extractIdentityFromHtml(webViewHtml),
                ...apiUserInfo,
                ...dossierInfo,
                // Always restore photo from the WebView if no other source provided one
                ...(webViewPhotoRaw && !dossierInfo.photo ? { photo: webViewPhotoRaw } : {}),
                // webViewIdentity username/mail take final priority — allows re-login to preserve existing accountID
                ...UCADriver.extractIdentityFromData(webViewIdentity),
            };
            console.log("[UCADriver] Infos utilisateur (photo présente:", Boolean(userInfo.photo), ")");

            // --- PROTECTION CONTRE LA PERTE DE DONNÉES (Session expirée) ---
            const StorageHandler = require('../StorageHandler').default;
            const existingAccounts = await StorageHandler.getData("accounts") || [];
            
            // The institutional email is stable and is less ambiguous than a
            // loose HTML attribute named `uid` (which may belong to a layout
            // element rather than to the signed-in user).
            let userId = userInfo.username || userInfo.mail || userInfo.uid;
            let existingAccount;

            if (!userId) {
                // If we couldn't extract any ID, it's a failed background sync / expired session.
                // We MUST NOT create a fake 'uca_student' account. We should update the currently selected one if it's a UCA account.
                const selectedAccountId = await StorageHandler.getData("selectedAccount");
                existingAccount = existingAccounts.find((a: any) => String(a.id) === String(selectedAccountId) && a.serviceType === 'uca');
                
                if (existingAccount) {
                    userId = existingAccount.id;
                    console.warn(`[UCADriver] Session expirée / ID introuvable. Fallback sur le compte actif: ${userId}`);
                } else {
                    userId = 'uca_student';
                }
            } else {
                existingAccount = existingAccounts.find((a: any) => String(a.id) === String(userId));
            }
            
            const firstName = userInfo.givenName || UCADriver.firstNameFromIdentifier(userInfo.username || userInfo.mail || userId) || UCADriver.firstNameFromDisplayName(userInfo.displayName) || existingAccount?.prenom || 'UCA';
            const lastName = userInfo.sn || userInfo.lastName || userInfo.familyName || UCADriver.lastNameFromIdentifier(userInfo.username || userInfo.mail || userId) || existingAccount?.nom || 'Étudiant';
            const className = userInfo.className || userInfo.classe || userInfo.formation || userInfo.programme || userInfo.parcours || userInfo.groupe || existingAccount?.className || existingAccount?.profile?.classe?.libelle || '';
            const email = userInfo.mail || userInfo.email || existingAccount?.email || existingAccount?.profile?.info || "";
            const fakeToken = 'uca_token_cas';

            const savedPassword = password || "*****";

            // --- Photo: save to local file to avoid bloating AsyncStorage ---
            // SDK 54: use legacy expo-file-system API (new API uses File/Directory classes)
            let photoLocalPath = "";
            if (userInfo.photo) {
                try {
                    const FileSystem = require('expo-file-system/legacy');
                    const photoDir = `${FileSystem.documentDirectory}uca_photos/`;
                    const safeId = (userInfo.username || userInfo.mail || userId || 'uca').replace(/[^a-zA-Z0-9]/g, '_');
                    const photoPath = `${photoDir}${safeId}.png`;

                    // Check if we need to create the directory
                    const photoDirInfo = await FileSystem.getInfoAsync(photoDir);
                    if (!photoDirInfo.exists) {
                        await FileSystem.makeDirectoryAsync(photoDir, { intermediates: true });
                    }

                    if (userInfo.photo.startsWith('data:image')) {
                        // Save base64 photo to file
                        const base64Data = userInfo.photo.includes('base64,')
                            ? userInfo.photo.split('base64,')[1]
                            : userInfo.photo;
                        await FileSystem.writeAsStringAsync(photoPath, base64Data, { encoding: FileSystem.EncodingType.Base64 });
                        photoLocalPath = photoPath;
                        console.log('[UCADriver] Photo base64 sauvegardée:', photoPath);
                    } else {
                        // It's a URL (e.g. https://ent.uca.fr/core/menu/photo/alvaz1) — download it
                        const downloadResult = await FileSystem.downloadAsync(userInfo.photo, photoPath, {
                            headers: { Cookie: cookieStr }
                        });
                        if (downloadResult.status === 200) {
                            photoLocalPath = photoPath;
                            console.log('[UCADriver] Photo URL téléchargée:', photoPath);
                        } else {
                            photoLocalPath = userInfo.photo; // Fall back to URL
                        }
                    }
                } catch (photoErr: any) {
                    console.warn('[UCADriver] Failed to save photo locally:', photoErr?.message);
                    // Store URL or base64 directly as fallback
                    photoLocalPath = userInfo.photo.startsWith('data:') ? '' : userInfo.photo;
                }
            }
            // Fallback to existing photo if we couldn't fetch a new one
            if (!photoLocalPath && existingAccount?.photo) {
                photoLocalPath = existingAccount.photo;
            }

            // --- Firebase Storage Upload ---
            let cloudPhotoUrl = "";
            if (photoLocalPath) {
                try {
                    const FirebaseHandler = require('../FirebaseHandler').default;
                    cloudPhotoUrl = await FirebaseHandler.uploadProfilePicture(userId, photoLocalPath);
                } catch (e) {
                    console.log("[UCADriver] Erreur upload Firebase Storage", e);
                }
            }

            const accountData = {
                id: userId,
                idLogin: userId,
                typeCompte: "E",
                nom: lastName,
                prenom: firstName,
                identifiant: userId,
                // Store the local file path (or URL) — never store raw base64 here
                photo: photoLocalPath,
                cloudPhotoUrl: cloudPhotoUrl,
                logo: photoLocalPath,
                modules: [
                    { "code": "NOTES", "enable": true },
                    { "code": "VIE_SCOLAIRE", "enable": true },
                    { "code": "CAHIER_DE_TEXTES", "enable": false },
                    { "code": "EDT", "enable": true },
                    { "code": "MESSAGERIE", "enable": false }
                ],
                parametresIndividuels: {
                    "laccueil": true,
                    "leCahierDeTextes": false,
                    "lesNotes": true,
                    "lEmploiDuTemps": true,
                    "laVieScolaire": true,
                    "laMessagerie": false
                },
                profile: {
                    sexe: "M",
                    info: email,
                    classe: { id: 1, code: className || "UCA", libelle: className || "Non renseignée" },
                    photo: photoLocalPath
                },
                nomEtablissement: userInfo.ou || existingAccount?.nomEtablissement || "Université Clermont Auvergne",
                email: email,
                className,
                grade: className,
                anneeScolaireCourante: existingAccount?.anneeScolaireCourante || "2026-2027",
                serviceType: "uca",
                connectionToken: fakeToken,
                cookies: cookies
            };

            // Merge accountData into existingAccounts without destroying other accounts
            const accountIdx = existingAccounts.findIndex((a: any) => String(a.id) === String(userId));
            if (accountIdx >= 0) {
                existingAccounts[accountIdx] = { ...existingAccounts[accountIdx], ...accountData };
            } else {
                existingAccounts.push(accountData);
            }

            await StorageHandler.saveData("token", fakeToken);
            await StorageHandler.saveData("accounts", existingAccounts);
            await StorageHandler.saveData("selectedAccount", String(userId));
            await StorageHandler.saveData("credentials", {
                username: userId,
                password: savedPassword,
                serviceType: "uca",
                additionals: { cookies }
            });

            // Account switching looks in credentials_map first.  Keeping the
            // UCA session there prevents it from being treated as an
            // EcoleDirecte account just after the login.
            const credentialsMap = await StorageHandler.getData("credentials_map") || {};
            credentialsMap[String(userId)] = {
                username: userId,
                password: savedPassword,
                serviceType: "uca",
                token: fakeToken,
                additionals: { cookies }
            };
            await StorageHandler.saveData("credentials_map", credentialsMap);

            // --- Persistance des données ADE (EDT + Matières) ---
            // Sauvegarder le lien iCal découvert par le WebView ADE caché
            if (adeData?.edtUrl) {
                console.log("[UCADriver] Sauvegarde du lien EDT d'origine:", adeData.edtUrl);
                await StorageHandler.saveData(`uca_edt_url_${userId}`, adeData.edtUrl);
            }

            if (adeData?.icalUrl) {
                console.log("[UCADriver] Sauvegarde du lien iCal ADE:", adeData.icalUrl);
                await StorageHandler.saveData(`uca_ical_url_${userId}`, adeData.icalUrl);
            } else {
                // Tentative de découverte native si le WebView ADE n'a pas trouvé de lien
                try {
                    const discoveredUrl = await UCADriver.fetchADEIcalUrl(cookieStr, userId);
                    if (discoveredUrl) {
                        console.log("[UCADriver] Lien iCal découvert en natif:", discoveredUrl);
                        await StorageHandler.saveData(`uca_ical_url_${userId}`, discoveredUrl);
                    }
                } catch (e) {
                    console.warn("[UCADriver] Impossible de découvrir le lien iCal natif:", e);
                }
            }

            // Sauvegarder les matières récupérées depuis l'ADE
            if (adeData?.subjects && adeData.subjects.length > 0) {
                console.log(`[UCADriver] Sauvegarde de ${adeData.subjects.length} matières ADE`);
                await StorageHandler.saveData(`uca_subjects_${userId}`, adeData.subjects);
            }

            console.log("[UCADriver] Session UCA sauvegardée pour:", accountData.prenom, accountData.nom);

            // --- Firebase Authentication ---
            // Register/sign-in the UCA user            // Authentication using their personal email so that Firestore security rules are satisfied and the
            // user appears in the Firebase console.
            const userEmail = email;
            if (userEmail) {
                try {
                    const { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('@react-native-firebase/auth');
                    const auth = getAuth();

                    // Use a stable, deterministic password so we can sign in again on next launch.
                    // The password is never shown to the user and is stored in credentials_map.
                    const fbPassword = `UCA_NotiA_${userId.replace(/[^a-zA-Z0-9]/g, '_')}_2024`;

                    if (!auth.currentUser || auth.currentUser.isAnonymous) {
                        try {
                            // Try to create a new account
                            await createUserWithEmailAndPassword(auth, userEmail, fbPassword);
                            console.log('[UCADriver] Firebase: nouveau compte créé pour', userEmail);
                        } catch (createErr: any) {
                            if (createErr?.code === 'auth/email-already-in-use') {
                                // Account already exists — sign in instead
                                await signInWithEmailAndPassword(auth, userEmail, fbPassword);
                                console.log('[UCADriver] Firebase: connexion existante pour', userEmail);
                            } else {
                                throw createErr;
                            }
                        }
                    }

                    // Persist the Firebase password so we can sign in again on next app launch
                    const existingMap = await StorageHandler.getData("credentials_map") || {};
                    if (existingMap[String(userId)]) {
                        existingMap[String(userId)].firebasePassword = fbPassword;
                        await StorageHandler.saveData("credentials_map", existingMap);
                    }
                } catch (fbErr: any) {
                    // Non-blocking – app works fine without Firebase auth
                    console.warn('[UCADriver] Firebase email auth failed (non-bloquant):', fbErr?.message);
                    // Fall back to anonymous if email auth is unavailable
                    try {
                        const { getAuth, signInAnonymously } = require('@react-native-firebase/auth');
                        const auth = getAuth();
                        if (!auth.currentUser) await signInAnonymously(auth);
                    } catch (_) { }
                }
            } else {
                // No email — use anonymous auth as fallback
                try {
                    const { getAuth, signInAnonymously } = require('@react-native-firebase/auth');
                    const auth = getAuth();
                    if (!auth.currentUser) {
                        await signInAnonymously(auth);
                        console.log('[UCADriver] Firebase: connexion anonyme (pas d\'email disponible).');
                    }
                } catch (fbErr: any) {
                    console.warn('[UCADriver] Firebase anonymous sign-in failed:', fbErr?.message);
                }
            }

            return 1;
        } catch (error) {
            console.error("[UCADriver] Erreur lors de la sauvegarde du compte UCA", error);
            return 0;
        }
    }

    /**
     * Récupère les matières de l'étudiant stockées lors de la connexion.
     * @param accountId ID du compte UCA
     * @returns Tableau de noms de matières (strings), ou [] si non disponible
     */
    public static async getSubjects(accountId: string): Promise<string[]> {
        try {
            const StorageHandler = require('../StorageHandler').default;
            const subjects = await StorageHandler.getData(`uca_subjects_${accountId}`);
            return Array.isArray(subjects) ? subjects : [];
        } catch (e) {
            console.warn('[UCADriver] Impossible de lire les matières:', e);
            return [];
        }
    }

    /**
     * Tente de récupérer le lien iCal ADE depuis edt.uca.fr en natif (fetch).
     * Fonctionne uniquement si les cookies CAS ne sont pas HttpOnly ou si le
     * serveur ADE accepte les cookies de session transmis via header.
     * En cas d'échec, le lien doit être découvert via le WebView caché.
     */
    public static async fetchADEIcalUrl(cookieStr: string, accountId: string): Promise<string | null> {
        const ADEUrls = [
            'https://edt.uca.fr/direct/myplanning.jsp?',
            'https://edt.uca.fr/direct/myplanning.jsp',
        ];

        const headers = {
            'Cookie': cookieStr,
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9',
        };

        for (const url of ADEUrls) {
            try {
                const res = await fetch(url, { headers, redirect: 'follow' });
                if (!res.ok) continue;

                const html = await res.text();

                // Chercher un lien iCal dans le HTML
                const icalMatch = html.match(/href="([^"]*(?:ical|export\.ics|ical\.jsp)[^"]*)"/i)
                    || html.match(/["'](https?:\/\/[^"']*\/direct\/ical\.jsp[^"']*)["']/i)
                    || html.match(/["']([^"']*resources=[^"'&]+[^"']*)["']/i);

                if (icalMatch) {
                    let link = icalMatch[1];
                    if (!link.startsWith('http')) {
                        link = `https://edt.uca.fr${link.startsWith('/') ? '' : '/'}${link}`;
                    }
                    console.log('[UCADriver] ADE: lien iCal trouvé natif:', link);
                    return link;
                }
            } catch (e) {
                // Try next URL
            }
        }

        return null;
    }

    /**
     * Try to fetch the real user identity from the ENT portal.
     * Depending on the UCA portal version, this can be JSON, a nested JSON
     * object, or the authenticated home page containing the UCA email.
     */
    private static async fetchUserInfo(cookieStr: string): Promise<any> {
        const endpoints = [
            'https://ent.uca.fr/api/v5.0/userInfo',
            'https://ent.uca.fr/api/v5.0/userinfo',
            'https://ent.uca.fr/api/v5-0/userinfo',
            'https://ent.uca.fr/api/v4-0/userinfo',
            'https://ent.uca.fr/api/userInfo',
            'https://ent.uca.fr/api/userinfo',
            'https://ent.uca.fr/uPortal/api/v5-0/userinfo',
            'https://ent.uca.fr/uPortal/api/v4-0/userinfo',
            'https://ent.uca.fr/uPortal/api/v5-0/userinfo',
            'https://ent.uca.fr/userContext.json',
            'https://ent.uca.fr/api/v5.0/layout',
            'https://ent.uca.fr/core/home',
        ];

        const headers = {
            'Cookie': cookieStr,
            'User-Agent': 'NotiaNote/2.7.0',
            'Accept': 'application/json',
        };

        for (const url of endpoints) {
            try {
                const res = await fetch(url, { headers });
                if (!res.ok) continue;

                const contentType = res.headers.get('content-type') || '';
                const body = await res.text();
                const info = contentType.includes('json')
                    ? UCADriver.extractIdentityFromData(JSON.parse(body))
                    : UCADriver.extractIdentityFromHtml(body);

                // A layout endpoint can answer 200 without carrying the
                // identity.  Continue until we actually found one.
                if (Object.keys(info).length > 0) {
                    console.log("[UCADriver] Infos utilisateur trouvées via", url);
                    return info;
                }
            } catch (e) {
                // Try next endpoint
            }
        }

        console.warn("[UCADriver] Impossible de récupérer les infos utilisateur, profil générique utilisé.");
        return {};
    }

    /** Pick known profile fields even when the portal nests them in `user` or `data`. */
    private static extractIdentityFromData(data: any): any {
        const findValue = (keys: string[], value: any, depth = 0): any => {
            if (value === null || value === undefined || depth > 5) return undefined;
            if (Array.isArray(value)) {
                for (const item of value) {
                    const found = findValue(keys, item, depth + 1);
                    if (found !== undefined) return found;
                }
                return undefined;
            }
            if (typeof value !== 'object') return undefined;

            for (const [key, item] of Object.entries(value)) {
                if (keys.includes(key.toLowerCase()) && typeof item === 'string' && item.trim()) return item.trim();
            }
            for (const item of Object.values(value)) {
                const found = findValue(keys, item, depth + 1);
                if (found !== undefined) return found;
            }
            return undefined;
        };

        const info = {
            uid: findValue(['sub', 'uid', 'username', 'login', 'userlogin', 'identifiant'], data),
            givenName: findValue(['given_name', 'givenname', 'firstname', 'first_name', 'prenom'], data),
            sn: findValue(['family_name', 'familyname', 'lastname', 'last_name', 'nom', 'sn'], data),
            mail: findValue(['email', 'mail', 'courriel', 'userprincipalname'], data),
            ou: findValue(['organization', 'organisation', 'ou', 'establishment'], data),
            className: findValue(['classname', 'class_name', 'classe', 'formation', 'programme', 'parcours', 'filiere', 'filière', 'groupe'], data),
            displayName: findValue(['displayname', 'display_name', 'name', 'cn'], data),
            photo: findValue(['picture', 'photo', 'avatar'], data),
        };

        const identity = Object.fromEntries(Object.entries(info).filter(([, value]) => Boolean(value)));
        // A service definition can contain a `name`, but that must never be
        // interpreted as a person's name on the onboarding screen.
        if (!identity.uid && !identity.givenName && !identity.sn && !identity.mail) return {};
        return identity;
    }

    /** The authenticated ENT home page often exposes only the institutional email. */
    private static extractIdentityFromHtml(html: string): any {
        if (!html) return {};

        let text = '';
        try {
            text = htmlToText(html, {
                wordwrap: false,
                selectors: [
                    { selector: 'script', format: 'skip' },
                    { selector: 'style', format: 'skip' },
                ],
            });
        } catch (_) {
            text = html;
        }

        const source = `${html}\n${text}`;
        const email = source.match(/[a-z0-9._%+-]+@(?:etu\.)?uca\.fr/i)?.[0];
        const valueFor = (keys: string[]) => {
            const keyPattern = keys.join('|');
            const match = html.match(new RegExp(`\\b(?:data-)?(?:${keyPattern})\\b[\\s:=]+["']?([^"'<>\\s,;]+)`, 'i'));
            return match?.[1]?.trim();
        };

        const givenName = valueFor(['given[_-]?name', 'first[_-]?name', 'prenom']);
        const sn = valueFor(['family[_-]?name', 'last[_-]?name', 'nom']);
        const uid = valueFor(['uid', 'username', 'user[_-]?login', 'identifiant']);
        const className = valueFor(['class[_-]?name', 'classe', 'formation', 'programme', 'parcours', 'filiere', 'groupe'])
            || text.match(/(?:formation|filière|filiere|parcours|groupe|classe)\s*[:\-]\s*([^\n]{2,100})/i)?.[1]?.trim();
        const identity = { mail: email, username: email, givenName, sn, uid, className };

        return Object.fromEntries(Object.entries(identity).filter(([, value]) => Boolean(value)));
    }

    private static firstNameFromIdentifier(identifier: string): string {
        if (!identifier || !identifier.includes('@')) return '';
        const parts = identifier.split('@')[0].split('.');
        if (parts.length >= 2) {
            let fn = parts[0];
            return fn.charAt(0).toUpperCase() + fn.slice(1).toLowerCase();
        }
        return '';
    }

    private static lastNameFromIdentifier(identifier: string): string {
        if (!identifier || !identifier.includes('@')) return '';
        const parts = identifier.split('@')[0].split('.');
        if (parts.length >= 2) {
            let sn = parts[1].replace(/[0-9]+$/, ''); // Retire les chiffres à la fin (ex: VAZ2 -> VAZ)
            return sn.toUpperCase();
        }
        return '';
    }

    private static firstNameFromDisplayName(displayName?: string): string | undefined {
        if (!displayName) return undefined;
        const firstWord = displayName.trim().split(/\s+/)[0];
        return UCADriver.capitalizeName(firstWord);
    }

    private static capitalizeName(value?: string): string | undefined {
        if (!value || !/^[a-zÀ-ÿ'-]+$/i.test(value)) return undefined;
        return value
            .toLocaleLowerCase('fr-FR')
            .replace(/(^|['-])[a-zÀ-ÿ]/g, match => match.toLocaleUpperCase('fr-FR'));
    }


    // ==========================================
    // 2. RÉCUPÉRER L'EMPLOI DU TEMPS (Ex: ADE)
    // ==========================================
    // Les universités utilisent souvent ADE Campus. Souvent, elles fournissent un lien ICS/iCal.
    // L'idée est de récupérer le lien de l'étudiant et de parser le fichier iCal.
    public async getTimetable(startDate: string, endDate: string) {
        console.log(`[UCADriver] Fetching Timetable from ${startDate} to ${endDate}`);

        // Méthode A : API JSON (Rare mais idéal)
        try {
            const response = await this.fetchAPI(`/api/ade/planning?start=${startDate}&end=${endDate}`);
            return response.events.map((event: any) => ({
                id: event.id,
                subject: event.name,
                teacher: event.instructor || "Inconnu",
                room: event.location || "Amphi",
                startTime: event.startDateTime, // Format ISO
                endTime: event.endDateTime,
                color: '#8B5CF6',
                isCancelled: event.isCancelled || false
            }));
        } catch (e) {
            console.warn("API JSON non disponible pour l'emploi du temps, tentative de parsing ICS...");
            return this.getTimetableFromICS();
        }
    }

    /**
     * Parser un fichier ICS d'emploi du temps (Très courant en Université)
     */
    private async getTimetableFromICS() {
        // Souvent, le lien iCal de l'étudiant se trouve dans les paramètres ou via un endpoint spécifique
        const icalLink = await this.fetchAPI('/api/ade/ical-link');

        if (typeof icalLink === 'string') {
            const icalData = await fetch(icalLink).then(res => res.text());
            return this.parseICS(icalData);
        }
        return [];
    }

    private parseICS(icsString: string) {
        // C'est ici que tu mets un gros parseur pour lire le format iCal standard
        const lines = icsString.split('\n');
        const events: any[] = [];
        let currentEvent: any = null;

        lines.forEach(line => {
            line = line.trim();
            if (line === 'BEGIN:VEVENT') {
                currentEvent = {};
            } else if (line === 'END:VEVENT') {
                if (currentEvent) {
                    events.push({
                        id: currentEvent.uid,
                        subject: currentEvent.summary,
                        room: currentEvent.location,
                        startTime: this.formatIcsDate(currentEvent.dtstart),
                        endTime: this.formatIcsDate(currentEvent.dtend),
                        color: '#6366f1' // Couleur par défaut pour UCA
                    });
                }
                currentEvent = null;
            } else if (currentEvent) {
                if (line.startsWith('SUMMARY:')) currentEvent.summary = line.replace('SUMMARY:', '');
                else if (line.startsWith('LOCATION:')) currentEvent.location = line.replace('LOCATION:', '');
                else if (line.startsWith('DTSTART:')) currentEvent.dtstart = line.replace('DTSTART:', '');
                else if (line.startsWith('DTEND:')) currentEvent.dtend = line.replace('DTEND:', '');
                else if (line.startsWith('UID:')) currentEvent.uid = line.replace('UID:', '');
            }
        });
        return events;
    }

    private formatIcsDate(icsDate: string) {
        // Convertit '20260911T140000Z' en format lisible ISO
        if (!icsDate) return "";
        const year = icsDate.substring(0, 4);
        const month = icsDate.substring(4, 6);
        const day = icsDate.substring(6, 8);
        const hour = icsDate.substring(9, 11);
        const min = icsDate.substring(11, 13);
        const sec = icsDate.substring(13, 15);
        return `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
    }

    // ==========================================
    // 3. RÉCUPÉRER LES NOTES (Pegase / Apogée / ODIN)
    public async getGrades(isOdin: boolean = false) {
        console.log("[UCADriver] Fetching Grades...");
        const periodes: any[] = [];
        const notes: any[] = [];

        // 1. Try ODIN first (IUT)
        try {
            console.log("[UCADriver] Fetching ODIN Grades (IUT)...");
            const odinHTML = await this.fetchAPI('https://odin.iut.uca.fr/etudiants/?p=notes&nonclose=11');
            const odinParsed = this.scrapeOdinGradesFromHTML(odinHTML as string, "A1");
            
            if (odinParsed.disciplines.length > 0) {
                periodes.push({
                    codePeriode: "A1",
                    periode: "Année en cours (ODIN)",
                    ensembleMatieres: { disciplines: odinParsed.disciplines }
                });
                notes.push(...odinParsed.notes);
            }
        } catch (e) {
            console.log("[UCADriver] Failed to fetch ODIN:", e);
        }

        // 2. Try Apogée (Université)
        try {
            console.log("[UCADriver] Fetching Apogée Grades...");
            const apogeeRaw = await this.fetchAPI('/dossier-etudiant/notes');
            
            if (typeof apogeeRaw === 'string') {
                const apogeeParsed = this.scrapeOdinGradesFromHTML(apogeeRaw, "A2");
                if (apogeeParsed.disciplines.length > 0) {
                    periodes.push({
                        codePeriode: "A2",
                        periode: "Année (Apogée)",
                        ensembleMatieres: { disciplines: apogeeParsed.disciplines }
                    });
                    notes.push(...apogeeParsed.notes);
                }
            } else if (apogeeRaw && apogeeRaw.notes) {
                return apogeeRaw; // If backend returns clean JSON matching ED format
            }
        } catch (e) {
            console.log("[UCADriver] Failed to fetch Apogée:", e);
        }

        // Do not return an empty A1 period if both ODIN and Apogee failed or were empty.
        // Returning an empty array ensures MarksHandler does not overwrite existing cached grades.
        return { periodes, notes };
    }

    private scrapeOdinGradesFromHTML(html: string, codePeriode: string = "A1") {
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
        
        let rowMatch;
        const jsonArray: string[][] = [];

        while ((rowMatch = rowRegex.exec(html)) !== null) {
            const rowHtml = rowMatch[1];
            const cells: string[] = [];
            let cellMatch;
            while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
                // Remove inner HTML tags and decode HTML entities roughly
                let cellText = cellMatch[1].replace(/<[^>]+>/g, '').trim();
                cellText = cellText.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
                cells.push(cellText);
            }
            if (cells.length >= 6) {
                jsonArray.push(cells);
            }
        }
        
        return UCADriver.parseOdinJSONLogic(jsonArray, codePeriode);
    }

    public static parseOdinJSON(jsonArray: string[][]) {
        const parsed = UCADriver.parseOdinJSONLogic(jsonArray, "A1");
        return {
            periodes: [{
                codePeriode: "A1",
                periode: "Année en cours (ODIN)",
                ensembleMatieres: { disciplines: parsed.disciplines }
            }],
            notes: parsed.notes
        };
    }

    private static parseOdinJSONLogic(jsonArray: string[][], codePeriode: string) {
        const disciplinesMap = new Map<string, any>();
        const allNotes: any[] = [];
        let idCounter = 1;

        console.log("[UCADriver] parseOdinJSONLogic received rows:", jsonArray.length);

        jsonArray.forEach(cells => {
            if (cells.length >= 2) {
                // If it's the debug HTML fallback, log it
                if (cells[0] === "DEBUG_HTML") {
                    console.log("[UCADriver] ODIN HTML DUMP:", cells[1]);
                    return;
                }

                let subject = cells[0];
                let coeffStr = cells.length > 1 ? cells[1] : "1";
                let noteStr = cells.length > 2 ? cells[2] : "";
                let moyStr = cells.length > 3 ? cells[3] : "";
                let maxStr = cells.length > 4 ? cells[4] : "";
                let minStr = cells.length > 5 ? cells[5] : "";

                // Shift columns left if the first cell is empty (used for indentation of sub-subjects)
                if (subject.trim() === "" && cells.length > 1) {
                    subject = cells[1];
                    coeffStr = cells.length > 2 ? cells[2] : "1";
                    noteStr = cells.length > 3 ? cells[3] : "";
                    moyStr = cells.length > 4 ? cells[4] : "";
                    maxStr = cells.length > 5 ? cells[5] : "";
                    minStr = cells.length > 6 ? cells[6] : "";
                }
                
                console.log(`[UCADriver] Row parsed - Subject: ${subject}, Coef: ${coeffStr}, Note: ${noteStr}`);

                // If the second column is a number, it's likely a valid grade row
                if (/^[0-9.,]+$/.test(coeffStr) && subject.length > 2 && !subject.toLowerCase().includes("semestre")) {
                    
                    const cleanString = (str: string) => {
                        if (!str || str === '-' || str.toLowerCase() === 'abs') return "";
                        return str.replace(',', '.');
                    };

                    const noteVal = cleanString(noteStr);
                    const noteSur = "20";
                    const coef = cleanString(coeffStr);
                    const codeMatiere = subject.substring(0, 10).trim();

                    if (!disciplinesMap.has(subject)) {
                        disciplinesMap.set(subject, {
                            id: idCounter++,
                            codeMatiere: codeMatiere,
                            discipline: subject,
                            coef: parseFloat(coef) || 1,
                            notes: [] // Kept for compatibility but MarksHandler uses the flat array
                        });
                    }

                    if (noteVal !== "") {
                        const noteObj = {
                            id: idCounter++,
                            codePeriode: codePeriode,
                            codeMatiere: codeMatiere,
                            devoir: "Note ODIN",
                            valeur: noteVal,
                            noteSur: noteSur,
                            coef: coef,
                            moyenneClasse: cleanString(moyStr),
                            minClasse: cleanString(minStr),
                            maxClasse: cleanString(maxStr),
                            date: new Date().toISOString().split('T')[0],
                            nonSignificatif: false,
                            enLettre: false
                        };
                        disciplinesMap.get(subject).notes.push(noteObj);
                        allNotes.push(noteObj);
                    }
                }
            }
        });

        return {
            disciplines: Array.from(disciplinesMap.values()),
            notes: allNotes
        };
    }

    public static parseOdinAbsencesJSON(jsonArray: string[][]) {
        console.log("[UCADriver] parseOdinAbsencesJSON received rows:", jsonArray.length);
        const absences: any[] = [];
        
        jsonArray.forEach((cells, index) => {
            if (cells.length >= 2) {
                if (cells[0] === "DEBUG_HTML") return;
                
                if (cells[0] === "TEXT_DUMP") {
                    console.log("[UCADriver] TEXT_DUMP FIRST 500 CHARS:", cells[1].substring(0, 500));
                    const lines = cells[1].split('\n');
                    console.log(`[UCADriver] TEXT_DUMP split into ${lines.length} lines.`);
                    
                    let dateFound = false;
                    lines.forEach((line, lineIndex) => {
                        const joined = line.trim().toLowerCase();
                        if (joined.includes('nombre d\'absences')) return;
                        if (joined.includes('date') && joined.includes('motif')) return;
                        
                        const dateRegex = /\d{2}\/\d{2}\/\d{4}/;
                        const match = line.match(dateRegex);
                        if (match) {
                            dateFound = true;
                            const isJustifie = (joined.includes('justifié') || joined.includes('oui')) && !joined.includes('non justifié');
                            const typeElement = joined.includes('retard') ? "Retard" : "Absence";
                            const displayDate = match[0];
                            const motif = line.replace(dateRegex, '').replace(/oui|non/gi, '').trim().replace(/\t/g, ' - ').replace(/\s{2,}/g, ' - ');
                            
                            absences.push({
                                id: lineIndex + 5000,
                                typeElement: typeElement,
                                displayDate: displayDate,
                                justifie: isJustifie,
                                libelle: typeElement,
                                motif: motif
                            });
                        }
                    });

                    // If ODIN doesn't list individual dates, but gives a summary, generate dummy entries to match counts
                    if (!dateFound) {
                        const fullText = cells[1].toLowerCase();
                        const justMatch = fullText.match(/absences justifiées\s*:\s*(\d+)/);
                        const nonJustMatch = fullText.match(/absences non justifiées\s*:\s*(\d+)/);
                        
                        let justifiees = justMatch ? parseInt(justMatch[1], 10) : 0;
                        let nonJustifiees = nonJustMatch ? parseInt(nonJustMatch[1], 10) : 0;

                        const declMatch = fullText.match(/absences déclarées\s*:\s*(\d+)/);
                        if (justifiees === 0 && nonJustifiees === 0 && declMatch && parseInt(declMatch[1], 10) > 0) {
                            nonJustifiees = parseInt(declMatch[1], 10);
                        }

                        for (let i = 0; i < justifiees; i++) {
                            absences.push({
                                id: 'uca_just_' + i,
                                typeElement: 'Absence',
                                displayDate: 'Date non précisée',
                                justifie: true,
                                libelle: 'Absence',
                                motif: 'D' + "étails masqués par l'Université" // workaround syntax string
                            });
                        }
                        for (let i = 0; i < nonJustifiees; i++) {
                            absences.push({
                                id: 'uca_nonjust_' + i,
                                typeElement: 'Absence',
                                displayDate: 'Date non précisée',
                                justifie: false,
                                libelle: 'Absence',
                                motif: 'D' + "étails masqués par l'Université"
                            });
                        }
                    }
                    return;
                }
                
                const joined = cells.join(' ').toLowerCase();
                
                // Skip header rows
                if (joined.includes('nombre d\'absences')) return; // Skip the summary table
                if (joined.includes('date') && joined.includes('motif')) return;
                
                const isJustifie = (joined.includes('justifié') || joined.includes('oui')) && !joined.includes('non justifié');
                let displayDate = cells[0];
                let typeElement = "Absence";

                const dateRegex = /\d{2}\/\d{2}\/\d{4}/;
                const match = displayDate.match(dateRegex);
                let motif = "";
                
                if (match && cells.length >= 6) {
                    // ODIN format: Date | Heure | Matiere | Type (TD/TP) | Prof/Room | Statut
                    const heure = cells[1].trim();
                    const matiere = cells[2].trim();
                    const typeCours = cells[3].trim();
                    const statut = cells[5].trim();
                    
                    motif = `${heure} - ${matiere} (${typeCours}) - ${statut}`;
                } else if (!match) {
                   const anyDateMatch = joined.match(dateRegex);
                   if (anyDateMatch) displayDate = anyDateMatch[0];
                   motif = cells.join(' | '); 
                } else {
                   motif = cells.slice(1).join(' | '); 
                }

                if (joined.includes('retard')) typeElement = "Retard";

                absences.push({
                    id: index + 1000,
                    typeElement: typeElement,
                    displayDate: displayDate,
                    justifie: isJustifie,
                    libelle: typeElement,
                    motif: motif.replace(/oui|non/gi, '').trim().replace(/^\||\|$/g, '').trim()
                });
            }
        });

        const result = {
            absences: absences.filter(a => a.typeElement === "Absence"),
            retards: absences.filter(a => a.typeElement === "Retard"),
            sanctions: [],
            encouragements: []
        };
        console.log(`[UCADriver] parseOdinAbsencesJSON Returning ${result.absences.length} absences and ${result.retards.length} retards.`);
        return result;
    }

    private scrapeGradesFromHTML(html: string) {
        // Exemple de REGEX massive pour extraire les données d'un tableau HTML de notes
        const grades: any[] = [];
        // Regex pour chercher <tr><td>Matière</td><td>Note/Barème</td>...</tr>
        const rowRegex = /<tr[^>]*>[\s\S]*?<td[^>]*>(.*?)<\/td>[\s\S]*?<td[^>]*>([0-9.,]+)\/([0-9.,]+)<\/td>[\s\S]*?<\/tr>/g;

        let match;
        while ((match = rowRegex.exec(html)) !== null) {
            const subjectName = match[1].replace(/(<([^>]+)>)/gi, "").trim(); // Enlever les sous-balises HTML
            const valueStr = match[2].replace(',', '.');
            const outOfStr = match[3].replace(',', '.');

            grades.push({
                id: Math.random().toString(36).substr(2, 9),
                subject: subjectName,
                value: parseFloat(valueStr),
                outOf: parseFloat(outOfStr),
                coefficient: 1, // Souvent difficile à trouver en scraping
            });
        }
        return grades;
    }

    // ==========================================
    // 4. RÉCUPÉRER LES COURS (Moodle)
    // ==========================================
    // Moodle possède une API REST intégrée (Moodle Mobile App API).
    // Si on a les cookies UCA, on peut souvent s'auto-connecter à Moodle et utiliser l'API REST de Moodle.
    public async getMoodleCourses() {
        // Étape 1 : Toucher l'URL Moodle pour que le CAS nous loggue automatiquement dessus
        await this.fetchAPI('https://moodle.uca.fr/auth/cas/login');

        // Étape 2 : Récupérer le Moodle Token (Souvent caché dans la page web Moodle ou via une API)
        const moodleWeb = await this.fetchAPI('https://moodle.uca.fr/my/');
        const sesskeyMatch = (moodleWeb as string).match(/"sesskey":"([^"]+)"/);

        if (sesskeyMatch && sesskeyMatch[1]) {
            const sesskey = sesskeyMatch[1];

            // Étape 3 : Appeler l'API Web Service de Moodle (Ajax)
            const moodleData = await this.fetchAPI(`https://moodle.uca.fr/lib/ajax/service.php?sesskey=${sesskey}&info=core_course_get_enrolled_courses_by_timeline_classification`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{
                    index: 0,
                    methodname: "core_course_get_enrolled_courses_by_timeline_classification",
                    args: { classification: "all" }
                }])
            });

            if (moodleData && moodleData[0] && !moodleData[0].error) {
                return moodleData[0].data.courses.map((course: any) => ({
                    id: course.id,
                    name: course.fullname,
                    shortname: course.shortname,
                    url: course.viewurl,
                    image: course.courseimage
                }));
            }
        }
        return [];
    }

    // ==========================================
    // 5. ZIMBRA MESSAGERIE (UCA)
    // ==========================================
    
    public async getUCAMessages(folderId: string | number = 2) {
        try {
            console.log(`[UCADriver] Fetching messages from Zimbra for folder ${folderId}`);
            
            // In Zimbra, folderId 2 is Inbox (Reçus). We will map 0 (NotiaNote default) to 2.
            const targetFolder = (folderId === 0 || folderId === '0') ? 2 : folderId;
            const cookieString = this.getCookieString();
            
            // On essaie l'API REST Zimbra en premier ! 
            // C'est beaucoup plus rapide et stable si on a déjà le ZM_AUTH_TOKEN
            console.log("[UCADriver] Attempting Zimbra REST API first...");
            console.log("[UCADriver] cookieString length:", cookieString.length);
            console.log("[UCADriver] Has ZM_AUTH_TOKEN:", cookieString.includes('ZM_AUTH_TOKEN'));
            try {
                const restResponse = await fetch(`https://mail.uca.fr/home/~/?fmt=json&query=in:inbox`, {
                    headers: {
                        'Cookie': cookieString,
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
                    }
                });
                
                if (restResponse.ok) {
                    const restData = await restResponse.json();
                    if (restData.m) {
                        console.log("[UCADriver] REST API success! Number of messages:", restData.m.length);
                        // Copie de la logique REST existante
                        const formattedMessages = restData.m.map((m: any) => {
                            let senderName = "Inconnu";
                            let senderEmail = "";
                            if (m.e && m.e.length > 0) {
                                const fromAddress = m.e.find((e: any) => e.t === 'f') || m.e[0];
                                senderName = fromAddress.p || fromAddress.d || fromAddress.a;
                                senderEmail = fromAddress.a;
                            }
                            return {
                                id: m.id,
                                type: 'received',
                                subject: m.su || "Sans objet",
                                date: m.d ? new Date(m.d).toISOString() : "",
                                read: m.f ? !m.f.includes('u') : true,
                                motsCles: [],
                                files: [],
                                piecesJointes: m.f ? m.f.includes('a') : false,
                                hasAttachment: m.f ? m.f.includes('a') : false,
                                from: { name: senderName, role: senderEmail },
                                to: [],
                                content: m.fr ? m.fr + "..." : ""
                            };
                        });
                        
                        return {
                            status: 200,
                            data: {
                                data: {
                                    messages: { received: formattedMessages },
                                    classeurs: [{ id: 2, libelle: 'Inbox' }]
                                }
                            }
                        };
                    }
                }
            } catch (e) {
                console.log("[UCADriver] REST API first attempt failed", e);
            }

            console.log("[UCADriver] REST API failed or returned empty. Falling back to CAS fetch...");
            
            // Pour Zimbra, il faut passer par le CAS UCA.
            const casUrl = 'https://ent.uca.fr/cas/login?service=https%3A%2F%2Fmail.uca.fr%2Fzimbra%2Fpublic%2Fpreauthuca.jsp';

            // Des cookies d'autres domaines (EcoleDirecte) avec le même nom (JSESSIONID) pourraient causer des bugs.
            const filteredCookies = Object.keys(this.cookies)
                .filter(k => ['TGC', 'JSESSIONID', 'ENT'].includes(k))
                .map(key => `${key}=${this.cookies[key].value || this.cookies[key]}`)
                .join('; ');

            console.log(`[UCADriver] Sending filtered cookies:`, filteredCookies);
            
            let response = await fetch(casUrl, {
                headers: {
                    'Cookie': filteredCookies,
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
                },
                redirect: 'manual'
            });

            console.log(`[UCADriver] CAS initial fetch status: ${response.status}`);
            
            if (response.status === 302 || response.status === 301) {
                const location = response.headers.get('location');
                console.log(`[UCADriver] CAS redirected to: ${location}`);
                if (location) {
                    // Follow redirect manually and forward cookies
                    response = await fetch(location, {
                        headers: {
                            'Cookie': filteredCookies,
                            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
                        }
                    });
                    console.log(`[UCADriver] Followed redirect, status: ${response.status}, url: ${response.url}`);
                }
            } else if (response.url.includes('cas/login')) {
                console.log("[UCADriver] CAS did NOT redirect us. This means the session is likely expired or TGC is missing.");
            }
            
            const html = await response.text();
            const matchTitle = html.match(/<title>(.*?)<\/title>/);
            console.log(`[UCADriver] CAS response HTML Title: ${matchTitle ? matchTitle[1] : 'No title'}`);
            
            // La redirection mène à mail.uca.fr/zimbra/... puis retourne l'interface webmail de Zimbra.
            // On cherche le batchInfoResponse injecté par Zimbra.
            const match = html.match(/var batchInfoResponse = (\{.*?\});/s);
            if (match && match[1]) {
                console.log("[UCADriver] Found batchInfoResponse via regex");
                const batchInfo = JSON.parse(match[1]);
                const searchResponse = batchInfo?.Body?.BatchResponse?.SearchResponse;
                
                if (searchResponse && searchResponse.length > 0 && searchResponse[0].m) {
                    const rawMessages = searchResponse[0].m;
                    
                    const formattedMessages = rawMessages.map((m: any) => {
                        let senderName = "Inconnu";
                        let senderEmail = "";
                        
                        if (m.e && m.e.length > 0) {
                            const fromAddress = m.e.find((e: any) => e.t === 'f') || m.e[0];
                            senderName = fromAddress.p || fromAddress.d || fromAddress.a;
                            senderEmail = fromAddress.a;
                        }
                        
                        let dateStr = "";
                        if (m.d) {
                            dateStr = new Date(m.d).toISOString();
                        }
                        
                        return {
                            id: m.id,
                            type: targetFolder === 2 ? 'received' : 'sent',
                            subject: m.su || "Sans objet",
                            date: dateStr,
                            read: m.f ? !m.f.includes('u') : true,
                            motsCles: [],
                            files: [],
                            piecesJointes: m.f ? m.f.includes('a') : false,
                            hasAttachment: m.f ? m.f.includes('a') : false,
                            transfere: false,
                            repondu: false,
                            from: {
                                name: senderName,
                                role: senderEmail
                            },
                            to: [],
                            content: m.fr ? m.fr + "..." : ""
                        };
                    });
                    
                    const getInfo = batchInfo?.Body?.BatchResponse?.GetInfoResponse?.[0];
                    let classeurs = [];
                    if (getInfo?.folder && getInfo.folder.length > 0) {
                        const rootFolders = getInfo.folder[0].folder;
                        if (rootFolders) {
                            classeurs = rootFolders.map((f: any) => ({
                                id: parseInt(f.id),
                                libelle: f.name,
                                unread: f.n || 0,
                                nbMessages: f.s || 0 
                            }));
                        }
                    } else {
                        classeurs = [
                            { id: 2, libelle: 'Inbox' },
                            { id: 5, libelle: 'Sent' },
                            { id: 6, libelle: 'Drafts' },
                            { id: 3, libelle: 'Trash' }
                        ];
                    }
                    
                    return {
                        status: 200,
                        data: {
                            data: {
                                messages: {
                                    received: formattedMessages
                                },
                                classeurs: classeurs
                            }
                        }
                    };
                }
            }
            
            // S'il n'y a pas de batchInfoResponse (peut-être déjà logué mais pas d'inbox HTML complet)
            // On peut tenter l'API REST JSON Zimbra
            console.log("[UCADriver] Falling back to Zimbra REST API");
            const restResponse = await fetch(`https://mail.uca.fr/home/~/?fmt=json&query=in:inbox`, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'User-Agent': 'NotiaNote/2.7.0 (Mobile App)'
                }
            });
            
            console.log(`[UCADriver] REST API responded with status ${restResponse.status}`);
            
            if (restResponse.ok) {
                const restData = await restResponse.json();
                console.log("[UCADriver] REST API data received. Number of messages:", restData.m ? restData.m.length : 0);
                if (restData.m) {
                    const formattedMessages = restData.m.map((m: any) => {
                        let senderName = "Inconnu";
                        let senderEmail = "";
                        if (m.e && m.e.length > 0) {
                            const fromAddress = m.e.find((e: any) => e.t === 'f') || m.e[0];
                            senderName = fromAddress.p || fromAddress.d || fromAddress.a;
                            senderEmail = fromAddress.a;
                        }
                            return {
                                id: m.id,
                                type: 'received',
                                subject: m.su || "Sans objet",
                                date: m.d ? new Date(m.d).toISOString() : "",
                                read: m.f ? !m.f.includes('u') : true,
                                motsCles: [],
                                files: [],
                                piecesJointes: m.f ? m.f.includes('a') : false,
                                hasAttachment: m.f ? m.f.includes('a') : false,
                                from: { name: senderName, role: senderEmail },
                                to: [],
                                content: m.fr ? m.fr + "..." : ""
                            };
                    });
                    
                    return {
                        status: 200,
                        data: {
                            data: {
                                messages: { received: formattedMessages },
                                classeurs: [{ id: 2, libelle: 'Inbox' }]
                            }
                        }
                    };
                }
            }
            
            console.warn("[UCADriver] Failed to fetch Zimbra messages via both HTML and REST. HTML excerpt:", html.substring(0, 300));
            return { status: 200, data: { data: { messages: { received: [] }, classeurs: [] } } };
            
        } catch (e) {
            console.error("[UCADriver] Erreur getUCAMessages:", e);
            throw e;
        }
    }
    public async markAsRead(msgId: string) {
        try {
            console.log(`[UCADriver] Marking Zimbra message ${msgId} as read`);
            
            // Extract authToken for SOAP requests
            let authToken = "";
            if (this.cookies['ZM_AUTH_TOKEN']) {
                authToken = typeof this.cookies['ZM_AUTH_TOKEN'] === 'object' ? this.cookies['ZM_AUTH_TOKEN'].value : this.cookies['ZM_AUTH_TOKEN'];
            }
            
            const readBody = `
            <soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
                <soap:Header>
                    <context xmlns="urn:zimbra">
                        <authToken>${authToken}</authToken>
                    </context>
                </soap:Header>
                <soap:Body>
                    <ItemActionRequest xmlns="urn:zimbraMail">
                        <action id="${msgId}" op="read"/>
                    </ItemActionRequest>
                </soap:Body>
            </soap:Envelope>
            `.trim();
            
            const response = await fetch('https://mail.uca.fr/service/soap', {
                method: 'POST',
                headers: { 
                    'Cookie': this.getCookieString(),
                    'Content-Type': 'application/xml'
                },
                body: readBody
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                console.warn(`[UCADriver] markAsRead HTTP error: ${response.status}`, errorText);
            }
        } catch (e) {
            console.warn(`[UCADriver] Failed to mark as read:`, e);
        }
    }
    
    public async getUCAMessageContent(msgId: string) {
        try {
            console.log(`[UCADriver] Fetching Zimbra message content for ${msgId}`);
            const response = await fetch(`https://mail.uca.fr/home/~/?id=${msgId}&fmt=json`, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'User-Agent': 'NotiaNote/2.7.0 (Mobile App)'
                }
            });
            
            if (!response.ok) {
                throw new Error(`Zimbra returned ${response.status}`);
            }
            
            const msgData = await response.json();
            
            let htmlContent = "";
            let files: any[] = [];
            
            if (msgData.m && msgData.m.length > 0) {
                const mail = msgData.m[0];
                
                const processParts = (parts: any[]) => {
                    for (const p of parts) {
                        if (p.ct === 'text/html') {
                            htmlContent = p.content || "";
                        } else if (p.ct === 'text/plain' && !htmlContent) {
                            htmlContent = p.content ? `<p>${p.content.replace(/\n/g, '<br/>')}</p>` : "";
                        } else if (p.ct && p.ct.includes('multipart/')) {
                            if (p.mp) processParts(p.mp);
                        } else if (p.filename || (p.cd && p.cd === 'attachment')) {
                            files.push({
                                id: p.part || '1',
                                libelle: p.filename || "Pièce_jointe",
                                url: `https://mail.uca.fr/home/~/?id=${msgId}&part=${p.part}`, 
                                Zimbra: true // Flag pour MessagerieDetailsPage
                            });
                        }
                    }
                };
                
                if (mail.mp) {
                    processParts(mail.mp);
                } else if (mail.fr) {
                    htmlContent = `<p>${mail.fr.replace(/\n/g, '<br/>')}</p>`;
                }
                
                return {
                    status: 200,
                    data: {
                        data: {
                            content: htmlContent || "Aucun contenu textuel.",
                            files: files
                        }
                    }
                };
            }
            
            throw new Error("No message data returned from Zimbra");
        } catch (e) {
            console.error("[UCADriver] Erreur getUCAMessageContent:", e);
            throw e;
        }
    }
}
