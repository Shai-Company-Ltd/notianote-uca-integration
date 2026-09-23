const axios = require('axios');

async function testCASLogin() {
    console.log("1. Récupération de la page de login CAS...");
    
    // Variables pour stocker les cookies
    let jsessionid = '';
    let castgc = '';

    try {
        const getResp = await axios.get('https://ent.uca.fr/cas/login?service=https://ent.uca.fr/');
        
        // Extraction de tous les champs cachés du formulaire
        const inputRegex = /<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g;
        let match;
        const hiddenParams = new URLSearchParams();
        while ((match = inputRegex.exec(getResp.data)) !== null) {
            hiddenParams.append(match[1], match[2]);
        }
        
        console.log("✅ Champs cachés :", hiddenParams.toString());

        // Extraction des cookies (pas seulement JSESSIONID)
        const getSetCookie = getResp.headers['set-cookie'];
        let cookieHeader = '';
        if (getSetCookie) {
            cookieHeader = getSetCookie.map(c => c.split(';')[0]).join('; ');
        }
        console.log("✅ Cookies de session :", cookieHeader);

        console.log("\n2. Envoi des identifiants (POST)...");
        const params = hiddenParams; // Start with hidden params
        params.append('username', 'VOTRE_IDENTIFIANT');
        params.append('password', 'VOTRE_MOT_DE_PASSE');

        // Configuration pour ne pas suivre automatiquement la redirection 302
        const postResp = await axios.post('https://ent.uca.fr/cas/login?service=https://ent.uca.fr/', params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': jsessionid,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status <= 302
        });
        
        if (postResp.status === 302) {
            console.log("✅ Connexion réussie ! Redirection 302 détectée.");
            console.log("URL de redirection (Ticket) :", postResp.headers.location);
            
            // Extraction du CASTGC
            const postSetCookie = postResp.headers['set-cookie'];
            if (postSetCookie) {
                postSetCookie.forEach(cookieStr => {
                    if (cookieStr.includes('CASTGC')) {
                        castgc = cookieStr.split(';')[0];
                    }
                });
            }
            console.log("✅ CASTGC (Ticket Granting Cookie) :", castgc);
            
            console.log("\n3. Validation du ticket sur l'ENT...");
            // Suivre la redirection pour finaliser la connexion sur l'ENT et récupérer les cookies de session ENT
            const entResp = await axios.get(postResp.headers.location, {
                headers: {
                    'Cookie': castgc ? `${jsessionid}; ${castgc}` : jsessionid,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                maxRedirects: 5
            });
            
            console.log("Status ENT:", entResp.status);
            console.log("On est maintenant authentifié sur l'ENT !");
            
            // Vous pouvez maintenant appeler les API de l'ENT
            /*
            const profileResp = await axios.get('https://ent.uca.fr/api/user/profile', {
                 headers: { 'Cookie': ... } // Mettre les bons cookies de l'ENT
            });
            console.log("Profile:", profileResp.data);
            */

        } else {
            console.error("❌ Échec de la connexion. Statut HTTP :", postResp.status);
            // On essaie de voir s'il y a un message d'erreur dans le HTML
            const { convert } = require('html-to-text');
            const text = convert(postResp.data, { wordwrap: 130 });
            console.log("=== CONTENU DE LA PAGE RETOURNÉE ===");
            console.log(text.substring(0, 1000)); // Print first 1000 chars of the page text
            console.log("====================================");
        }
        
    } catch (e) {
        console.error("❌ Erreur inattendue :", e.message);
        if (e.response) {
            console.error("Status de l'erreur :", e.response.status);
            const { convert } = require('html-to-text');
            const text = convert(e.response.data, { wordwrap: 130 });
            console.log("=== CONTENU ERREUR ===");
            console.log(text.substring(0, 500));
        }
    }
}

testCASLogin();
