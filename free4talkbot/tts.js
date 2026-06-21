/**
 * tts.js — Text-to-Speech helper via Microsoft Edge Read Aloud API.
 * Free, no API key, neural voices, support bahasa Indonesia.
 *
 * Output: Buffer (MP3) — siap di-base64-encode dan kirim ke browser
 * untuk diputar lewat Web Audio pipeline (window._micDest).
 */
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// Voice pool buat Indonesia
const VOICES = {
    // English
    en_female: 'en-US-AvaNeural',
    en_male:   'en-US-AndrewNeural',

    // Bengali (Bangla)
    bn_female: 'bn-BD-NabanitaNeural',
    bn_male:   'bn-BD-PradeepNeural',

    // Spanish
    es_female: 'es-ES-ElviraNeural',
    es_male:   'es-ES-AlvaroNeural',

    // Indonesian
    id_female: 'id-ID-GadisNeural',
    id_male:   'id-ID-ArdiNeural',

    // Hindi
    hi_female: 'hi-IN-SwaraNeural',
    hi_male:   'hi-IN-MadhurNeural',

    // Arabic
    ar_female: 'ar-EG-SalmaNeural',
    ar_male:   'ar-EG-ShakirNeural',

    // Legacy / direct aliases
    ardi:      'id-ID-ArdiNeural',
    gadis:     'id-ID-GadisNeural',
    aria:      'en-US-AvaNeural',
    guy:       'en-US-AndrewNeural',
};

const DEFAULT_VOICE = VOICES.en_female;
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

function detectLanguage(text) {
    const lower = text.toLowerCase();

    // 1. Bengali Unicode block
    if (/[\u0980-\u09FF]/.test(text)) return 'bangla';

    // 2. Arabic Unicode block
    if (/[\u0600-\u06FF]/.test(text)) return 'arabic';

    // 3. Hindi (Devanagari) Unicode block
    if (/[\u0900-\u097F]/.test(text)) return 'hindi';

    // 4. Spanish stop words vs Indonesian
    const spanishWords = /\b(el|la|los|las|un|una|y|o|en|que|de|del|por|para|si|no|hola|cómo|gracias|soy|donde|estoy|bien|casa|amigo)\b/i;
    if (spanishWords.test(lower)) {
        const spanishMatches = (lower.match(/\b(el|la|los|las|un|una|y|o|en|que|de|del|por|para|si|no|hola|cómo|gracias|soy|donde|estoy|bien|casa|amigo)\b/g) || []).length;
        const indoMatches = (lower.match(/\b(dan|atau|di|ke|dari|ini|itu|yang|ada|bisa|saya|kamu|kita|mereka|tidak|ya|halo|apa|siapa|dimana|kabar|baik)\b/g) || []).length;
        if (spanishMatches > indoMatches) return 'spanish';
        if (indoMatches > spanishMatches) return 'indonesian';
    }

    // 5. Indonesian stop words
    const indoWords = /\b(dan|atau|di|ke|dari|ini|itu|yang|ada|bisa|saya|kamu|kita|mereka|tidak|ya|halo|apa|siapa|dimana|kabar|baik)\b/i;
    if (indoWords.test(lower)) return 'indonesian';

    return 'english';
}

// Sanitasi: buang karakter berbahaya/SSML injection.
// msedge-tts wrap input ke SSML, jadi tag XML harus di-escape.
function sanitize(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/[\x00-\x1F\x7F]/g, ' ')   // control chars
        .trim();
}

/**
 * Generate audio MP3 dari text.
 * @param {string} text - kalimat yang mau diucapkan
 * @param {object} opts - { voice?: 'ardi'|'gadis'|'aria'|'guy'|..., rate?: '0%'|'+10%'|..., pitch?: '+0Hz'|...}
 * @returns {Promise<Buffer>} MP3 buffer
 */
async function generateTTS(text, opts = {}) {
    const clean = sanitize(text);
    if (!clean) throw new Error('TTS: empty text after sanitization');

    // 1. Determine gender based on voice option (guy/male = male, otherwise female)
    const rawVoice = (opts.voice || 'aria').toLowerCase();
    const isMale = rawVoice === 'guy' || rawVoice.endsWith('_male') || rawVoice === 'ardi';
    const gender = isMale ? 'male' : 'female';

    // 2. If it's a specific exact alias in VOICES, use it directly (like 'ardi', 'gadis', etc.)
    let voice = VOICES[rawVoice];

    // 3. Otherwise, automatically detect language and choose the appropriate voice!
    if (!voice || rawVoice === 'aria' || rawVoice === 'guy') {
        let key = gender === 'male' ? 'en_male' : 'en_female';
        if (rawVoice !== 'aria' && rawVoice !== 'guy') {
            const lang = detectLanguage(clean);
            if (lang === 'bangla') key = gender === 'male' ? 'bn_male' : 'bn_female';
            else if (lang === 'spanish') key = gender === 'male' ? 'es_male' : 'es_female';
            else if (lang === 'indonesian') key = gender === 'male' ? 'id_male' : 'id_female';
            else if (lang === 'arabic') key = gender === 'male' ? 'ar_male' : 'ar_female';
            else if (lang === 'hindi') key = gender === 'male' ? 'hi_male' : 'hi_female';
        }

        voice = VOICES[key];
    }

    if (!voice) voice = DEFAULT_VOICE;

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, FORMAT);

    return await new Promise((resolve, reject) => {
        const chunks = [];
        let result;
        try {
            result = tts.toStream(clean, opts.rate || opts.pitch
                ? { rate: opts.rate || '0%', pitch: opts.pitch || '+0Hz' }
                : undefined);
        } catch (e) {
            return reject(e);
        }

        const stream = result?.audioStream;
        if (!stream) return reject(new Error('TTS: no audioStream returned'));

        const timeout = setTimeout(() => {
            stream.removeAllListeners();
            reject(new Error('TTS: stream timeout (15s)'));
        }, 15000);

        stream.on('data', chunk => chunks.push(chunk));
        stream.on('close', () => {
            clearTimeout(timeout);
            if (!chunks.length) return reject(new Error('TTS: empty buffer'));
            resolve(Buffer.concat(chunks));
        });
        stream.on('error', err => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

module.exports = {
    generateTTS,
    VOICES,
};
