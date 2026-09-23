import CookieManager from '@react-native-cookies/cookies';

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
            .map(key => `${key}=${this.cookies[key].value}`)
            .join('; ');
    }

    /**
     * Requete générique avec gestion des cookies et des erreurs
     */
    private async fetchAPI(endpoint: string, options: any = {}) {
        const url = `${this.baseURL}${endpoint}`;
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
    public static async loginWithCookies(cookies: any) {
        try {
            console.log("[UCADriver] Enregistrement du compte UCA avec les cookies...");
            
            // Pour l'instant, on utilise un ID temporaire ou on extrait l'ID si dispo dans les cookies
            const userId = cookies['CASTGC'] ? 'uca_user' : 'uca_student';
            const fakeToken = 'uca_token_cas'; // Not really used but needed for structure

            const accountData = {
                id: userId,
                idLogin: userId,
                typeCompte: "E", // Eleve / Etudiant
                nom: "Étudiant",
                prenom: "UCA",
                identifiant: userId,
                logo: "",
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
                    info: "",
                    classe: { id: 1, code: "UCA", libelle: "UCA" },
                    photo: ""
                },
                nomEtablissement: "Université Clermont Auvergne",
                email: "",
                anneeScolaireCourante: "2026-2027",
                serviceType: "uca",
                connectionToken: fakeToken,
                cookies: cookies // ON SAUVEGARDE LES COOKIES ICI
            };

            const StorageHandler = require('../StorageHandler').default;
            
            await StorageHandler.saveData("token", fakeToken);
            await StorageHandler.saveData("accounts", [accountData]);
            await StorageHandler.saveData("selectedAccount", String(userId));
            await StorageHandler.saveData("credentials", {
                username: userId,
                password: "*****",
                serviceType: "uca",
                additionals: {
                    cookies: cookies
                }
            });

            console.log("[UCADriver] Session UCA sauvegardée !");
            return 1;
        } catch (error) {
            console.error("[UCADriver] Erreur lors de la sauvegarde du compte UCA", error);
            return 0;
        }
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
        const year = icsDate.substring(0,4);
        const month = icsDate.substring(4,6);
        const day = icsDate.substring(6,8);
        const hour = icsDate.substring(9,11);
        const min = icsDate.substring(11,13);
        const sec = icsDate.substring(13,15);
        return `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
    }

    // ==========================================
    // 3. RÉCUPÉRER LES NOTES (Pegase / Apogée)
    // ==========================================
    public async getGrades() {
        console.log("[UCADriver] Fetching Grades...");
        // Beaucoup d'universités utilisent un backend Apogée qui renvoie de l'HTML.
        // Si c'est le cas, fetchAPI renverra du texte qu'il faut scraper (par ex: avec Regex ou Cheerio)
        
        const rawHTML = await this.fetchAPI('/dossier-etudiant/notes');
        
        if (typeof rawHTML === 'string') {
            // C'est du HTML, on doit le scraper !
            return this.scrapeGradesFromHTML(rawHTML);
        } else {
            // C'est du JSON !
            return rawHTML.notes.map((n: any) => ({
                id: n.id,
                subject: n.matiere,
                value: parseFloat(n.valeur),
                outOf: parseFloat(n.bareme),
                coefficient: parseFloat(n.coef || 1),
                date: n.dateSaisie
            }));
        }
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
}
