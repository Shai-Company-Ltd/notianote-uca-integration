import React, { useRef, useState, useCallback } from 'react';
import { View, StyleSheet, ActivityIndicator, Modal, TouchableOpacity, Text, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import CookieManager from '@react-native-cookies/cookies';
import { X } from 'lucide-react-native';

// This runs inside the authenticated WebView, before the ENT application
// starts its own requests.  Native fetch cannot always reuse the HttpOnly ENT
// session on iOS, while the page itself can.  Only the fields needed to create
// the local account are sent back to React Native.
const UCA_IDENTITY_HOOK = `
(() => {
    const profileKeys = {
        uid: ['sub', 'uid', 'username', 'login', 'userlogin', 'identifiant'],
        givenName: ['given_name', 'givenname', 'firstname', 'first_name', 'prenom'],
        sn: ['family_name', 'familyname', 'lastname', 'last_name', 'nom', 'sn'],
        mail: ['email', 'mail', 'courriel', 'userprincipalname'],
        displayName: ['displayname', 'display_name', 'name', 'cn'],
        photo: ['picture', 'photo', 'avatar']
    };

    const send = (identity) => {
        // A service card also has a name (for example "Covoiturage"). It
        // is not a user profile unless it contains a real identifier, email,
        // first name, or family name as well.
        if (!identity || (!identity.givenName && !identity.sn && !identity.mail && !identity.uid)) return;
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'uca-identity', identity }));
    };

    let inspectedNodes = 0;
    const inspect = (value, depth = 0) => {
        if (!value || depth > 5 || inspectedNodes++ > 1500 || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach(item => inspect(item, depth + 1));
            return;
        }

        const identity = {};
        Object.entries(value).forEach(([key, item]) => {
            if (typeof item !== 'string' || !item.trim()) return;
            const normalizedKey = key.toLowerCase();
            Object.entries(profileKeys).forEach(([field, keys]) => {
                if (keys.includes(normalizedKey)) identity[field] = item.trim();
            });
        });
        send(identity);
        Object.values(value).forEach(item => inspect(item, depth + 1));
    };

    const inspectText = (text) => {
        if (!text) return;
        try { inspect(JSON.parse(text)); } catch (_) {}
        const email = String(text).match(/[a-z0-9._%+-]+@(?:etu\\.)?uca\\.fr/i)?.[0];
        if (email) send({ mail: email, uid: email });
    };

    const originalFetch = window.fetch;
    if (originalFetch) {
        window.fetch = (...args) => originalFetch(...args).then(response => {
            const contentType = response.headers?.get('content-type') || '';
            if (/json|text|html/i.test(contentType)) {
                response.clone().text().then(inspectText).catch(() => {});
            }
            return response;
        });
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) {
        this.addEventListener('load', () => inspectText(this.responseText));
        return originalOpen.apply(this, args);
    };

    // Some portal versions put the email in their initial HTML rather than in
    // a JSON request. Others expose it through the uPortal userinfo resource.
    // These calls are made in the WebView so they use the real ENT session.
    document.addEventListener('DOMContentLoaded', () => {
        inspectText(document.documentElement.innerHTML);
        window.setTimeout(() => {
            [
                '/api/v4-0/userinfo',
                '/api/v5-0/userinfo',
                '/uPortal/api/v4-0/userinfo',
                '/uPortal/api/v5-0/userinfo',
                '/core/userinfo'
            ].forEach(url => window.fetch(url, { credentials: 'include' }).catch(() => {}));
        }, 250);

        // --- Photo extraction: runs at 300ms, 800ms, 1500ms (belt-and-suspenders) ---
        const tryFindPhoto = () => {
            // Log ALL images on the page for debugging (first run only)
            if (!window._debugImgLogged) {
                window._debugImgLogged = true;
                const allImgs = Array.from(document.querySelectorAll('img')).filter(i => i.src && i.src.length > 20);
                const imgInfo = allImgs.map(i => ({ id: i.id, className: i.className, src: i.src.substring(0, 100), w: i.naturalWidth || i.width }));
                window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'uca-debug-imgs', imgs: imgInfo }));
            }

            // Try specific UCA/uPortal selectors in priority order
            const selectors = [
                '#userImage',
                'img[id*="user" i]',
                'img[id*="avatar" i]',
                'img[id*="photo" i]',
                'img[id*="profil" i]',
                '.up-login-menu img',
                '.up-login-menu__user-image img',
                '.user-avatar img',
                '.user-avatar',
                'img.user-avatar',
                'img[class*="avatar" i]',
                'img[class*="photo" i]',
                'img[class*="profil" i]',
                'img[class*="user" i]',
                'img[alt*="photo" i]',
                'img[alt*="avatar" i]',
                'img[alt*="profil" i]',
                'img[alt*="Alexandre" i]',
                'img[alt*="Vaz" i]',
                '.sidebar img',
                '.nav-sidebar img',
                '.portlet-user img',
                'img[src*="photo"]',
                'img[src*="avatar"]',
                'img[src*="profile"]',
                'img[src*="user"]',
                'img[src*="trombinoscope"]',
                'img[src*="data:image"]',
            ];

            for (const sel of selectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.src && el.src.length > 20 && !el.src.includes('logo') && !el.src.includes('icon')) {
                        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'uca-identity', identity: { photo: el.src } }));
                        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'uca-debug-imgs', found: sel, src: el.src.substring(0, 80) }));
                        return true;
                    }
                } catch(e) {}
            }
            return false;
        };

        // Try at 300ms
        window.setTimeout(() => { if (!window._photoSentMain) window._photoSentMain = tryFindPhoto(); }, 300);
        // Retry at 800ms (for lazy-loaded images)
        window.setTimeout(() => { if (!window._photoSentMain) window._photoSentMain = tryFindPhoto(); }, 800);
        // Last retry at 1500ms
        window.setTimeout(() => { if (!window._photoSentMain) window._photoSentMain = tryFindPhoto(); }, 1500);

        // MutationObserver as safety net for dynamically injected images
        const observer = new MutationObserver(() => {
            if (!window._photoSentMain) {
                window._photoSentMain = tryFindPhoto();
                if (window._photoSentMain) observer.disconnect();
            }
        });
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

        window.setTimeout(() => {
            const page = document.documentElement.cloneNode(true);
            page.querySelectorAll('script, style, noscript').forEach(node => node.remove());
            const html = page.outerHTML.slice(0, 150000);
            window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'uca-profile-html', html }));
        }, 800);
    });
    
    // --- NOUVEAU: Capture des identifiants (mot de passe) sur la page CAS ---
    const extractAndSendCredentials = () => {
        const u = document.getElementById('username')?.value || document.querySelector('input[type="text"]')?.value;
        const p = document.getElementById('password')?.value || document.querySelector('input[type="password"]')?.value;
        if (u && p) {
            window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'uca-credentials', username: u, password: p }));
        }
    };
    
    document.addEventListener('submit', (e) => {
        extractAndSendCredentials();
    });
    
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (target.closest('button') || target.closest('input[type="submit"]') || target.closest('.btn-submit')) {
            extractAndSendCredentials();
        }
    });
})();
true;
`;

/**
 * Scraper pour la page d'accueil de l'ENT (ent.uca.fr/core/home)
 * Permet de récupérer l'URL correcte du bouton "Emploi du temps" au lieu de deviner.
 */
const HOME_SCRAPER_HOOK = `
(() => {
    const checkHome = () => {
        // Scraping du Dossier d'inscription (mail perso, classe)
        if (!window.dossierFetched) {
            window.dossierFetched = true;
            
            Promise.all([
                fetch('https://ent.uca.fr/scolarite/stylesheets/etu/adresses.faces').then(r => r.text()).catch(e => ''),
                fetch('https://ent.uca.fr/scolarite/stylesheets/etu/inscriptions.faces').then(r => r.text()).catch(e => '')
            ]).then(([adressesHtml, inscriptionsHtml]) => {
                
                const parseHtml = (html) => {
                    if (!html) return "";
                    const div = document.createElement('div');
                    div.innerHTML = html;
                    div.querySelectorAll('script, style, nav, footer').forEach(n => n.remove());
                    return div.innerText || div.textContent || '';
                };
                
                const adressesText = parseHtml(adressesHtml);
                const inscriptionsText = parseHtml(inscriptionsHtml);
                
                let photoUrl = null;
                const combinedHtml = adressesHtml + inscriptionsHtml;
                const photoMatch = combinedHtml.match(/<img[^>]+src=["']([^"']*(?:photo|avatar|trombinoscope|picture)[^"']*)['"]/i) 
                                || combinedHtml.match(/<img[^>]+id=["'](?:photo|userImage)[^"']*["'][^>]*src=["']([^"']+)['"]/i);
                if (photoMatch && photoMatch[1]) {
                    photoUrl = photoMatch[1];
                    if (photoUrl.startsWith('/')) photoUrl = 'https://ent.uca.fr' + photoUrl;
                }
                
                window.ReactNativeWebView?.postMessage(JSON.stringify({
                    type: 'uca-dossier-dump-text',
                    adressesText: adressesText.replace(/\\s+/g, ' ').slice(0, 10000),
                    inscriptionsText: inscriptionsText.replace(/\\s+/g, ' ').slice(0, 10000),
                    photoUrl: photoUrl
                }));
            });
        }

        // Chercher un lien avec le texte "Emploi du temps" ou "Agenda"
        const links = Array.from(document.querySelectorAll('a'));
        for (let i = 0; i < links.length; i++) {
            const text = (links[i].textContent || '').toLowerCase();
            if (text.includes('emploi du temps') || text.includes('agenda')) {
                const href = links[i].getAttribute('href');
                if (href && href.includes('edt.uca.fr')) {
                    window.ReactNativeWebView?.postMessage(JSON.stringify({
                        type: 'uca-edt-url',
                        url: href
                    }));
                    return true;
                }
            }
        }
        
        // Chercher un iframe widget
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (let i = 0; i < iframes.length; i++) {
            const src = iframes[i].src || '';
            if (src.includes('edt.uca.fr') || src.includes('ade')) {
                window.ReactNativeWebView?.postMessage(JSON.stringify({
                    type: 'uca-edt-url',
                    url: src
                }));
                break;
            }
        }
        
        return false;
    };

    if (window.location.href.includes('core/home')) {
        let attempts = 0;
        const interval = setInterval(() => {
            // Priority 1: Look for the URL-based high-quality menu photo
            // (e.g. https://ent.uca.fr/core/menu/photo/alvaz1) — better quality, small to store
            if (!window._photoSent) {
                const allImgs = Array.from(document.querySelectorAll('img'));
                const menuPhoto = allImgs.find(img => img.src && img.src.includes('/core/menu/photo/'));
                if (menuPhoto && menuPhoto.src) {
                    window._photoSent = true;
                    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'uca-identity', identity: { photo: menuPhoto.src } }));
                }
            }
            // Priority 2: Fall back to #userImage base64
            if (!window._photoSent) {
                const imgEl = document.getElementById('userImage');
                if (imgEl && imgEl.src && imgEl.src.length > 20) {
                    window._photoSent = true;
                    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'uca-identity', identity: { photo: imgEl.src } }));
                }
            }
            if (checkHome() || attempts > 10) {
                clearInterval(interval);
            }
            attempts++;
        }, 500);
    }
})();
true;
`;


/**
 * Script injecté dans le WebView caché ADE Campus (edt.uca.fr/direct/myplanning.jsp).
 * Extrait :
 *   1. Le lien iCal pour l'emploi du temps de l'étudiant
 *   2. La liste des matières (noms des cours uniques) affichées dans le planning
 */
const ADE_SCRAPER_HOOK = `
(() => {
    var sent = false;
    var postRN = function(obj) {
        if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify(obj));
        }
    };
    var sendDebug = function(note) {
        postRN({ type: 'ade-debug', note: note, url: window.location.href, title: document.title });
    };

    var checkHome = function() {
        if (window.location.href.includes('core/home')) {
            var links = Array.from(document.querySelectorAll('a'));
            for (var i = 0; i < links.length; i++) {
                var h = links[i].getAttribute('href') || '';
                if (h.includes('edt.uca.fr')) {
                    sendDebug("Lien EDT trouvé dans core/home, redirection...");
                    window.location.href = links[i].href;
                    return;
                }
            }
            for (var i = 0; i < links.length; i++) {
                var text = links[i].textContent || '';
                if (text.toLowerCase().includes('emploi du temps')) {
                    if (links[i].href && !links[i].href.endsWith('#')) window.location.href = links[i].href;
                    else links[i].click();
                    return;
                }
            }
        }
    };

    var allEvents = [];
    var sent = false;
    var currentWeekScrapeCount = 0;
    var MAX_WEEKS = 4;
    var lastScrapedFirstDate = null;
    
    var scrapeDOM = function() {
        if (!window.location.href.includes('edt.uca.fr')) return false;

        var dates = [];
        var currentYear = new Date().getFullYear();
        var lastFoundYear = currentYear;
        var eventsThisWeek = [];
        
        // 1. Trouver les en-têtes de colonnes (Lundi 14/09/2026 ou 14/09)
        var allDivs = document.querySelectorAll('div, td, span, b, i, button');
        for (var i = 0; i < allDivs.length; i++) {
            var text = (allDivs[i].textContent || '').trim();
            if (text.length > 0 && text.length < 40) {
                // Match DD/MM/YYYY ou DD/MM
                var match = text.match(/(\\d{2})\\/(\\d{2})(?:\\/(\\d{4}))?/);
                if (match) {
                    var rect = allDivs[i].getBoundingClientRect();
                    if (rect.width > 0 && rect.width < 400 && rect.height > 0) {
                        var year = match[3] ? match[3] : lastFoundYear;
                        lastFoundYear = year; // Mémoriser l'année pour les jours suivants sans année
                        dates.push({
                            dateStr: year + '-' + match[2] + '-' + match[1], // YYYY-MM-DD
                            left: rect.left,
                            right: rect.right,
                            width: rect.width
                        });
                    }
                }
            }
        }

        // Dédoublonner
        var uniqueDates = [];
        dates.forEach(function(d) {
            var exists = uniqueDates.find(function(ud) { 
                return ud.dateStr === d.dateStr && Math.abs(ud.left - d.left) < 20; 
            });
            if (!exists) uniqueDates.push(d);
        });

        // 2. Trouver les événements (On cherche par classe ou s'ils ont un aria-label)
        var eventNodes = document.querySelectorAll('.eventText, [aria-label]');
        for (var i = 0; i < eventNodes.length; i++) {
            var aria = eventNodes[i].getAttribute('aria-label');
            var textContent = eventNodes[i].innerText || "";
            
            // On remonte au parent si le aria-label est manquant mais que c'est bien un eventText
            if (!aria && eventNodes[i].classList.contains('eventText')) {
                aria = eventNodes[i].parentElement && eventNodes[i].parentElement.getAttribute('aria-label');
            }

            // Si on a un aria-label et que ça ressemble à un cours (contient une heure hh:mm ou hhhmm)
            if (aria && (/[0-9]{1,2}[h:][0-9]{2}/i.test(aria) || /[0-9]{1,2}[h:][0-9]{2}/i.test(textContent))) {
                if (aria.toLowerCase().includes('planning')) continue;
                
                var rect = eventNodes[i].getBoundingClientRect();
                if (rect.width > 400 || rect.height > 400) continue;
                
                var centerX = rect.left + (rect.width / 2);
                var assignedDate = null;
                var minDistance = Infinity;
                
                for (var j = 0; j < uniqueDates.length; j++) {
                    var dateCenterX = uniqueDates[j].left + (uniqueDates[j].width / 2);
                    var distance = Math.abs(centerX - dateCenterX);
                    
                    if (distance < minDistance) {
                        minDistance = distance;
                        assignedDate = uniqueDates[j].dateStr;
                    }
                }
                
                // Vérifier qu'on n'a pas déjà ajouté cet événement (pour éviter les doublons si parent+enfant)
                var alreadyAdded = eventsThisWeek.some(function(e) {
                    return e.aria === aria && Math.abs(e.left - rect.left) < 50 && Math.abs(e.top - rect.top) < 50;
                });

                if (!alreadyAdded && rect.width > 0 && rect.height > 0) {
                    eventsThisWeek.push({
                        aria: aria,
                        date: assignedDate,
                        left: rect.left,
                        top: rect.top,
                        width: rect.width,
                        height: rect.height,
                        text: textContent
                    });
                }
            }
        }
        
        if (eventsThisWeek.length > 0 || uniqueDates.length > 0) {
            // Check si on a pas juste récupéré la même semaine (page pas encore rechargée)
            var newFirstDate = uniqueDates.length > 0 ? uniqueDates[0].dateStr : null;
            if (newFirstDate && lastScrapedFirstDate === newFirstDate) {
                return false; // On attend que la page se mette à jour
            }
            if (newFirstDate) lastScrapedFirstDate = newFirstDate;
            
            allEvents = allEvents.concat(eventsThisWeek);
            return true;
        }
        return false;
    };

    var navigateToNextWeek = function() {
        // Tente d'abord les boutons semaines S38, S39 etc (souvent en bas)
        var weekBtns = Array.from(document.querySelectorAll('button, td, div')).filter(b => (b.textContent||'').trim().match(/^S\\d+$/));
        for (var i = 0; i < weekBtns.length; i++) {
            if (weekBtns[i].classList.contains('x-btn-pressed') && i + 1 < weekBtns.length) {
                weekBtns[i+1].click();
                return true;
            }
        }
        
        // Cherche les icônes 'flèche droite' ou textes de navigation
        var arrowTexts = ['>', '>>', '▶', 'suivant', 'next', 'semaine suivante'];
        var allEls = document.querySelectorAll('button, .x-btn, .x-btn-text, .x-btn-inner, td, div, span, em, img');
        for (var i = 0; i < allEls.length; i++) {
            var el = allEls[i];
            var txt = (el.textContent || '').trim().toLowerCase();
            var title = (el.getAttribute('title') || '').toLowerCase();
            var qtip = (el.getAttribute('data-qtip') || '').toLowerCase();
            
            if (arrowTexts.includes(txt) || title.includes('suivant') || title.includes('next') || qtip.includes('suivant') || qtip.includes('next')) {
                // Ignore les éléments trop gros (pour éviter de cliquer sur tout le calendrier)
                var rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.width < 150) {
                    if (el.tagName === 'IMG' && el.parentElement) el.parentElement.click();
                    else el.click();
                    return true;
                }
            }
        }
        return false;
    };

    var retryCount = 0;
    var startScrapingSequence = function() {
        if (sent) return;
        var success = scrapeDOM();
        if (success) {
            retryCount = 0; // Reset pour la prochaine semaine
            currentWeekScrapeCount++;
            sendDebug("Scraped week " + currentWeekScrapeCount);
            if (currentWeekScrapeCount < MAX_WEEKS) {
                if (navigateToNextWeek()) {
                    setTimeout(startScrapingSequence, 2000);
                    return;
                }
            }
            sent = true;
            postRN({ type: 'uca-dom-data', events: allEvents });
        } else {
            retryCount++;
            if (retryCount > 10) {
                sendDebug("Timeout waiting for next week. Stopping at week " + currentWeekScrapeCount);
                sent = true;
                postRN({ type: 'uca-dom-data', events: allEvents });
            } else {
                setTimeout(startScrapingSequence, 1000);
            }
        }
    };

    var init = function() {
        if (sent) return;
        checkHome();
        if (window.location.href.includes('edt.uca.fr/direct')) {
            sendDebug("script injected - starting visual scraper");
            setTimeout(startScrapingSequence, 3000);
            setTimeout(function() {
                if (!sent) {
                    sent = true;
                    if (allEvents.length > 0) postRN({ type: 'uca-dom-data', events: allEvents });
                    else postRN({ type: "uca-dom-dump", html: document.body.innerHTML });
                }
            }, 18000);
        } else {
            setTimeout(init, 2000);
        }
    };
    
    init();
})();
true;
`;


export default function UcaWebViewModal({ visible, onClose, onSuccess, credentials, clearCookies = false }) {
    const webviewRef = useRef(null);
    const [loading, setLoading] = useState(true);
    const successCalledRef = useRef(false);
    const lastUrlRef = useRef('');
    const identityRef = useRef(null);
    const profileHtmlRef = useRef(null);
    const completionTimerRef = useRef(null);
    const credentialsRef = useRef(null); // --- NOUVEAU: Stockage temporaire du mot de passe ---
    const [cookiesCleared, setCookiesCleared] = useState(!clearCookies);

    // --- ADE (edt.uca.fr) hidden WebView state ---
    const [adeUrl, setAdeUrl] = useState(null); // null = not started, string = loading
    const [adeVisible, setAdeVisible] = useState(false);
    const adeDataRef = useRef({ icalUrl: null, subjects: [] });
    const adeCompleteRef = useRef(false);
    
    const [zimbraUrl, setZimbraUrl] = useState('');
    const [reachedEnt, setReachedEnt] = useState(false);
    const zimbraCompleteRef = useRef(false);
    const dossierDataRef = useRef({ email: null, formation: null });

    const UCA_LOGIN_URL = 'https://ent.uca.fr/cas/login?service=https://ent.uca.fr/core/home';
    // Service URL HTTPS sans ? final → CAS génère https://edt.uca.fr/...?ticket=ST-xxx (propre)
    // http+? final générait ?&ticket= (malformé) → HTTP 500 ADE
    const ADE_PLANNING_URL = 'https://ent.uca.fr/cas/login?service=https%3A%2F%2Fedt.uca.fr%2Fdirect%2Fmyplanning.jsp';

    const isEntHomePage = (url) => {
        if (!url) return false;
        if (!url.includes('ent.uca.fr')) return false;
        if (url.includes('cas/login')) return false;
        return true;
    };

    // Track current URL during navigation
    const onNavigationStateChange = (navState) => {
        if (navState.url) lastUrlRef.current = navState.url;
    };

    const entEdtUrlRef = useRef(null);

    /**
     * Finalise la connexion : appelle onSuccess avec toutes les données collectées.
     * N'attend plus le WebView ADE/Zimbra (pris en charge nativement dans UCADriver).
     */
    const completeLogin = useCallback(async () => {
        if (successCalledRef.current) return;

        try {
            successCalledRef.current = true;
            
            // Use getAll(true) to pull all cookies directly from the WKWebView cookie store
            let cookies = await CookieManager.getAll(true);
            
            if (!cookies || Object.keys(cookies).length === 0) {
                cookies = await CookieManager.getAll();
            }

            console.log("[UCA] Finalisation (sans attente ADE/Zimbra) avec Cookies trouvés:", Object.keys(cookies || {}));

            onSuccess({
                url: lastUrlRef.current,
                cookies,
                type: 'UCA',
                identity: identityRef.current,
                profileHtml: profileHtmlRef.current,
                adeData: { edtUrl: entEdtUrlRef.current }, // Pas de lien iCal, UCADriver le cherchera
                dossierData: dossierDataRef.current,
                password: credentialsRef.current?.password
            });
        } catch (e) {
            console.error("[UCA] Erreur dans completeLogin", e);
            if (onClose) onClose();
        }
    }, [onSuccess, onClose]);


    // Extract cookies AFTER the page is fully loaded
    const onLoadEnd = useCallback(async (syntheticEvent) => {
        setLoading(false);
        const url = lastUrlRef.current || syntheticEvent?.nativeEvent?.url || '';

        if (!successCalledRef.current && isEntHomePage(url)) {
            console.log("[UCA] Page chargée sur ENT:", url);

            setReachedEnt(true);

            // Give the user 2 seconds for background requests before closing automatically
            if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
            completionTimerRef.current = setTimeout(completeLogin, 2000);
        }
    }, [completeLogin]);

    const onMessage = useCallback((event) => {
        try {
            const message = JSON.parse(event.nativeEvent.data);
            if (message?.type === 'uca-identity' && message.identity) {
                identityRef.current = { ...(identityRef.current || {}), ...message.identity };
                console.log('[UCA] Identité reçue depuis la page ENT, photo présente:', Boolean(message.identity?.photo));
            }
            if (message?.type === 'uca-debug-imgs') {
                if (message.imgs) {
                    console.log('[UCA] DEBUG - Images trouvées sur la page:', JSON.stringify(message.imgs));
                } else if (message.found) {
                    console.log('[UCA] DEBUG - Photo trouvée via sélecteur:', message.found, '| src:', message.src);
                }
            }
            if (message?.type === 'uca-profile-html' && typeof message.html === 'string') {
                profileHtmlRef.current = message.html;
            }
            if (message?.type === 'uca-edt-url' && message.url) {
                entEdtUrlRef.current = message.url;
                console.log('[UCA] Lien Emploi du temps trouvé dynamiquement:', message.url);
            }
            // --- NOUVEAU: Stockage du mot de passe ---
            if (message?.type === 'uca-credentials' && message.username && message.password) {
                console.log('[UCA] Identifiants capturés avec succès');
                credentialsRef.current = { username: message.username, password: message.password };
            }
            if (message?.type === 'uca-dossier-dump-text') {
                console.log("[UcaWebViewModal] --- DUMP ADRESSES ---");
                console.log(message.adressesText);
                console.log("[UcaWebViewModal] --- DUMP INSCRIPTIONS ---");
                console.log(message.inscriptionsText);
                // On passe le texte brut et les url, on le parsera dans UCADriver
                dossierDataRef.current = { 
                    adressesText: message.adressesText, 
                    inscriptionsText: message.inscriptionsText,
                    photoUrl: message.photoUrl
                };
            }
        } catch (_) {
            // Ignore messages emitted by the page that are unrelated to UCA.
        }
    }, []);

    /**
     * Handler pour les messages du WebView ADE caché.
     * Reçoit le lien iCal et la liste des matières.
     */
    const onADEMessage = useCallback((event) => {
        try {
            const message = JSON.parse(event.nativeEvent.data);
            if (!message) return;

            // Messages de débogage ADE (voir ce que le WebView ADE charge)
            if (message.type === 'ade-debug') {
                console.log('[UCA] ADE debug:', message.note, '| URL:', message.url, '| Titre:', message.title);
                return;
            }

            if (message?.type === 'uca-ade-data') {
                adeDataRef.current = {
                    icalUrl: message.icalUrl || null,
                    subjects: Array.isArray(message.subjects) ? message.subjects : [],
                };
                console.log(`[UCA] ADE: iCal URL = ${message.icalUrl}`);
                console.log(`[UCA] ADE: ${(message.subjects || []).length} matières récupérées`);
                adeCompleteRef.current = true;
                setAdeUrl(null); // Fermer le WebView caché

                // Finaliser la connexion maintenant qu'on a les données ADE
                if (successCalledRef.current) {
                    // completeLogin a déjà été appelé, on refire onSuccess avec les données ADE
                    Promise.all([
                        CookieManager.get('https://ent.uca.fr'),
                        CookieManager.get('https://cas.uca.fr')
                    ]).then(([entCookies, casCookies]) => {
                        const mergedCookies = { ...(entCookies || {}), ...(casCookies || {}) };
                        onSuccess({
                            url: lastUrlRef.current,
                            cookies: mergedCookies,
                            type: 'UCA',
                            identity: identityRef.current,
                            profileHtml: profileHtmlRef.current,
                            adeData: { ...adeDataRef.current, edtUrl: entEdtUrlRef.current },
                            dossierData: dossierDataRef.current,
                            password: credentialsRef.current?.password
                        });
                    }).catch(() => {});
                }
            }
        } catch (_) {
            // Ignore non-ADE messages
        }
    }, [onSuccess]);

    const onADELoadEnd = useCallback((syntheticEvent) => {
        const url = syntheticEvent?.nativeEvent?.url || '';
        console.log('[UCA] ADE WebView chargé:', url);
    }, []);

    const handleClose = () => {
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        successCalledRef.current = false;
        lastUrlRef.current = '';
        identityRef.current = null;
        profileHtmlRef.current = null;
        adeDataRef.current = { icalUrl: null, subjects: [] };
        adeCompleteRef.current = false;
        setAdeUrl(null);
        setAdeVisible(false);
        onClose();
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent={false}
            onRequestClose={handleClose}
                onShow={() => {
                    successCalledRef.current = false;
                    lastUrlRef.current = '';
                    identityRef.current = null;
                    profileHtmlRef.current = null;
                    adeDataRef.current = { icalUrl: null, subjects: [] };
                    adeCompleteRef.current = false;
                    setAdeUrl(null);
                    setAdeVisible(false);
                    
                    if (clearCookies) {
                        setCookiesCleared(false);
                        CookieManager.clearAll().then(() => {
                            setCookiesCleared(true);
                        }).catch(() => {
                            setCookiesCleared(true);
                        });
                    }
                }}
        >
            <SafeAreaView style={styles.container}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>{adeVisible ? "Configuration de l'Emploi du temps" : "Connexion UCA"}</Text>
                    <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
                        <X size={24} color="#000" />
                    </TouchableOpacity>
                </View>

                {adeVisible && (
                    <View style={styles.banner}>
                        <Text style={styles.bannerText}>
                            Veuillez trouver et cliquer sur le bouton d'export iCal (disquette, RSS, ou "Générer") pour lier votre emploi du temps.
                        </Text>
                    </View>
                )}

                {cookiesCleared ? (
                    <WebView
                        ref={webviewRef}
                        source={{ uri: UCA_LOGIN_URL }}
                        injectedJavaScriptBeforeContentLoaded={
                            UCA_IDENTITY_HOOK +
                            (credentials?.username && credentials?.password && credentials.password !== '*****' ? `
                                (() => {
                                    const checkForm = setInterval(() => {
                                        if (window.location.href.includes('cas/login')) {
                                            const u = document.getElementById('username') || document.querySelector('input[type="text"]');
                                            const p = document.getElementById('password') || document.querySelector('input[type="password"]');
                                            const btn = document.querySelector('button[type="submit"]') || document.querySelector('.btn-submit') || document.querySelector('input[type="submit"]');
                                            if (u && p && btn && !window.hasAutoFilled) {
                                                window.hasAutoFilled = true;
                                                u.value = "${credentials.username.replace(/"/g, '\\"')}";
                                                u.dispatchEvent(new Event('input', { bubbles: true }));
                                                u.dispatchEvent(new Event('change', { bubbles: true }));
                                                p.value = "${credentials.password.replace(/"/g, '\\"')}";
                                                p.dispatchEvent(new Event('input', { bubbles: true }));
                                                p.dispatchEvent(new Event('change', { bubbles: true }));
                                                setTimeout(() => btn.click(), 100);
                                                clearInterval(checkForm);
                                            }
                                        }
                                    }, 200);
                                })();
                                true;
                            ` : '')
                        }
                        injectedJavaScript={HOME_SCRAPER_HOOK}
                        onNavigationStateChange={onNavigationStateChange}
                        onLoadStart={() => setLoading(true)}
                        onLoadEnd={onLoadEnd}
                        onMessage={onMessage}
                        sharedCookiesEnabled={true}
                        thirdPartyCookiesEnabled={true}
                        originWhitelist={['*']}
                        style={(adeVisible || reachedEnt) ? styles.hidden : { flex: 1 }}
                    />
                ) : (
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="large" color="#A855F7" />
                        <Text style={{ marginTop: 10 }}>Nettoyage de l'ancienne session...</Text>
                    </View>
                )}
                {(loading || reachedEnt) && !adeVisible && !adeUrl && (
                    <View style={styles.loaderContainer}>
                        <ActivityIndicator size="large" color="#00828C" />
                        <Text style={{ marginTop: 15, fontWeight: 'bold', color: '#00828C' }}>
                            {reachedEnt ? "Connexion réussie ! Configuration..." : "Chargement..."}
                        </Text>
                    </View>
                )}

                {/* WebView caché — ADE Campus edt.uca.fr (récupère iCal + matières) */}
                {adeUrl && (
                    <View style={adeVisible ? styles.visibleWebView : styles.hiddenWebView}>
                        <WebView
                            source={{ uri: adeUrl }}
                            injectedJavaScriptBeforeContentLoaded={ADE_SCRAPER_HOOK}
                            onLoadEnd={onADELoadEnd}
                            onMessage={(event) => {
                                try {
                                    const msg = JSON.parse(event.nativeEvent.data);
                                    if (msg.type === 'uca-dom-dump') {
                                        // Auto-discover failed after 12s, show the WebView to the user
                                        setAdeVisible(true);
                                    } else {
                                        onADEMessage(event);
                                    }
                                } catch (e) {
                                    onADEMessage(event);
                                }
                            }}
                            sharedCookiesEnabled={true}
                            thirdPartyCookiesEnabled={true}
                            originWhitelist={['*']}
                            // On suit les redirections CAS automatiquement
                            // On suit les redirections CAS automatiquement
                        />
                    </View>
                )}

                {/* Hidden WebView for Zimbra to collect ZM_AUTH_TOKEN */}
                {zimbraUrl && (
                    <WebView
                        source={{ uri: zimbraUrl }}
                        sharedCookiesEnabled={true}
                        thirdPartyCookiesEnabled={true}
                        originWhitelist={['*']}
                        style={styles.hidden}
                        onLoadEnd={(e) => {
                            if (e.nativeEvent.url.includes('mail.uca.fr')) {
                                console.log("[UCA] Zimbra loaded, ZM_AUTH_TOKEN is now in cookies!");
                                zimbraCompleteRef.current = true;
                                checkAllComplete();
                            }
                        }}
                    />
                )}
            </SafeAreaView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#FFF' },
    header: { height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: '#EEE' },
    headerTitle: { fontSize: 16, fontWeight: 'bold' },
    closeBtn: { position: 'absolute', right: 15 },
    loaderContainer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF', zIndex: 10 },
    banner: { backgroundColor: '#F3E8FF', padding: 10, borderBottomWidth: 1, borderBottomColor: '#D8B4FE' },
    bannerText: { color: '#7E22CE', fontSize: 14, textAlign: 'center', fontWeight: '500' },
    hidden: { width: 0, height: 0, opacity: 0 },
    visibleWebView: { flex: 1 },
    // Le WebView ADE est complètement caché (taille nulle, hors écran)
    hiddenWebView: {
        position: 'absolute',
        top: -10000,
        left: -10000,
        width: 1200,
        height: 1000,
        opacity: 0
    },
});
