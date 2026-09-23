import React, { useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, Modal, TouchableOpacity, Text, SafeAreaView } from 'react-native';
import { WebView } from 'react-native-webview';
import CookieManager from '@react-native-cookies/cookies';
import { X } from 'lucide-react-native';

export default function UcaWebViewModal({ visible, onClose, onSuccess }) {
    const webviewRef = useRef(null);
    const [loading, setLoading] = useState(true);

    const UCA_LOGIN_URL = 'https://ent.uca.fr/cas/login?service=https://ent.uca.fr/';

    const onNavigationStateChange = async (navState) => {
        if (navState.url.includes('ent.uca.fr') && !navState.url.includes('cas/login')) {
            console.log("Connecté à l'ENT ! Extraction des cookies...");
            
            const cookies = await CookieManager.get('https://uca.fr') || await CookieManager.get('https://ent.uca.fr');
            
            if (cookies && (cookies['CASTGC'] || cookies['JSESSIONID'] || cookies['ENT'])) {
                onSuccess({
                    url: navState.url,
                    cookies: cookies,
                    type: 'UCA'
                });
            }
        }
    };

    return (
        <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
            <SafeAreaView style={styles.container}>
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>Connexion UCA</Text>
                    <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                        <X size={24} color="#000" />
                    </TouchableOpacity>
                </View>
                <WebView
                    ref={webviewRef}
                    source={{ uri: UCA_LOGIN_URL }}
                    onNavigationStateChange={onNavigationStateChange}
                    onLoadEnd={() => setLoading(false)}
                    sharedCookiesEnabled={true}
                    thirdPartyCookiesEnabled={true}
                />
                {loading && <ActivityIndicator size="large" color="#A855F7" style={styles.loader} />}
            </SafeAreaView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#FFF' },
    header: { height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: '#EEE' },
    headerTitle: { fontSize: 16, fontWeight: 'bold' },
    closeBtn: { position: 'absolute', right: 15 },
    loader: { position: 'absolute', top: '50%', left: '50%', transform: [{ translateX: -15 }, { translateY: -15 }] }
});
