// server.js — no Express/HTTP server (manager.js handles all UI via IPC)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const yts = require('yt-search');
const { askAI, generateOnce, parseCommandFromAI } = require('./ai.js');
const { generateTTS } = require('./tts.js');
const { handlePeerUtterance, getVoiceStatus } = require('./voice.js');

// ── yt-dlp: stream URL + local audio cache (local = smooth, no DASH stutter) ──
const _streamUrlCache = new Map();  // videoUrl → { url, fetchedAt }
const _localAudioCache = new Map(); // videoUrl → { path, fetchedAt }
const STREAM_CACHE_TTL = 4 * 60 * 60 * 1000;
const LOCAL_AUDIO_TTL  = 6 * 60 * 60 * 1000;
const _pendingFetches = new Map();
const _pendingDownloads = new Map();
const AUDIO_CACHE_DIR = path.join(os.tmpdir(), 'f4tbot-audio');

function ytdlpPath() {
    return path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
}

function pathToFileUrl(filePath) {
    return 'file:///' + filePath.replace(/\\/g, '/');
}

async function getStreamUrl(videoUrl) {
    const cached = _streamUrlCache.get(videoUrl);
    if (cached && Date.now() - cached.fetchedAt < STREAM_CACHE_TTL) {
        console.log(`[MUSIC] Cache hit: ${videoUrl.slice(-20)}`);
        return cached.url;
    }

    if (_pendingFetches.has(videoUrl)) {
        console.log(`[MUSIC] Dedup — waiting for pending fetch: ${videoUrl.slice(-20)}`);
        return _pendingFetches.get(videoUrl);
    }

    const fetchPromise = (async () => {
        try {
            const { stdout } = await execFileAsync(ytdlpPath(), [
                // Prefer progressive muxed stream (18) — HTML5 audio handles it better than DASH fragments
                '-f', '18/ba[ext=m4a][protocol^=http]/ba/bestaudio[ext=m4a]/bestaudio/best',
                '--get-url',
                '--no-playlist',
                '--no-warnings',
                '--socket-timeout', '30',
                '--retries', '3',
                '--extractor-args', 'youtube:player-client=android,web',
                videoUrl
            ]);
            const url = stdout.trim().split('\n').find(l => l.startsWith('http'));
            if (!url) throw new Error('yt-dlp returned no valid URL');
            _streamUrlCache.set(videoUrl, { url, fetchedAt: Date.now() });
            return url;
        } finally {
            _pendingFetches.delete(videoUrl);
        }
    })();

    _pendingFetches.set(videoUrl, fetchPromise);
    return fetchPromise;
}

/** Download audio to disk — eliminates DASH stutter in WebRTC mic pipeline */
async function ensureLocalAudio(videoUrl) {
    const cached = _localAudioCache.get(videoUrl);
    if (cached && fs.existsSync(cached.path) && Date.now() - cached.fetchedAt < LOCAL_AUDIO_TTL) {
        return cached.path;
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) return null;

    fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
    const existing = fs.readdirSync(AUDIO_CACHE_DIR).find(f => f.startsWith(videoId + '.'));
    if (existing) {
        const full = path.join(AUDIO_CACHE_DIR, existing);
        _localAudioCache.set(videoUrl, { path: full, fetchedAt: Date.now() });
        return full;
    }

    if (_pendingDownloads.has(videoUrl)) {
        return _pendingDownloads.get(videoUrl);
    }

    const dlPromise = (async () => {
        try {
            const outBase = path.join(AUDIO_CACHE_DIR, videoId);
            await execFileAsync(ytdlpPath(), [
                '-f', 'bestaudio[ext=m4a]/bestaudio/best',
                '-x', '--audio-format', 'm4a',
                '-o', `${outBase}.%(ext)s`,
                '--no-playlist',
                '--no-part',
                '--force-overwrites',
                '--socket-timeout', '45',
                '--retries', '3',
                '--extractor-args', 'youtube:player-client=android,web',
                videoUrl
            ], { timeout: 120000 });
            const file = fs.readdirSync(AUDIO_CACHE_DIR).find(f => f.startsWith(videoId + '.'));
            if (!file) throw new Error('download produced no file');
            const fullPath = path.join(AUDIO_CACHE_DIR, file);
            _localAudioCache.set(videoUrl, { path: fullPath, fetchedAt: Date.now() });
            return fullPath;
        } finally {
            _pendingDownloads.delete(videoUrl);
        }
    })();

    _pendingDownloads.set(videoUrl, dlPromise);
    return dlPromise;
}

/** Best playback source: cached local file (smooth), download if needed, stream fallback */
async function resolvePlaybackSource(videoUrl) {
    const videoId = extractVideoId(videoUrl);
    if (videoId && fs.existsSync(AUDIO_CACHE_DIR)) {
        const hit = fs.readdirSync(AUDIO_CACHE_DIR).find(f => f.startsWith(videoId + '.'));
        if (hit) {
            const full = path.join(AUDIO_CACHE_DIR, hit);
            _localAudioCache.set(videoUrl, { path: full, fetchedAt: Date.now() });
            return { type: 'file', src: pathToFileUrl(full) };
        }
    }

    try {
        const localPath = await ensureLocalAudio(videoUrl);
        if (localPath) return { type: 'file', src: pathToFileUrl(localPath) };
    } catch (e) {
        console.warn(`[MUSIC] Local download failed, falling back to stream: ${e.message}`);
    }

    const url = await getStreamUrl(videoUrl);
    return { type: 'url', src: url };
}

function preFetchNextSong() {
    if (botState.queue.length > 0) {
        const next = botState.queue[0];
        if (next?.url && !_pendingDownloads.has(next.url)) {
            console.log(`[MUSIC] Pre-fetching next song: ${next.title}`);
            ensureLocalAudio(next.url).catch(() => { });
        }
    }
}



// ── Static role config (roles.json) — hot-reloaded on change ────────────────────
const ROLES_PATH = path.join(__dirname, 'roles.json');
let staticRoles = { owners: [], coOwners: [], moderators: [], admins: [] };
function loadRoles() {
    try {
        staticRoles = JSON.parse(fs.readFileSync(ROLES_PATH, 'utf8'));
        console.log(`[ROLES] Loaded: ${staticRoles.owners?.length || 0} owners, ${staticRoles.moderators?.length || 0} mods`);
    } catch (_) { }
}
loadRoles();
fs.watchFile(ROLES_PATH, () => { loadRoles(); applyStaticRoles(); });

/** Apply staticRoles to participantDetails (call after roles.json changes or after participants load) */
function applyStaticRoles() {
    const map = [
        ['Owner', staticRoles.owners || []],
        ['Co-owner', staticRoles.coOwners || []],
        ['Moderator', staticRoles.moderators || []],
        ['Admin', staticRoles.admins || []],
    ];
    for (const [role, uids] of map) {
        for (const uid of uids) {
            const existing = participantDetails.get(uid) || { name: uid };
            participantDetails.set(uid, { ...existing, role });
        }
    }
    updateParticipants();
}

// ── IPC: terima perintah dari manager.js via process.send() ──────────────

// ── Bot runtime state ────────────────────────────────────────────────────────
let browser = null;
let context = null;
let page = null;
let botState = {
    status: 'OFFLINE',
    currentSong: null,
    queue: [],
    searchResults: [],
    isPlaying: false,
    isRepeating: false,
    volume: 10,
    botName: 'Past',
    participants: [],  // [{uid, name, role}] — real-time room list
    aiMuteUntil: 0,   // timestamp ms; 0 = AI aktif, >now = AI di-mute (set via !ai off/sleep)
    voiceListenActive: true,  // Voice conversation mode (wake word listen via Groq STT)
    voiceAI: false,
    voiceAIVoice: 'guy',
    voiceAIPitch: '-5Hz',
    voiceAIRate: '-5%',
    autoPlay: true,    // Auto play related songs when queue is empty
    playHistory: []    // History of played songs to prevent autoplay from repeating
};

// ── Hot-reload commands.js ───────────────────────────────────────────────────
let commandHandler = require('./commands.js');
fs.watchFile(path.join(__dirname, 'commands.js'), () => {
    try {
        delete require.cache[require.resolve('./commands.js')];
        commandHandler = require('./commands.js');
        log('Commands reloaded!', 'success');
    } catch (e) {
        log('Failed to reload commands: ' + e.message, 'error');
    }
});

// ── Logging ──────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false }).replace(/\./g, '.');
    // Kirim via IPC ke manager (untuk dashboard broadcast)
    if (process.send) process.send({ type: 'bot-log', time, msg, level: type });
    console.log(`[${time}] [${type}] ${msg}`);
}
function updateStatus() {
    if (process.send) process.send({ type: 'bot-status', state: botState });
}

function updateParticipants() {
    botState.participants = [...participantDetails.entries()].map(([uid, d]) => ({
        uid, name: d.name || uid, role: d.role || 'Member'
    }));
    updateStatus();
    // Trigger auto-leave check setiap kali participant list berubah
    checkEmptyRoom();
}

// ── Auto-leave: keluar jika room kosong selama AUTO_LEAVE_SEC detik ──────────
const AUTO_LEAVE_SEC = 30;
let emptyRoomTimer = null;

function checkEmptyRoom() {
    return; // Disabled: Keep the bot online 24/7 (never auto-leave empty rooms)
    if (botState.status !== 'ONLINE') return;
    // Hitung peserta selain bot sendiri
    const others = botState.participants.filter(p => p.uid !== botMyId);
    if (others.length === 0) {
        if (!emptyRoomTimer) {
            log(`[AUTO-LEAVE] Room kosong — akan keluar dalam ${AUTO_LEAVE_SEC} detik...`, 'warn');
            emptyRoomTimer = setTimeout(() => {
                leaveRoom('Room kosong selama ' + AUTO_LEAVE_SEC + ' detik.');
            }, AUTO_LEAVE_SEC * 1000);
        }
    } else {
        // Ada orang → batalkan timer
        if (emptyRoomTimer) {
            clearTimeout(emptyRoomTimer);
            emptyRoomTimer = null;
            log('[AUTO-LEAVE] Timer cancelled — participant joined.', 'info');
        }
    }
}

// Ref ke sendMessage dan scanDomForOwner — diset saat bot start
let _sendMessage = null;
let _scanDomForOwner = null;
let _resolveWsReady = null;  // resolve saat WS room confirm pertama
let _domScanInterval = null;  // ID interval DOM scan — di-clear saat bot stop
let _participantsInitialized = false;

async function leaveRoom(reason = 'Keluar room.') {
    log(`[AUTO-LEAVE] ${reason}`, 'warn');
    clearTimeout(emptyRoomTimer);
    emptyRoomTimer = null;

    // Stop DOM scan interval supaya tidak error setelah context ditutup
    if (_domScanInterval) { clearInterval(_domScanInterval); _domScanInterval = null; }
    _scanDomForOwner = null;

    try { if (_sendMessage) await _sendMessage(`👋 Bot keluar: ${reason}`); } catch (_) { }
    await new Promise(r => setTimeout(r, 1500));
    if (context) { try { await context.close(); } catch (_) { } }
    if (browser) { try { await browser.close(); } catch (_) { } }
    browser = null;
    context = null;
    page = null;
    botJwk = null;
    botMyId = null;
    participantDetails.clear();
    participantsCache.clear();
    botState.status = 'OFFLINE';
    botState.participants = [];
    botState.currentSong = null;
    botState.queue = [];
    botState.isPlaying = false;
    _participantsInitialized = false;
    updateStatus();
    log('Bot offline. Process will exit in 2 seconds.', 'info');

    // Exit process — manager akan detect dan mark STOPPED
    setTimeout(() => process.exit(0), 2000);
}

// ── Anti-loop guard ──────────────────────────────────────────────────────────
const sentMessages = new Set();
let botLastSentAt = 0;
const BOT_SEND_COOLDOWN = 8000;          // ms
const BOT_OWN_NAMES = ['Hello World', 'GicellBot', 'riyan', 'rj'];

// Bot identity (for Option 3 direct send)
let botJwk = null;   // { x, y, d } dari JWK keypair
let botMyId = null;   // uid bot di Free4Talk

// AI mutex
let isAIProcessing = false;

function normalizeMsg(text) {
    return text
        .replace(/[`*_~|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 150);
}

// ── Participants cache ────────────────────────────────────────────────────────
const participantsCache = new Map(); // name.toLowerCase() → uid
const participantDetails = new Map(); // uid → { name, role }
const msgSeenKeys = new Set(); // dedup

// ── Voice: WebRTC trackId → participant name mapping ─────────────────────────
// Diisi via __onTrackJoined (best-effort: nama participant yang baru join
// dikorelasikan ke track yang baru muncul dalam 3s window)
const _trackParticipantNames = new Map();

/** Lookup clean name by uid */
function nameOf(uid) {
    return participantDetails.get(uid)?.name || uid || 'Unknown';
}
/** Lookup role by uid */
function roleOf(uid) {
    return participantDetails.get(uid)?.role || 'Member';
}

/** Normalize Free4Talk role strings → canonical form */
function resolveRole(raw) {
    const r = (raw || '').toString().toLowerCase();
    // PENTING: cek co-owner SEBELUM owner (co-owner juga contains 'owner')
    if (r.includes('co-owner') || r.includes('coowner') || r === 'co') return 'Co-owner';
    if (r.includes('owner')) return 'Owner';
    if (r.includes('moderator') || r.includes('mod')) return 'Moderator';
    if (r.includes('admin')) return 'Admin';
    return 'Member';
}

// ════════════════════════════════════════════════════════════════════════════
//  SEND MESSAGE  —  DOM primary (DataChannel direct disabled pending debug)
// ════════════════════════════════════════════════════════════════════════════
async function sendMessage(text) {
    if (!page) return;
    try {
        botLastSentAt = Date.now();
        const fp = normalizeMsg(text);
        sentMessages.add(fp);
        setTimeout(() => sentMessages.delete(fp), 15000);

        const sel = 'textarea[placeholder*="Type a message"], input[placeholder*="Type a message"]';
        const sent = await page.evaluate(async (msg) => {
            const input = document.querySelector(
                'textarea[placeholder*="Type a message"], input[placeholder*="Type a message"]'
            );
            if (!input) return false;
            const proto = input instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(input, msg);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 50));

            // Click send button
            const sendBtn = document.querySelector('button[type="submit"]') || 
                            document.querySelector('button svg[data-testid*="Send"]')?.closest('button') ||
                            document.querySelector('button svg path[d*="M2.01 21"]')?.closest('button') ||
                            input.parentElement?.querySelector('button') ||
                            input.parentElement?.parentElement?.querySelector('button');
            if (sendBtn) {
                sendBtn.click();
                return true;
            }

            // Fallback to Enter keys
            const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
            input.dispatchEvent(new KeyboardEvent('keydown', opts));
            input.dispatchEvent(new KeyboardEvent('keypress', opts));
            input.dispatchEvent(new KeyboardEvent('keyup', opts));
            return true;
        }, text);

        if (!sent) {
            await page.fill(sel, text);
            await page.keyboard.press('Enter');
        }
    } catch (e) {
        log('Failed to send message: ' + e.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  AI RELEVANCE GATE — tentukan apakah AI perlu balas pesan ini
// ════════════════════════════════════════════════════════════════════════════
let _aiLastReplyAt = 0;
// Catatan: status mute disimpan di botState.aiMuteUntil (timestamp ms; 0 = aktif)
// supaya plugin (!ai off/on/sleep) bisa modify lewat ctx.botState.
const AI_DIRECT_COOLDOWN = 0;     // Direct mention: NO cooldown — user manggil eksplisit, harus selalu respond
const AI_QUESTION_COOLDOWN = 5000; // 5 detik untuk pertanyaan
const AI_RANDOM_COOLDOWN = 90000; // 90 detik untuk random nimbrung
const AI_RANDOM_CHANCE = 0.05;  // 5% (turun dari 15%)

// Ringkasan pesan terakhir untuk deteksi conversation antar-user
const _recentChats = [];          // [{ name, text, ts }]
const RECENT_CHAT_WINDOW = 20000; // 20 detik

function recordChat(name, text) {
    const now = Date.now();
    _recentChats.push({ name, text, ts: now });
    while (_recentChats.length && now - _recentChats[0].ts > RECENT_CHAT_WINDOW) {
        _recentChats.shift();
    }
}

function isBotName(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    const botName = (botState?.botName || 'Past').toLowerCase();
    const botRoot = botName.replace(/bot$/i, '');
    const botRootDedup = botRoot.replace(/(.)\1+/g, '$1');
    const aliases = ['bot', 'gicell', 'gicellbot', botName, botRoot, botRootDedup];
    return aliases.some(a => a && (lower === a || lower.includes(a)));
}

/** Apakah pesan ini terlihat ditujukan ke user lain (bukan ke bot)? */
function isAddressedToOtherUser(text, participants = []) {
    const lower = text.toLowerCase();

    // 1. Eksplisit @mention (bukan @bot)
    const mentionMatch = lower.match(/@([a-z0-9_]+)/);
    if (mentionMatch) {
        const mentioned = mentionMatch[1];
        if (!isBotName(mentioned)) return true;
    }

    // 2. Sapaan langsung ke nama participant: "bro X", "kak X", "mbak X", "bang X", "sis X", "om X", "tante X"
    const addressPrefixes = ['bro ', 'kak ', 'mbak ', 'bang ', 'sis ', 'om ', 'tante ', 'mas ', 'kang '];
    for (const p of participants) {
        if (!p?.name) continue;
        const pname = p.name.toLowerCase();
        if (isBotName(pname)) continue;
        // Match nama participant di pesan dengan prefix sapaan ATAU sebagai standalone token
        if (addressPrefixes.some(prefix => lower.includes(prefix + pname))) return true;
        // Bare name match (min 4 char buat hindari false positive)
        if (pname.length >= 4 && new RegExp(`\\b${pname}\\b`, 'i').test(lower)) return true;
    }

    return false;
}

/** Apakah ada conversation aktif antara 2+ user lain? */
function hasActiveUserConversation(currentSender) {
    const others = _recentChats.filter(c => c.name !== currentSender);
    const uniqueNames = new Set(others.map(c => c.name));
    // Conversation = ada minimal 1 user lain ngirim chat dlm window terakhir
    // dan combined chats >= 2 (saling balas / lanjutan)
    return uniqueNames.size >= 1 && others.length >= 2;
}

function checkAIRelevance(text, botName = 'GicellBot', senderName = '', participants = [], muteUntil = 0) {
    const lower = text.toLowerCase().trim();
    const botLower = botName.toLowerCase();
    const now = Date.now();
    const sinceReply = now - _aiLastReplyAt;
    const isMuted = muteUntil && muteUntil > now;

    // ── Owner Bypass / Co-Owner Bypass ────────────────────────────────────
    // If the sender is Arisu, Owner, or Co-owner, we always reply (subject to a very small safety cooldown of 1.5s).
    const sender = participants.find(p => p.name?.toLowerCase() === senderName.toLowerCase());
    const senderRole = sender ? sender.role : 'Member';
    const isOwner = senderRole === 'Owner' || senderRole === 'Co-owner' || senderName.toLowerCase() === 'arisu';
    if (isOwner) {
        if (sinceReply < 1500) return { reply: false, reason: 'owner rate limit' };
        _aiLastReplyAt = now;
        return { reply: true, reason: 'owner chat' };
    }

    // ── Tier 1: Direct mention / dipanggil langsung ───────────────────────
    // Catatan: 'bot' standalone dihapus karena terlalu generic ("lu bot ya", "kayak bot").
    // Tetap ada via prefix "hei bot/hey bot/hai bot" atau via nama bot eksplisit.
    // Direct mention BYPASS mute — supaya user bisa unmute via "!ai on" atau dipanggil ulang.
    //
    // Auto-typo tolerance dari botName:
    //   "GicellBot" → botLower "gicellbot"
    //                 → strip "bot" suffix → "gicell"
    //                 → dedupe huruf double "ll" → "gicel" (typo umum!)
    // Ini supaya user yang ngetik "gicel" / "gicell" / "gicellbot" semua match.
    const botRoot = botLower.replace(/bot$/i, '');         // "gicell"
    const botRootDedup = botRoot.replace(/(.)\1+/g, '$1');      // "gicel"
    const directTriggers = [
        botLower,
        botRoot,
        botRootDedup,
        'hei bot', 'hey bot', 'hai bot', 'halo bot', 'oi bot', 'woi bot',
    ].filter((t, i, a) => t && t.length >= 3 && a.indexOf(t) === i);
    const isDirect = directTriggers.some(t => lower.includes(t));
    if (isDirect) {
        if (sinceReply < AI_DIRECT_COOLDOWN) return { reply: false, reason: 'direct cooldown' };
        _aiLastReplyAt = now;
        return { reply: true, reason: 'direct mention' };
    }

    // ── Mute manual: block Tier 2 & Tier 3 ────────────────────────────────
    // Direct mention di atas sudah lolos. Sisanya (pertanyaan + random) di-skip.
    if (isMuted) {
        const remaining = Math.ceil((muteUntil - now) / 1000);
        return { reply: false, reason: `ai muted (${remaining}s left)` };
    }

    // ── Greetings check ───────────────────────────────────────────────────
    const greetings = ['hello', 'hi', 'hey', 'yo', 'sup', 'wassup', 'whats up', 'anyone here', 'morning', 'afternoon', 'evening', 'halo', 'hai'];
    const isGreeting = greetings.some(g => lower === g || lower.startsWith(g + ' ') || lower.startsWith(g + ',') || lower.startsWith(g + '!'));
    if (isGreeting) {
        if (sinceReply < 5000) return { reply: false, reason: 'greeting cooldown' };
        _aiLastReplyAt = now;
        return { reply: true, reason: 'greeting detected' };
    }

    // Tier 2: Explicit questions
    // Stricter: must contain '?' OR start with a question word (not mid-sentence).
    const questionStarters = ['what', 'how', 'why', 'when', 'where', 'who', 'which',
        'can', 'is', 'are', 'do', 'does', 'did', 'will', 'would',
        'should', 'could', 'siapa', 'apa', 'bagaimana', 'kenapa', 'mengapa', 'kapan', 'dimana'];
    const isQuestion = lower.includes('?') ||
        questionStarters.some(w => lower.startsWith(w + ' '));

    if (isQuestion) {
        // Skip kalau pertanyaan jelas ditujukan ke user lain
        if (isAddressedToOtherUser(text, participants)) {
            return { reply: false, reason: 'question addressed to other user' };
        }
        const cooldown = (botState && botState.voiceAI) ? 0 : AI_QUESTION_COOLDOWN;
        if (sinceReply < cooldown) return { reply: false, reason: 'question — cooldown' };
        _aiLastReplyAt = now;
        return { reply: true, reason: 'question detected' };
    }

    // ── Tier 3: Random nimbrung (5% chance, cooldown 90s) ────────────────
    if (sinceReply > AI_RANDOM_COOLDOWN && Math.random() < AI_RANDOM_CHANCE) {
        // Skip kalau pesan terlalu pendek (<= 5 kata)
        if (lower.split(/\s+/).length <= 5) return { reply: false, reason: 'too short for random' };
        // Skip kalau ditujukan ke user lain
        if (isAddressedToOtherUser(text, participants)) {
            return { reply: false, reason: 'random skip — addressed to other' };
        }
        // Skip kalau conversation antar user lagi rame
        if (hasActiveUserConversation(senderName)) {
            return { reply: false, reason: 'random skip — user conversation active' };
        }
        _aiLastReplyAt = now;
        return { reply: true, reason: 'random engagement' };
    }

    return { reply: false, reason: 'not relevant / cooldown' };
}

async function triggerSarcasticWelcome(name) {
    try {
        const welcomeMsg = await generateOnce(`Someone named '${name}' just joined the room. Write max 10 words, lowercase, sarcastic welcome tagging @${name}. No lol or lmao. Example: '@${name} oh great another one'`, botState);
        if (welcomeMsg) {
            await sendMessage(welcomeMsg);
        }
    } catch (e) {
        log(`[WELCOME ERROR] ${e.message}`, 'error');
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  CHAT HANDLER
// ════════════════════════════════════════════════════════════════════════════

/** "play despacito", "play song X", "putar lagu X" → song query or null */
function extractPlayQuery(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const lower = raw.toLowerCase();
    const exactAsk = ['play', 'play song', 'play music', 'putar lagu', 'putar musik', 'play a song', 'play a music'];
    if (exactAsk.includes(lower)) return null;

    // Optional wake prefix: "past play despacito"
    const stripped = raw.replace(/^(past|gicell|gicellbot)\s+/i, '').trim();
    const src = stripped || raw;

    const patterns = [
        /^play\s+(?:song|music|a\s+song|a\s+music)\s+(.+)$/i,
        /^play\s+(.+)$/i,
        /^putar\s+(?:lagu|musik)\s+(.+)$/i,
        /^putar\s+(.+)$/i,
        /^mainkan\s+(.+)$/i,
    ];
    for (const re of patterns) {
        const m = src.match(re);
        if (!m) continue;
        const name = m[1].trim();
        if (name.length < 2) continue;
        const reject = new Set(['song', 'music', 'a song', 'a music', 'lagu', 'musik', 'something', 'anything']);
        if (reject.has(name.toLowerCase())) continue;
        return name;
    }
    return null;
}

function formatQueuedSongMessage(song, query, queuePos) {
    const nextLine = queuePos === 1
        ? "⏭️ It's **next** — plays right after the current song."
        : `⏭️ Queue position **#${queuePos}**.`;
    return (
        `📝 **Added to queue:** ${song.title}\n` +
        `${nextLine}\n` +
        `💡 Want it **now**? Say **stop** then **play ${query}**`
    );
}

async function handleChatMessage(chatData) {

    if (!chatData?.text) return;

    // Normalisasi: trim leading/trailing whitespace.
    // Penting — keyboard mobile sering auto-insert spasi di depan, yang bikin
    // `text.startsWith('!')` gagal → command salah deteksi sebagai chat biasa
    // → kena cooldown / AI relevance gate → tidak direspons.
    chatData.text = String(chatData.text).trim();
    if (!chatData.text) return;

    // Resolve uid from name if missing, then hydrate name/role from cache
    if (!chatData.senderId && chatData.senderName && chatData.senderName !== 'Unknown') {
        chatData.senderId =
            participantsCache.get(chatData.senderName.toLowerCase()) ||
            [...participantsCache.entries()].find(([k]) => k.startsWith(chatData.senderName.toLowerCase()))?.[1] ||
            null;
    }
    // Always resolve clean name + role from participantDetails (overrides DOM noise)
    if (chatData.senderId) {
        chatData.senderName = nameOf(chatData.senderId);
        chatData.senderRole = roleOf(chatData.senderId);
    } else {
        chatData.senderName = chatData.senderName || 'Unknown';
        chatData.senderRole = chatData.senderRole || 'Member';
    }

    const cleanText = chatData.text.toLowerCase().trim();

    // 1. Interactive Music Play State Machine
    if (botState && botState.waitingForSong && (botState.waitingForSong === chatData.senderId || botState.waitingForSong === chatData.senderName)) {
        delete botState.waitingForSong;
        chatData.text = `!play ${chatData.text}`;
        log(`[MUSIC STATE] Hydrated song name: "${chatData.text}"`, 'info');
    } else {
        // 2. Play trigger detection
        const playTriggers = ['play', 'play song', 'play music', 'putar lagu', 'putar musik', 'play a song', 'play a music'];
        if (playTriggers.includes(cleanText)) {
            botState.waitingForSong = chatData.senderId || chatData.senderName;
            const askMsg = `🎶 **Which song do you want me to play?**\n*(Just type the song title now!)*`;
            if (botState.voiceAI) {
                await speakTTS("Which song do you want me to play?", { force: true }).catch(() => {});
            } else {
                await sendMessage(askMsg);
            }
            return;
        }

        // 2b. "play song name" in one message → !play
        const playQuery = extractPlayQuery(chatData.text);
        if (playQuery) {
            chatData.text = `!play ${playQuery}`;
            log(`[MUSIC STATE] Natural play → !play "${playQuery}"`, 'info');
        }

        // 3. Stop trigger detection
        const stopTriggers = ['stop', 'stop song', 'stop music', 'stop lagu', 'stop musik', 'matiin lagu', 'matiin musik'];
        if (stopTriggers.includes(cleanText)) {
            chatData.text = `!stop`;
            log(`[MUSIC STATE] Intercepted stop trigger, rewrote to !stop`, 'info');
        }
    }

    // Dedup
    const dedupKey = chatData.msgId ? `id:${chatData.msgId}` : `${chatData.senderName}::${chatData.text}`;
    if (msgSeenKeys.has(dedupKey)) return;
    msgSeenKeys.add(dedupKey);
    setTimeout(() => msgSeenKeys.delete(dedupKey), 30000);

    const isCmd = chatData.text.startsWith('!');

    // Skip pesan bot sendiri (cek by UID dulu, fallback ke nama), kecuali berupa perintah (dimulai dengan !)
    if (botMyId && chatData.senderId === botMyId && !isCmd) return;
    const senderLower = (chatData.senderName || '').toLowerCase();
    const botNameLower = (botState.botName || 'Past').toLowerCase();
    if ((BOT_OWN_NAMES.some(n => senderLower.includes(n.toLowerCase())) || senderLower === botNameLower) && !isCmd) return;

    // Anti-loop fingerprint
    const fp = normalizeMsg(chatData.text);
    if (sentMessages.has(fp)) { log('[Anti-loop] fingerprint match.', 'warn'); return; }

    // Anti-loop cooldown (non-command) — set to 1.5s flat for all users to keep responses fast and interactive
    const cd = 1500;
    if (!isCmd && Date.now() - botLastSentAt < cd) {
        log('[Anti-loop] cooldown active.', 'warn'); return;
    }

    // Track non-command chat untuk conversation awareness
    if (!isCmd) recordChat(chatData.senderName, chatData.text);

    const ctx = {
        botState, sendMessage, addToQueue, playNext, log, updateStatus, page,
        clearPendingSongRequests,
        speakTTS, isTTSBusy,
        sender: { name: chatData.senderName || 'Unknown', role: chatData.senderRole || 'Member', uid: chatData.senderId || null }
    };

    if (isCmd) {
        log(`[CMD] ${chatData.senderName} (${chatData.senderRole}) uid:${chatData.senderId} → ${chatData.text}`, 'cmd');
        await commandHandler(chatData.text, ctx);
        const cleanCmd = chatData.text.split(' ')[0].substring(1).toLowerCase();
        const isKnown = commandHandler.CORE_COMMANDS?.includes(cleanCmd) ||
            commandHandler.getPluginCommands?.()?.has(cleanCmd);
        if (!isKnown) {
            if (isAIProcessing) return;
            isAIProcessing = true;
            try {
                const reply = await askAI(chatData.text, chatData.senderName, botState, { voice: botState.voiceAI });
                if (reply) {
                    if (botState.voiceAI) {
                        await speakTTS(reply, { force: true }).catch(() => {});
                    } else {
                        await sendMessage(reply);
                    }
                }
            } finally { isAIProcessing = false; }
        }
    } else {
        // Always reply to every user message (unless manual muted)
        const isMuted = botState.aiMuteUntil && botState.aiMuteUntil > Date.now();
        if (isMuted) {
            const remaining = Math.ceil((botState.aiMuteUntil - Date.now()) / 1000);
            log(`[AI] Skip reply — AI is muted manually (${remaining}s left)`, 'info');
            return;
        }
        log(`[AI] Replying to user message — always reply active`, 'info');

        if (isAIProcessing) { log('[AI mutex] busy.', 'warn'); return; }
        isAIProcessing = true;
        try {
            log(`[CHAT] ${chatData.senderName} (uid:${chatData.senderId}): ${chatData.text}`, 'info');
            const reply = await askAI(chatData.text, chatData.senderName, botState, { voice: botState.voiceAI });
            if (reply) {
                const { cleanReply, command } = parseCommandFromAI(reply, chatData.text);

                if (cleanReply) {
                    if (botState.voiceAI) {
                        await speakTTS(cleanReply, { force: true }).catch(() => {});
                    } else {
                        await sendMessage(cleanReply);
                    }
                }
                if (command) {
                    log(`[AI→CMD] ${command}`, 'cmd');
                    try { await commandHandler(command, ctx); } catch (_) { }
                }
            }
        } finally { isAIProcessing = false; }

    }
}

// ════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET INTERCEPTOR  —  participant cache + optional chat
// ════════════════════════════════════════════════════════════════════════════
const CHAT_EVENT_NAMES = new Set([
    'message', 'chat', 'chat:message', 'chat:new', 'new:message',
    'room:message', 'newMessage', 'chatMessage', 'msg', 'send',
    'broadcast', 'text', 'userMessage', 'roomChat', 'public-message'
]);

function parseChatPayload(eventName, data) {
    if (!CHAT_EVENT_NAMES.has(eventName) || !data || typeof data !== 'object') return null;
    const text = (data.message ?? data.text ?? data.content ?? data.msg ?? data.body ?? '').toString().trim();
    if (!text) return null;
    const userObj = data.user ?? data.sender ?? data.from ?? data.author ?? {};
    const senderName = (userObj.name ?? userObj.username ?? userObj.displayName ?? data.username ?? '').trim() || 'Unknown';
    const senderId = userObj.id ?? userObj._id ?? userObj.uid ?? data.userId ?? null;
    return { text, senderName, senderId, senderRole: userObj.role ?? data.role ?? 'Member', msgId: data.id ?? null };
}

function setupWSInterceptor() {
    page.on('websocket', ws => {
        if (!ws.url().includes('ws.free4talk.com')) return;
        ws.on('framereceived', ({ payload }) => {
            try {
                const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
                if (!raw.startsWith('42')) return;
                let jsonPart = raw.slice(2);
                if (jsonPart.startsWith('/')) {
                    const idx = jsonPart.indexOf(',[');
                    if (idx === -1) return;
                    jsonPart = jsonPart.slice(idx + 1);
                }
                let arr; try { arr = JSON.parse(jsonPart); } catch { return; }
                if (!Array.isArray(arr) || arr.length < 2) return;
                const [evName, evData] = arr;

                // Participants event
                if (evName.includes(':participants') && evData?.participantMap) {
                    // Konfirmasi bot sudah beneran di dalam room
                    if (_resolveWsReady) { _resolveWsReady(); _resolveWsReady = null; }
                    const keepBot = participantDetails.get(botMyId);
                    const oldRoles = new Map([...participantDetails.entries()].map(([uid, d]) => [uid, d.role]));  // preserve roles
                    participantDetails.clear();
                    if (keepBot) participantDetails.set(botMyId, keepBot);

                    const isFirstRun = !_participantsInitialized;
                    _participantsInitialized = true;

                    for (const p of Object.values(evData.participantMap)) {
                        if (!p.name || !p.id) continue;
                        participantsCache.set(p.name.toLowerCase(), p.id);

                        // Trigger sarcastic welcome for new joins (excluding the bot itself)
                        if (!isFirstRun && p.id !== botMyId && !oldRoles.has(p.id)) {
                            triggerSarcasticWelcome(p.name);
                        }

                        const rawRole = p.role || p.level || p.privilege || (p.power != null && p.power > 0 ? 'moderator' : '') || '';
                        const wsRole = resolveRole(rawRole);
                        const prevRole = oldRoles.get(p.id) || '';
                        // Preserve elevated roles — don't reset Owner/Mod set by owner:command or DOM
                        const finalRole = (prevRole && prevRole !== 'Member') ? prevRole : wsRole;
                        participantDetails.set(p.id, { name: p.name, role: finalRole });
                    }
                    applyStaticRoles();
                    if (typeof commandHandler.updateUserMap === 'function')
                        commandHandler.updateUserMap(participantsCache);
                    if (!botJwk && evData.myself?.jwkKeyPair?.d && evData.myself?.id) {
                        botJwk = evData.myself.jwkKeyPair;
                        botMyId = evData.myself.id;
                        log(`[IDENTITY] JWK from WS ✓ uid=${botMyId}`, 'success');
                    }
                }

                // ── Owner transfer: room:[id]:owner:command type:"warning" = transfer, type:"danger" = kick
                if (evName.includes(':owner:command') && evData?.system?.client?.id) {
                    const evType = evData.system.type || '';
                    const newId = evData.system.client.id;
                    const newName = evData.system.client.name || nameOf(newId);
                    participantsCache.set(newName.toLowerCase(), newId);
                    if (evType === 'warning') {  // ownership transfer
                        for (const [uid, d] of participantDetails.entries()) {
                            if (d.role === 'Owner') participantDetails.set(uid, { ...d, role: 'Member' });
                        }
                        const ex = participantDetails.get(newId) || { name: newName };
                        participantDetails.set(newId, { ...ex, name: newName, role: 'Owner' });
                        updateParticipants();
                        log(`[OWNER-TRANSFER] → ${newName} (${newId})`, 'success');
                    } else if (evType === 'danger') {
                        log(`[KICK] ${newName} (${newId}) was kicked`, 'warn');
                    }
                }

                // ── modMap roles dari room:settings ───────────────────────────
                if (evName.includes(':settings') && evData?.modMap) {
                    for (const [uid, info] of Object.entries(evData.modMap)) {
                        if (!info?.role) continue;
                        const role = resolveRole(info.role);
                        if (role !== 'Member') {
                            const ex2 = participantDetails.get(uid) || { name: nameOf(uid) };
                            participantDetails.set(uid, { ...ex2, role });
                        }
                    }
                    updateParticipants();
                }

                // WS-based chat (fallback path)
                const chatData = parseChatPayload(evName, evData);
                if (chatData) handleChatMessage(chatData);

                // Detect owner dari creatorId/ownerId field
                if (evData && typeof evData === 'object') {
                    const data = evData?.data || evData?.room || evData?.myself?.settings || evData;
                    const creatorId = data?.creatorId || data?.ownerId || data?.creator?.id || data?.owner?.id;
                    if (creatorId && typeof creatorId === 'string') {
                        const existing = participantDetails.get(creatorId) || { name: nameOf(creatorId) };
                        if (existing.role !== 'Owner') {
                            participantDetails.set(creatorId, { ...existing, role: 'Owner' });
                            log(`[ROOM] Owner from WS uid=${creatorId} (${existing.name})`, 'success');
                        }
                    }
                    if (!evName.includes('transporter') && !evName.includes('signaling')) {
                        // (verbose WS log dihapus untuk performa)
                    }
                }
            } catch (e) { log(`[ERROR] WS Interceptor: ${e.message}`, 'error'); }
        });
        ws.on('close', () => log(`[WS] Closed → ${ws.url()}`, 'warn'));
    });
    log('[WS] Participant cache listener active.', 'info');
}

// ── Leave detection: search for name in page text (tile-only pattern) ───────────────
async function scanRoomParticipants() {
    if (!page || botState.status !== 'ONLINE') return;
    if (participantDetails.size === 0) return;
    try {
        const pageText = await page.evaluate(() => (document.body?.innerText || '').toLowerCase());
        if (!pageText || pageText.length < 10) return;

        let changed = false;
        for (const [uid, d] of participantDetails.entries()) {
            if (uid === botMyId) continue;
            const name = (d.name || '').toLowerCase();
            // Search for pattern that ONLY appears in F4T video tiles, not in chat history
            const inTile = pageText.includes(`select ${name}`) || pageText.includes(`${name} settings`);
            if (!inTile) {
                participantDetails.delete(uid);
                log(`[LEAVE] ${d.name} left the room`, 'warn');
                changed = true;
            }
        }
        if (changed) applyStaticRoles();
    } catch (_) { }
}

// ════════════════════════════════════════════════════════════════════════════
//  MUSIC FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════
// ── Mic toggle helpers ───────────────────────────────────────────────────────
async function unmuteMic() {
    if (!page) return;
    log('[MIC] Attempting to unmute...', 'info');
    try {
        await page.bringToFront();
        // Search for button with text "Turn ON your microphone" (state: muted)
        const clicked = await page.evaluate(() => {
            const blinds = [...document.querySelectorAll('div.blind, .blind, .MuiBox-root')];
            const target = blinds.find(el => {
                const text = el.textContent.trim().toLowerCase();
                return text.includes('turn on your microphone') ||
                    text.includes('muted by moderator') ||
                    text.includes('muted by owner');
            });

            if (target) {
                // Click nearest ancestor button
                let btn = target;
                while (btn && btn.tagName !== 'BUTTON') btn = btn.parentElement;
                if (btn) {
                    btn.click();
                    return { type: 'blind_click', text: target.textContent.trim() };
                }
            }

            // Fallback: search for mic icon with a slash or red color
            const micBtn = document.querySelector('button[aria-label*="microphone"], button svg[data-testid*="MicOff"]');
            if (micBtn) {
                const isOff = micBtn.querySelector('svg[data-testid="MicOffIcon"]') ||
                    micBtn.innerHTML.includes('MicOff') ||
                    micBtn.getAttribute('aria-label')?.toLowerCase().includes('turn on');
                if (isOff) {
                    micBtn.click();
                    return { type: 'icon_click' };
                }
            }
            return null;
        });
        if (clicked) {
            log(`[MIC] ✅ Unmuted via ${clicked.type}${clicked.text ? ': ' + clicked.text : ''}`, 'success');
        } else {
            // log('[MIC] Mic already ON or button not found.', 'info');
        }
    } catch (e) {
        log(`[MIC] unmuteMic error: ${e.message}`, 'warn');
    }
}

async function muteMic() {
    // Disabled by user request: stay unmuted.
    log('[MIC] Auto-mute skip (user preference).', 'info');
    return;
}

// ── TTS: server-side wrapper ─────────────────────────────────────────────────
// Generate audio TTS, encode base64, push to browser for playback via
// virtual mic pipeline (window._micDest). Auto-handle mic state (unmute when
// speaking, stay unmuted after finished as requested).
let _ttsBusy = false;
async function speakTTS(text, opts = {}) {
    if (!page) throw new Error('Bot belum aktif (no page)');
    if (_ttsBusy) throw new Error('TTS is currently speaking, please wait');

    // Don't speak over music unless forced
    if (botState.isPlaying && !opts.force) {
        log('[TTS] Skipped — music is playing.', 'info');
        return;
    }

    _ttsBusy = true;
    let micWasMuted = false;
    let musicWasPlaying = false;
    try {
        if (botState.isPlaying && opts.force) {
            musicWasPlaying = true;
            log('[TTS] Pausing music for speech...', 'info');
            await page.evaluate(() => {
                if (window._audioElement) window._audioElement.pause();
            }).catch(() => {});
        }

        log(`[TTS] Generating: "${String(text).slice(0, 60)}${text.length > 60 ? '...' : ''}"`, 'info');
        const selectedVoice = opts.voice || (botState && botState.voiceAIVoice) || 'guy';
        const rate = opts.rate || (botState && botState.voiceAIRate) || '-5%';
        const pitch = opts.pitch || (botState && botState.voiceAIPitch) || '-5Hz';
        const buf = await generateTTS(text, { ...opts, voice: selectedVoice, rate, pitch });
        const b64 = buf.toString('base64');
        log(`[TTS] Buffer ${(buf.length / 1024).toFixed(1)}KB ready, broadcasting...`, 'info');

        // Cek apakah mic muted (cari tombol "Turn ON your microphone")
        micWasMuted = await page.evaluate(() => {
            const blinds = [...document.querySelectorAll('div.blind, .blind')];
            return blinds.some(el => el.textContent.trim().toLowerCase().includes('turn on your microphone'));
        }).catch(() => false);

        if (micWasMuted) {
            log('[TTS] Mic muted — auto-unmuting...', 'info');
            await unmuteMic();
            await new Promise(r => setTimeout(r, 400));  // beri waktu state settle
        }

        // Putar TTS via pipeline; resolve saat audio.onended.
        await page.evaluate(b => window._speakInPipeline(b), b64);
        log('[TTS] ✅ Finished speaking', 'success');
    } finally {
        botState.lastBotSpeakFinishedAt = Date.now();
        // Restore mic state
        if (micWasMuted) {
            await new Promise(r => setTimeout(r, 200));
        }
        if (musicWasPlaying) {
            log('[TTS] Resuming music...', 'info');
            await page.evaluate(() => {
                if (window._audioElement) window._audioElement.play().catch(() => {});
            }).catch(() => {});
        }
        _ttsBusy = false;
    }
}

function isTTSBusy() { return _ttsBusy; }

// ── Music race-condition guards ───────────────────────────────────────────
let _streamToken = 0;   // increment setiap startStream baru — cegah stale stream
let _isSearching = false; // mutex: hanya 1 yts+yt-dlp boleh jalan bersamaan

let _pendingSongRequests = [];
let _songRequestGeneration = 0;

function clearPendingSongRequests() {
    _songRequestGeneration++;
    _pendingSongRequests = [];
}

async function stopAudio() {
    if (page) {
        await page.evaluate(() => {
            window._musicPlaying = false;
            if (window._audioElement) {
                window._audioElement.pause();
                window._audioElement.src = '';
            }
        }).catch(() => { });
    }
}

function extractVideoId(url) {
    if (!url) return null;
    const match = url.match(/(?:v=|\/embed\/|\/1\/|\/v\/|https:\/\/youtu\.be\/|vi\/|youtu\.be\/|e\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

async function getRelatedVideos(videoId) {
    const ytdlpPath = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
    try {
        const { stdout } = await execFileAsync(ytdlpPath, [
            '--flat-playlist',
            '-j',
            '--playlist-items', '1-15',
            '--extractor-args', 'youtube:player-client=android,web',
            `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`
        ]);
        const lines = stdout.trim().split('\n');
        const videos = [];
        for (const line of lines) {
            try {
                if (!line) continue;
                const data = JSON.parse(line);
                if (data.id && data.title && data.url) {
                    videos.push({
                        title: data.title,
                        url: data.url,
                        id: data.id,
                        duration: data.duration_string || (data.duration ? `${Math.floor(data.duration/60)}:${String(Math.floor(data.duration%60)).padStart(2,'0')}` : '3:00')
                    });
                }
            } catch (_) {}
        }
        return videos;
    } catch (e) {
        log(`[AUTOPLAY] yt-dlp related error: ${e.message}`, 'warn');
        return [];
    }
}

async function playNext() {
    if (botState.isRepeating && botState.currentSong) return startStream(botState.currentSong);
    if (botState.queue.length > 0) {
        botState.currentSong = botState.queue.shift();
        await startStream(botState.currentSong);
    } else {
        // Queue is empty
        _streamToken++;
        botState.isPlaying = false;
        await stopAudio();

        // 1. If a search is currently active, just wait for it to finish and add to queue
        if (_isSearching || _pendingSongRequests.length > 0) {
            log('Queue empty, waiting for song requests being processed.', 'info');
            updateStatus();
            return;
        }

        log(`[DEBUG] playNext - autoPlay: ${botState.autoPlay}, currentSong: ${botState.currentSong ? botState.currentSong.title : 'null'}`, 'info');
        // 2. If AutoPlay is enabled and we have a previous song, find a related one
        if (botState.autoPlay && botState.currentSong) {
            const lastSong = botState.currentSong;
            const lastTitle = lastSong.title;
            log(`[AUTOPLAY] Queue empty, searching for related music: "${lastTitle}"`, 'info');

            setTimeout(async () => {
                try {
                    const lastId = extractVideoId(lastSong.url);
                    let candidates = [];
                    if (lastId) {
                        log(`[AUTOPLAY] Fetching Mix playlist for video ID: ${lastId}`, 'info');
                        candidates = await getRelatedVideos(lastId);
                    }

                    if (!candidates || candidates.length === 0) {
                        log(`[AUTOPLAY] Mix playlist empty or failed. Falling back to keyword search: "${lastTitle} music"`, 'info');
                        const search = await yts(`${lastTitle} music`);
                        candidates = search.videos.slice(0, 15).map(v => ({
                            title: v.title,
                            url: v.url,
                            id: v.videoId,
                            duration: v.timestamp
                        }));
                    }

                    // Filter out the exact same song and any recently played songs
                    const playHistory = botState.playHistory || [];
                    const next = candidates.find(v => {
                        const t = v.title.toLowerCase();
                        const l = lastTitle.toLowerCase();
                        const vId = v.id || extractVideoId(v.url);

                        // 1. Skip if already in playHistory (by ID)
                        if (vId && playHistory.includes(vId)) return false;

                        // 2. Skip if title is too similar (contains or is contained)
                        if (t.includes(l) || l.includes(t)) return false;

                        return true;
                    }) || candidates[1] || candidates[2] || candidates[0]; // Fallback to 2nd, 3rd, or 1st if filter fails

                    if (next) {
                        const song = {
                            title: next.title,
                            url: next.url,
                            duration: next.duration || next.timestamp || '3:00',
                            requestedBy: 'AutoPlay'
                        };
                        log(`[AUTOPLAY] Next song: ${song.title}`, 'success');
                        await startStream(song);
                    } else {
                        throw new Error('No new related songs found');
                    }
                } catch (e) {
                    log(`[AUTOPLAY] Failed: ${e.message}`, 'warn');
                    botState.currentSong = null;
                    updateStatus();
                    await sendMessage(`⏹ Playlist finished (AutoPlay failed).`);
                }
            }, 1000);
            return;
        }

        // 3. Otherwise, stop playback
        botState.currentSong = null;
        log('Queue empty.', 'warn');
        updateStatus();
        await sendMessage(`⏹ Playlist finished.`);
    }
}

async function startStream(song) {
    _streamToken++;
    const myToken = _streamToken;

    botState.isPlaying = true;
    botState.currentSong = song;
    updateStatus();

    // Track recently played songs
    botState.playHistory = botState.playHistory || [];
    const songId = extractVideoId(song.url);
    if (songId && !botState.playHistory.includes(songId)) {
        botState.playHistory.push(songId);
        if (botState.playHistory.length > 50) botState.playHistory.shift();
    }

    log(`Preparing stream: ${song.title} (Req: ${song.requestedBy})`, 'info');
    await sendMessage(`⏳ Preparing stream: ${song.title}\n👤 Requested by: ${song.requestedBy}`);

    try {
        log(`[MUSIC] Fetching stream URL...`, 'info');
        const [playback] = await Promise.all([
            resolvePlaybackSource(song.url),
            unmuteMic()
        ]);

        if (myToken !== _streamToken) {
            log(`[MUSIC] Stream token mismatch (${myToken}≠${_streamToken}) — discarding stale stream.`, 'warn');
            return;
        }

        log(`[MUSIC] Playback source: ${playback.type}`, 'info');

        await page.evaluate(async ({ src, isFile }) => {
            if (!window._audioElement) throw new Error('_audioElement not initialized');

            const audio = window._audioElement;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            audio.volume = window._botVolume || 0.1;
            audio.preload = 'auto';

            if (window._audioCtx?.state === 'suspended') {
                await window._audioCtx.resume().catch(() => { });
            }

            await new Promise((resolve, reject) => {
                let settled = false;
                const cleanup = () => {
                    clearTimeout(timer);
                    audio.removeEventListener('canplaythrough', onCanPlay);
                    audio.removeEventListener('playing', onPlaying);
                    audio.removeEventListener('error', onError);
                };
                const finishOk = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    window._musicPlaying = true;
                    resolve();
                };
                const finishErr = (err) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    window._musicPlaying = false;
                    reject(err);
                };
                const onCanPlay = () => finishOk();
                const onPlaying = () => finishOk();
                const onError = () => finishErr(new Error('audio playback error'));
                const timer = setTimeout(() => finishErr(new Error('audio start timeout')), 30000);

                audio.addEventListener('canplaythrough', onCanPlay, { once: true });
                audio.addEventListener('playing', onPlaying, { once: true });
                audio.addEventListener('error', onError, { once: true });
                audio.src = src;

                const playPromise = audio.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(err => finishErr(new Error(err?.message || 'audio play() failed')));
                }
            });
        }, { src: playback.src, isFile: playback.type === 'file' });
        log(`[MUSIC] Playback started.`, 'success');
        log(`Now Playing: ${song.title} (Req: ${song.requestedBy})`, 'success');
        await sendMessage(`🎶 Now Playing: ${song.title}\n👤 Requested by: ${song.requestedBy}`);
        preFetchNextSong();  // pre-fetch lagu berikutnya di background

    } catch (e) {
        if (myToken !== _streamToken) return; // already superseded
        const detail = e?.stderr || e?.message || e?.toString() || JSON.stringify(e);
        log(`Stream Error: ${detail}`, 'error');
        await sendMessage(`❌ Failed to play: ${song.title}`);
        playNext();
    }
}

async function processPendingSongRequests() {
    if (_isSearching) return;
    _isSearching = true;
    try {
        while (_pendingSongRequests.length > 0) {
            const request = _pendingSongRequests.shift();
            if (!request || request.generation !== _songRequestGeneration) continue;

            await sendMessage(`🔍 Searching: "${request.query}"...`);
            log(`Searching: "${request.query}"...`, 'cmd');

            try {
                const search = await yts(request.query);
                if (request.generation !== _songRequestGeneration) continue;
                if (!search.videos.length) {
                    await sendMessage(`❌ Song not found: "${request.query}"`);
                    continue;
                }

                const song = {
                    title: search.videos[0].title,
                    url: search.videos[0].url,
                    duration: search.videos[0].timestamp,
                    requestedBy: request.requesterName
                };

                if (request.generation !== _songRequestGeneration) continue;

                if (botState.isPlaying) {
                    botState.queue.push(song);
                    const queuePos = botState.queue.length;
                    log(`Added to queue (#${queuePos}): ${song.title}`, 'success');
                    updateStatus();
                    const msg = formatQueuedSongMessage(song, request.query, queuePos);
                    await sendMessage(msg);
                    if (botState.voiceAI) {
                        const tts = queuePos === 1
                            ? `Added ${song.title} to the queue. It's next after this song. Say stop then play if you want it now.`
                            : `Added ${song.title} to the queue, number ${queuePos}. Say stop then play if you want it now.`;
                        await speakTTS(tts, { force: true }).catch(() => {});
                    }
                    if (queuePos === 1) ensureLocalAudio(song.url).catch(() => { });
                } else {
                    await startStream(song);
                }
            } catch (e) {
                if (request.generation !== _songRequestGeneration) continue;
                log(`Search Error: ${e.message}`, 'error');
                await sendMessage('❌ An error occurred while searching for the song.');
            }
        }
    } finally {
        _isSearching = false;
        if (_pendingSongRequests.length > 0) {
            processPendingSongRequests().catch(e => log(`Search Queue Error: ${e.message}`, 'error'));
        }
    }
}

async function addToQueue(query, requesterName = 'Unknown') {
    _pendingSongRequests.push({ query, requesterName, generation: _songRequestGeneration });

    if (_isSearching) {
        const waitCount = _pendingSongRequests.length;
        if (waitCount > 1) {
            await sendMessage(`📝 Request received, queued (#${waitCount}): ${query}`);
        } else {
            await sendMessage(`📝 Request received, processing previous song: ${query}`);
        }
    }

    await processPendingSongRequests();
}


// ════════════════════════════════════════════════════════════════════════════
//  START BOT
// ════════════════════════════════════════════════════════════════════════════
async function startBot(config) {
    if (botState.status === 'ONLINE') return;
    try {
        botState.botName = config.botName || 'Past';
        botState.status = 'STARTING';
        updateStatus();

        // Gate: resolve saat WS :participants pertama — harus dibuat SEBELUM join room
        // supaya tidak miss event yang datang saat loading page
        const wsReadyGate = new Promise(resolve => { _resolveWsReady = resolve; });

        log('Launching browser...', 'info');

        const PROFILE_DIR = process.env.BOT_PROFILE_DIR               // per-user dari manager
            || path.join(__dirname, 'profile')            // single-user fallback
            || null;
        const useProfile = PROFILE_DIR && fs.existsSync(PROFILE_DIR);

        const BROWSER_ARGS = [
            // Wajib: fake media stream untuk mic/audio
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-web-security',
            '--mute-audio',

            // ── Hemat RAM & CPU (aman untuk headless) ─────────────────────
            '--disable-gpu',                        // ~50-100MB savings
            '--disable-gpu-compositing',
            '--disable-software-rasterizer',
            '--disable-background-networking',      // stop background fetches
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',                   // no crash reporter
            '--disable-client-side-phishing-detection',
            '--disable-default-apps',
            '--disable-dev-shm-usage',              // cegah /dev/shm OOM di container
            '--disable-extensions',
            '--disable-hang-monitor',
            '--disable-ipc-flooding-protection',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-renderer-backgrounding',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--no-first-run',
            '--no-default-browser-check',
            '--safebrowsing-disable-auto-update',
            '--password-store=basic',
            '--use-mock-keychain',
            '--js-flags=--max-old-space-size=512',  // limit V8 heap per tab
        ];

        if (useProfile) {
            // ── Persistent Context (profile sudah ada → tidak perlu inject localStorage) ──
            log('[AUTH] Profile found — using persistent session (no inject needed).', 'success');
            context = await chromium.launchPersistentContext(PROFILE_DIR, {
                headless: true,
                args: BROWSER_ARGS,
                permissions: ['microphone', 'camera'],
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            });
            // launchPersistentContext tidak punya browser object terpisah
            browser = null;
        } else {
            // ── Regular Context (fallback: pakai localStorage inject) ────────────
            log('[AUTH] No ./profile/ — using localStorage inject.', 'info');
            browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
            context = await browser.newContext({
                permissions: ['microphone', 'camera'],
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            });
        }


        // ── InitScript 1: Audio pipeline + EQ ────────────────────────────────
        await context.addInitScript(() => {
            window._musicPlaying = false;
            window._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
            window._audioElement = document.createElement('audio');
            window._audioElement.crossOrigin = 'anonymous';
            window._audioElement.autoplay = true;
            window._audioElement.preload = 'auto';
            window._audioElement.volume = 0.1;
            window._botVolume = 0.1;

            // Route audio element through Web Audio pipeline → virtual mic
            const source = window._audioCtx.createMediaElementSource(window._audioElement);
            const dest = window._audioCtx.createMediaStreamDestination();

            // Buffer underrun recovery — nudge play without resetting stream
            window._lastPlaybackNudge = 0;
            window._nudgePlayback = function () {
                const a = window._audioElement;
                if (!a || !a.src || a.ended) return;
                const now = Date.now();
                if (now - window._lastPlaybackNudge < 1200) return;
                window._lastPlaybackNudge = now;
                if (window._audioCtx?.state === 'suspended') window._audioCtx.resume().catch(() => { });
                if (a.paused) { a.play().catch(() => { }); return; }
                if (a.readyState < 3) a.play().catch(() => { });
            };
            ['stalled', 'waiting', 'suspend'].forEach(ev => {
                window._audioElement.addEventListener(ev, () => window._nudgePlayback());
            });
            window._audioElement.onended = () => {
                window._musicPlaying = false;
                window.onSongEnded();
            };

            window._bassFilter = window._audioCtx.createBiquadFilter();
            window._bassFilter.type = 'lowshelf'; window._bassFilter.frequency.value = 200; window._bassFilter.gain.value = 0;
            window._trebleFilter = window._audioCtx.createBiquadFilter();
            window._trebleFilter.type = 'highshelf'; window._trebleFilter.frequency.value = 3500; window._trebleFilter.gain.value = 0;
            window._pannerNode = window._audioCtx.createStereoPanner(); window._pannerNode.pan.value = 0;
            window._convolverNode = window._audioCtx.createConvolver();
            window._reverbGain = window._audioCtx.createGain(); window._reverbGain.gain.value = 0;
            window._dryGain = window._audioCtx.createGain(); window._dryGain.gain.value = 1.0;

            (function buildImpulse(dur, dec) {
                const sr = window._audioCtx.sampleRate;
                const buf = window._audioCtx.createBuffer(2, sr * dur, sr);
                for (let c = 0; c < 2; c++) {
                    const d = buf.getChannelData(c);
                    for (let i = 0; i < d.length; i++)
                        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, dec);
                }
                window._convolverNode.buffer = buf;
            })(3, 5);

            source.connect(window._bassFilter);
            window._bassFilter.connect(window._trebleFilter);
            window._trebleFilter.connect(window._pannerNode);
            window._pannerNode.connect(window._dryGain);
            window._pannerNode.connect(window._convolverNode);
            window._convolverNode.connect(window._reverbGain);
            window._dryGain.connect(dest);
            window._reverbGain.connect(dest);

            window._effects = { speed: 1.0, bass: 0, treble: 0, reverb: false, is8d: false };
            window._8dInterval = null;
            window._musicStream = dest.stream;
            window._micDest = dest;

            navigator.mediaDevices.getUserMedia = async (constraints) => {
                if (constraints.audio) return window._musicStream;
                return null;
            };
            setInterval(() => { if (window._audioCtx.state === 'suspended') window._audioCtx.resume(); }, 2000);

            // ── Mic Guardian ──────────────────────────────────────────────────
            // Automatically unmutes if muted by owner or moderator
            setInterval(() => {
                const blinds = [...document.querySelectorAll('div.blind, .blind, .MuiBox-root')];
                const target = blinds.find(el => {
                    const text = el.textContent.trim().toLowerCase();
                    return text.includes('turn on your microphone') ||
                        text.includes('muted by moderator') ||
                        text.includes('muted by owner');
                });
                if (target) {
                    let btn = target;
                    while (btn && btn.tagName !== 'BUTTON') btn = btn.parentElement;
                    if (btn) btn.click();
                }
            }, 2000);
            // onended already set above in stall-recovery block

            // ── TTS pipeline ─────────────────────────────────────────────────
            // Audio TTS di-route langsung ke _micDest (bypass EQ supaya suara clear).
            // Tracking _ttsActive supaya tidak overlap multiple TTS bersamaan.
            window._ttsActive = false;
            window._speakInPipeline = function (b64Mp3) {
                return new Promise((resolve, reject) => {
                    if (window._ttsActive) {
                        return reject(new Error('TTS already speaking'));
                    }
                    try {
                        const audio = new Audio('data:audio/mp3;base64,' + b64Mp3);
                        audio.crossOrigin = 'anonymous';
                        audio.volume = 1.0;

                        const src = window._audioCtx.createMediaElementSource(audio);
                        src.connect(window._micDest);  // langsung ke virtual mic, bypass EQ

                        window._ttsActive = true;
                        let finished = false;
                        const cleanup = (err) => {
                            if (finished) return;
                            finished = true;
                            window._ttsActive = false;
                            try { src.disconnect(); } catch (_) { }
                            try { audio.pause(); audio.src = ''; } catch (_) { }
                            err ? reject(err) : resolve();
                        };

                        audio.onended = () => cleanup(null);
                        audio.onerror = (e) => cleanup(new Error('TTS audio decode/play error'));

                        // Safety timeout: max 30 detik per ucapan
                        setTimeout(() => cleanup(new Error('TTS timeout (30s)')), 30000);

                        audio.play().catch(err => cleanup(err));
                    } catch (e) {
                        window._ttsActive = false;
                        reject(e);
                    }
                });
            };
        });

        // ── InitScript 2: API intercept + Transporter capture ─────────────────
        await context.addInitScript(() => {
            // Capture transporter instance via ODP hook (sebelum F4T JS jalan)
            const __origODP = Object.defineProperty;
            Object.defineProperty = function (target, prop, desc) {
                if (prop === 'sendToDataChannel' && typeof desc?.value === 'function') {
                    const orig = desc.value;
                    desc = Object.assign({}, desc, {
                        value: function () {
                            if (!window.__f4tTransporter) window.__f4tTransporter = this;
                            return orig.apply(this, arguments);
                        }
                    });
                }
                return __origODP.apply(this, arguments);
            };

            // Helper → Node.js
            function send(type, url, body) {
                try { window.__f4tApi && window.__f4tApi(type, url, String(body).substring(0, 500)); } catch (_) { }
            }

            // Patch fetch
            const _fetch = window.fetch;
            window.fetch = async function (input, init) {
                const url = typeof input === 'string' ? input : input?.url || '';
                const resp = await _fetch(input, init);
                if (url.includes('free4talk') && !url.match(/\.(js|css|png|woff|ico)/)) {
                    try {
                        resp.clone().text().then(body => {
                            if (body && body.length > 2 && body.length < 8000)
                                send('fetch', url, body);
                        }).catch(() => { });
                    } catch (_) { }
                }
                return resp;
            };

            // Patch XHR
            const _XHROpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this.__f4t_url = url;
                return _XHROpen.call(this, method, url, ...rest);
            };
            const _XHRSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function (...args) {
                const url = this.__f4t_url || '';
                if (url.includes('free4talk') && !url.match(/\.(js|css|png|woff|ico)/)) {
                    this.addEventListener('load', () => {
                        const body = this.responseText;
                        if (body && body.length > 2 && body.length < 8000) send('xhr', url, body);
                    });
                }
                return _XHRSend.apply(this, args);
            };

            // Patch WebSocket — parse participants IN browser (full message), send compact data
            const _WS = window.WebSocket;
            window.WebSocket = function (url, ...rest) {
                const ws = new _WS(url, ...rest);
                if (url && url.includes('free4talk')) {
                    ws.addEventListener('message', e => {
                        if (typeof e.data !== 'string') return;
                        const raw = e.data;
                        // Parse participants event IN browser (no truncation)
                        if (raw.startsWith('42') && raw.includes(':participants')) {
                            try {
                                const arr = JSON.parse(raw.slice(2));
                                if (Array.isArray(arr) && arr.length >= 2) {
                                    const [evName, evData] = arr;
                                    if (evName.includes(':participants') && evData?.participantMap) {
                                        const compact = Object.values(evData.participantMap)
                                            .filter(p => p.id && p.name)
                                            .map(p => ({ id: p.id, name: p.name }));
                                        if (compact.length > 0 && window.__f4tParticipants) {
                                            window.__f4tParticipants(compact);
                                        }
                                    }
                                }
                            } catch (_) { }
                        }
                        // Send raw for non-transporter events (logging only, may be truncated)
                        if (!raw.includes(':transporter:') && !raw.includes('signaling:audio')) {
                            send('ws', url, raw);
                        }
                    });
                    if (url.includes('socket-io')) window.__f4tWsRef = ws;
                }
                return ws;
            };
            Object.assign(window.WebSocket, _WS);
            window.WebSocket.prototype = _WS.prototype;
        });

        // ── InitScript 3: WebRTC DataChannel + Audio Track hook ───────────────
        await context.addInitScript(() => {
            const _RTC = window.RTCPeerConnection;
            if (!_RTC) return;
            function hookChannel(ch) {
                ch.addEventListener('message', e => {
                    try {
                        const s = typeof e.data === 'string' ? e.data : null;
                        if (!s) return;
                        if (!s.includes('ack%3Achat%3Amessage') && !s.includes('ack:chat:message')) return;
                        window.__f4tDC && window.__f4tDC(s);
                    } catch (_) { }
                });
            }

            // ── Voice listen state — default aktif ────────────────────────────
            window._voiceListenActive = true;
            window._voicePeers = new Map();   // trackId → peer entry

            // ── VAD + MediaRecorder per audio track (peer ngomong) ────────────
            function hookAudioTrack(track, stream) {
                if (track.kind !== 'audio') return;
                if (!window._audioCtx) return;
                if (window._voicePeers.has(track.id)) return;

                let source, analyser;
                try {
                    source = window._audioCtx.createMediaStreamSource(stream);
                    analyser = window._audioCtx.createAnalyser();
                    analyser.fftSize = 256;
                    analyser.smoothingTimeConstant = 0.3;
                    source.connect(analyser);
                    // analyser TIDAK connect ke destination — cuma untuk hitung
                    // energy. Audio peer tidak di-render ke speaker.
                } catch (_) {
                    return;
                }

                const VAD_THRESHOLD = 12;     // RMS energy threshold (0-128 scale)
                const SILENCE_MS = 300;    // faster end-of-speech detection
                const MAX_DURATION = 15000;  // max utterance 15 detik
                const MIN_DURATION = 500;    // utterance < 500ms = noise, di-skip

                const dataBuf = new Uint8Array(analyser.frequencyBinCount);
                let recorder = null;
                let chunks = [];
                let isSpeaking = false;
                let silenceStartedAt = 0;
                let recordStartedAt = 0;
                let stopped = false;

                window._voicePeers.set(track.id, { track, stream, source, analyser });
                // Notifikasi Node: track baru masuk (untuk participant name mapping)
                if (window.__onTrackJoined) {
                    try { window.__onTrackJoined({ trackId: track.id, joinedAt: Date.now() }); } catch (_) { }
                }

                function startRecord() {
                    if (recorder) return;
                    if (!window._voiceListenActive) return;
                    if (window._musicPlaying) return;  // skip STT while music plays — saves CPU
                    if (window._ttsActive) return;
                    try {
                        recorder = new MediaRecorder(stream, {
                            mimeType: 'audio/webm; codecs=opus',
                            audioBitsPerSecond: 32000,
                        });
                        chunks = [];
                        recorder.ondataavailable = e => {
                            if (e.data && e.data.size > 0) chunks.push(e.data);
                        };
                        recorder.onstop = async () => {
                            const duration = Date.now() - recordStartedAt;
                            recorder = null;
                            if (duration < MIN_DURATION) return;
                            if (!chunks.length) return;
                            try {
                                const blob = new Blob(chunks, { type: 'audio/webm; codecs=opus' });
                                const ab = await blob.arrayBuffer();
                                const u8 = new Uint8Array(ab);
                                let bin = '';
                                const CHUNK = 0x8000;
                                for (let i = 0; i < u8.length; i += CHUNK) {
                                    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
                                }
                                const b64 = btoa(bin);
                                if (window.__onPeerUtterance) {
                                    window.__onPeerUtterance({
                                        trackId: track.id,
                                        durationMs: duration,
                                        mime: 'audio/webm',
                                        audioB64: b64,
                                    });
                                }
                            } catch (_) { }
                        };
                        recorder.start();
                        recordStartedAt = Date.now();
                    } catch (_) {
                        recorder = null;
                    }
                }

                function stopRecord() {
                    if (recorder && recorder.state === 'recording') {
                        try { recorder.stop(); } catch (_) { }
                    }
                }

                function vadLoop() {
                    if (stopped) return;
                    if (!window._voicePeers.has(track.id)) return;
                    if (window._musicPlaying) {
                        setTimeout(vadLoop, 200);
                        return;
                    }
                    try {
                        analyser.getByteTimeDomainData(dataBuf);
                        let sum = 0;
                        for (let i = 0; i < dataBuf.length; i++) {
                            const v = dataBuf[i] - 128;
                            sum += v * v;
                        }
                        const rms = Math.sqrt(sum / dataBuf.length);
                        const speaking = rms > VAD_THRESHOLD;
                        const now = Date.now();

                        if (speaking) {
                            silenceStartedAt = 0;
                            if (!isSpeaking) {
                                isSpeaking = true;
                                startRecord();
                            }
                        } else if (isSpeaking) {
                            if (!silenceStartedAt) silenceStartedAt = now;
                            if (now - silenceStartedAt >= SILENCE_MS) {
                                isSpeaking = false;
                                silenceStartedAt = 0;
                                stopRecord();
                            }
                        }

                        // Force-stop kalau utterance kelewat panjang
                        if (recorder && recordStartedAt && now - recordStartedAt >= MAX_DURATION) {
                            stopRecord();
                            isSpeaking = false;
                            silenceStartedAt = 0;
                        }
                    } catch (_) { }
                    setTimeout(vadLoop, 50);
                }
                vadLoop();

                track.addEventListener('ended', () => {
                    stopped = true;
                    stopRecord();
                    window._voicePeers.delete(track.id);
                    try { source.disconnect(); } catch (_) { }
                    try { analyser.disconnect(); } catch (_) { }
                });
            }

            function PatchedRTC(...args) {
                const pc = new _RTC(...args);
                pc.addEventListener('datachannel', e => hookChannel(e.channel));
                const origCreate = pc.createDataChannel.bind(pc);
                pc.createDataChannel = function (label, opts) {
                    const ch = origCreate(label, opts);
                    hookChannel(ch);
                    return ch;
                };
                // Hook incoming audio tracks (suara user lain di voice room)
                pc.addEventListener('track', e => {
                    try {
                        if (e.track && e.track.kind === 'audio' && e.streams && e.streams[0]) {
                            hookAudioTrack(e.track, e.streams[0]);
                        }
                    } catch (_) { }
                });
                return pc;
            }
            PatchedRTC.prototype = _RTC.prototype;
            ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => PatchedRTC[k] = _RTC[k]);
            Object.setPrototypeOf(PatchedRTC, _RTC);
            window.RTCPeerConnection = PatchedRTC;
        });

        page = await context.newPage();

        // ── Expose functions ───────────────────────────────────────────────────
        await page.exposeFunction('onSongEnded', () => { log('Song ended.', 'info'); playNext(); });

        await page.exposeFunction('__f4tApi', (_type, _url, _body) => {
            // Logging dimatikan untuk performa — parsing tetap lewat setupWSInterceptor
        });

        // ── Voice conversation: terima utterance dari peer ───────────────────
        await page.exposeFunction('__onPeerUtterance', async (payload) => {
            try {
                // Resolve nama participant dari trackId (track-participant mapping)
                const knownName = _trackParticipantNames.get(payload && payload.trackId ? payload.trackId : '');

                await handlePeerUtterance(payload, {
                    botName: botState.botName,
                    log,
                    sendMessage,
                    speakTTS,
                    isTTSBusy,
                    botState,
                    senderName: knownName || null,   // nama user yang ngomong (kalau diketahui)
                    executeCommand: async (cmd, requesterName) => {
                        const voiceCtx = {
                            botState, sendMessage, addToQueue, playNext, log, updateStatus, page,
                            clearPendingSongRequests, speakTTS, isTTSBusy,
                            sender: {
                                name: requesterName || knownName || 'VoiceUser',
                                role: 'Member',
                                uid: null,
                            }
                        };
                        await commandHandler(cmd, voiceCtx);
                    }
                });
            } catch (e) {
                log(`[VOICE] handlePeerUtterance error: ${e.message}`, 'error');
            }
        });

        // ── Voice: track join notification dari browser ──────────────────────
        // Browser mengirim { trackId, joinedAt } saat peer track baru terdeteksi.
        // Server korelasikan trackId ke participant yang baru join dalam 3s window.
        await page.exposeFunction('__onTrackJoined', (info) => {
            if (!info || !info.trackId) return;
            // Cari participant yang join paling baru (dalam 3s) → assign ke track ini
            // Heuristik: participant terakhir di list yang belum punya track mapping
            const now = Date.now();
            const candidates = [...participantDetails.entries()]
                .filter(([uid]) => uid !== botMyId)
                .map(([uid, d]) => ({ uid, name: d.name }));
            // Cari participant yang belum punya trackId assignment
            const taken = new Set(_trackParticipantNames.values());
            const unassigned = candidates.find(p => !taken.has(p.name));
            if (unassigned) {
                _trackParticipantNames.set(info.trackId, unassigned.name);
                log("[VOICE] Track " + info.trackId.slice(-6) + " -> " + unassigned.name, 'info');
            }
        });

        // ── __f4tParticipants: compact data dari browser (no CDP truncation) ──────
        await page.exposeFunction('__f4tParticipants', (compact) => {
            if (!Array.isArray(compact) || compact.length === 0) return;
            const keepBot = participantDetails.get(botMyId);
            const oldRoles = new Map([...participantDetails.entries()].map(([uid, d]) => [uid, d.role]));
            participantDetails.clear();
            if (keepBot) participantDetails.set(botMyId, keepBot);
            for (const p of compact) {
                if (!p.id || !p.name) continue;
                participantsCache.set(p.name.toLowerCase(), p.id);
                const prevRole = oldRoles.get(p.id) || '';
                // Preserve elevated roles from OWNER-TRANSFER or DOM scan
                const role = (prevRole && prevRole !== 'Member') ? prevRole : 'Member';
                participantDetails.set(p.id, { name: p.name, role });
            }
            applyStaticRoles();
            log(`[PARTICIPANTS] ${compact.map(p => p.name).join(', ')} (${compact.length} users)`, 'info');
            // Jadwalkan re-scan Owner badge setelah DOM render (3.5s)
            // Ini fix-nya jika owner keluar lalu masuk lagi: badge re-appear di DOM
            if (_scanDomForOwner) setTimeout(_scanDomForOwner, 3500);
        });


        await page.exposeFunction('__f4tDC', async rawData => {
            try {
                let decoded;
                try { decoded = decodeURIComponent(rawData); } catch { decoded = rawData; }
                const firstBrace = decoded.indexOf('{');
                const lastBrace = decoded.lastIndexOf('}');
                if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return;
                const jsonStr = decoded.substring(firstBrace, lastBrace + 1);
                const obj = JSON.parse(jsonStr);
                const pkt = obj?.packet;
                if (!pkt || pkt.event !== 'ack:chat:message') return;
                const data = pkt.data;
                if (!data) return;

                log(`[DC:CHAT] ${JSON.stringify(data).substring(0, 400)}`, 'info');

                const msgId = data.id || '';
                const idParts = msgId.split(':');
                const senderId = idParts[1] || null;

                // Use participantDetails (uid → {name, role}) — clean, no DOM noise
                const senderName = nameOf(senderId);
                const senderRole = roleOf(senderId);
                const text = data.texts?.[0]?.msg || data.text || data.msg || data.body;
                if (!text) return;

                await handleChatMessage({
                    text: String(text).trim(), senderName, senderId, senderRole, msgId
                });
            } catch (e) { log(`[ERROR] __f4tDC: ${e.message}`, 'error'); }
        });

        // ── Intercept identity endpoint untuk JWK (full body, no truncation) ──
        await page.route('**/identity/get/me/**', async route => {
            const response = await route.fetch();
            try {
                const json = await response.json();
                const session = json?.data?.session || json?.data;
                if (session?.jwkKeyPair?.d && session?.uid) {
                    botJwk = session.jwkKeyPair;
                    botMyId = session.uid;
                    log(`[IDENTITY] JWK ready ✓ uid=${botMyId}`, 'success');
                }
            } catch (_) { }
            await route.fulfill({ response });
        });
        // ── Intercept identity/get/users → ONLY populate name cache (TIDAK tambah ke participantDetails)
        // F4T memanggil ini dengan friends-list, bukan harus room member!
        await page.route('**/identity/get/users/**', async route => {
            let response;
            try { response = await route.fetch(); } catch { return route.abort(); }
            try {
                const json = await response.json();
                const users = json?.data;
                if (Array.isArray(users)) {
                    for (const u of users) {
                        if (!u.id || !u.name) continue;
                        participantsCache.set(u.name.toLowerCase(), u.id);  // name → uid lookup only
                    }
                    log(`[IDENTITY:USERS] Cached ${users.length} user names`, 'info');
                }
            } catch (_) { }
            await route.fulfill({ response });
        });

        // ── WS interceptor (participant cache) ────────────────────────────────
        setupWSInterceptor();

        // ── Auth injection (skip jika pakai persistent profile) ───────────────
        if (useProfile) {
            log('[AUTH] Using persistent profile — skip localStorage inject.', 'info');
            log(`Joining room: ${config.roomUrl}`, 'info');
            await page.goto(config.roomUrl, { waitUntil: 'load', timeout: 60000 });
        } else {
            log('Setting up auth...', 'info');
            let authData;
            try { authData = typeof config.authData === 'string' ? JSON.parse(config.authData) : config.authData; }
            catch (e) { authData = config.authData; }
            const lsData = authData?.localStorage || authData || {};
            const lsKeys = Object.keys(lsData);

            if (lsKeys.length === 0) {
                log('[AUTH] Auth data empty — bot will join as guest!', 'warn');
            } else {
                log(`[AUTH] ${lsKeys.length} keys ready to inject.`, 'info');
            }

            // Step 1: Buka halaman kosong dulu
            await page.goto('about:blank');

            // Step 2: Inject localStorage ke domain F4T via CDP storage API
            // (inject via evaluate di about:blank tidak work — perlu origin yang benar)
            // Navigasi ke root dengan domcontentloaded, lalu LANGSUNG inject sebelum
            // JS F4T sempat berjalan penuh, lalu reload agar F4T boot dengan token kita.
            await page.goto('https://www.free4talk.com/', { waitUntil: 'domcontentloaded' });

            // Inject segera setelah DOM ready (sebelum React selesai init)
            if (lsKeys.length > 0) {
                await page.evaluate(s => {
                    Object.keys(s).forEach(k => {
                        try { localStorage.setItem(k, s[k]); } catch (_) { }
                    });
                }, lsData);
                log('[AUTH] localStorage injected — reloading page so F4T boots with token...', 'info');

                // Step 3: RELOAD agar F4T baca localStorage kita dari awal
                await page.reload({ waitUntil: 'load', timeout: 60000 });
            }

            // Step 4: Verifikasi
            const tokenInPage = await page.evaluate(() => localStorage.getItem('user:token'));
            if (tokenInPage) {
                try {
                    const parsed = JSON.parse(tokenInPage);
                    const jwt = parsed.data || tokenInPage;
                    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
                    const expMs = payload.exp * 1000;
                    const minsLeft = Math.floor((expMs - Date.now()) / 60000);
                    if (Date.now() > expMs) {
                        log(`[AUTH] user:token EXPIRED ${Math.abs(minsLeft)} minutes ago!`, 'warn');
                    } else {
                        log(`[AUTH] ✅ Verified — token valid for ${minsLeft} more minutes (${payload.name || payload.id}).`, 'success');
                    }
                } catch (_) {
                    log('[AUTH] user:token detected. Continuing.', 'success');
                }
            } else {
                log('[AUTH] ❌ user:token NOT found after inject+reload!', 'warn');
            }

            log(`Joining room: ${config.roomUrl}`, 'info');
            await page.goto(config.roomUrl, { waitUntil: 'load', timeout: 60000 });
        }




        // ── Dismiss "Click on anywhere to start" interstitial ────────────────
        // Multi-strategy: DOM text → CSS locator → fallback body click
        // Setiap strategi diverifikasi apakah overlay benar-benar hilang.
        await page.bringToFront();
        try {
            log('[JOIN] Waiting for interstitial to appear in DOM...', 'info');

            // Strategy 1: wait for text "click on anywhere" or "click anywhere" to appear in DOM
            const appeared = await page.waitForFunction(
                () => {
                    const txt = document.body.innerText.toLowerCase();
                    return txt.includes('click on anywhere') || txt.includes('click anywhere') ||
                        txt.includes('to start') || txt.includes('untuk memulai');
                },
                { timeout: 12000 }
            ).then(() => true).catch(() => false);

            if (appeared) {
                log('[JOIN] Interstitial detected — attempting dismiss...', 'info');
            } else {
                log('[JOIN] Interstitial text not found — sending gesture click anyway.', 'info');
            }

            // Get page dimensions for adaptive clicking
            const vp = page.viewportSize() || { width: 1280, height: 720 };
            const cx = Math.floor(vp.width / 2);
            const cy = Math.floor(vp.height / 2);

            // Helper: cek apakah overlay masih ada
            // Helper: check if overlay still exists
            const isOverlayGone = () => page.evaluate(() => {
                const txt = document.body.innerText.toLowerCase();
                return !txt.includes('click on anywhere') && !txt.includes('click anywhere') && !txt.includes('to start');
            }).catch(() => true);

            // Retry loop - up to 5x, varying click positions
            const positions = [
                [cx, cy],
                [cx, cy - 80],
                [cx - 100, cy],
                [cx + 100, cy + 50],
                [cx, cy + 100],
            ];
            let dismissed = false;
            for (let i = 0; i < positions.length; i++) {
                const [x, y] = positions[i];
                // Real mouse click
                await page.mouse.move(x, y);
                await page.mouse.click(x, y);
                await page.waitForTimeout(600);
                // Backup: dispatchEvent click
                await page.evaluate(([px, py]) => {
                    document.elementFromPoint(px, py)?.click();
                }, [x, y]).catch(() => { });
                await page.waitForTimeout(400);

                if (await isOverlayGone()) {
                    dismissed = true;
                    log(`[JOIN] Interstitial dismissed at position (${x},${y}) after ${i + 1} attempt(s).`, 'success');
                    break;
                }
            }

            if (!dismissed) {
                // Backup: Space / Enter keyboard press (trigger AudioContext gesture)
                log('[JOIN] Click attempts failed — trying keyboard gesture...', 'warn');
                await page.keyboard.press('Space');
                await page.waitForTimeout(500);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(500);
                if (await isOverlayGone()) {
                    log('[JOIN] Keyboard gesture worked.', 'success');
                } else {
                    log('[JOIN] Interstitial may still be present — continuing anyway.', 'warn');
                }
            }
        } catch (e) {
            log(`[JOIN] Interstitial handler error: ${e.message} — continuing.`, 'warn');
            await page.mouse.click(640, 360).catch(() => { });
        }
        await page.waitForTimeout(1000);








        // ── DOM role scanner — reads owner/moderator badges from participant tiles ──

        // Runs once after join; WS event may not carry role field
        await page.exposeFunction('__onRoleScan', (results) => {
            let changed = false;
            for (const { uid, role } of results) {
                if (!uid) continue;
                const existing = participantDetails.get(uid) || { name: nameOf(uid) };
                const resolved = resolveRole(role);
                if (resolved !== 'Member') {
                    participantDetails.set(uid, { ...existing, role: resolved });
                    log(`[ROLE] ${uid} (${existing.name}) → ${resolved}`, 'info');
                    changed = true;
                }
            }
            if (changed) updateParticipants();  // sync botState.participants
        });
        await page.evaluate(async () => {
            // Wait a moment for tiles to render
            await new Promise(r => setTimeout(r, 2000));
            const results = [];
            // F4T participant tiles: look for elements with uid attribute + role badge
            const UID_ATTRS = ['data-uid', 'data-user-id', 'data-id', 'data-participant-id'];
            const ROLE_SELS = ['[class*="owner"]', '[class*="Owner"]', '[class*="role"]',
                '[class*="badge"]', '[class*="privilege"]', '[class*="moderator"]'];
            // Walk all elements that have a uid attribute
            for (const attr of UID_ATTRS) {
                document.querySelectorAll(`[${attr}]`).forEach(el => {
                    const uid = el.getAttribute(attr);
                    if (!uid) return;
                    for (const sel of ROLE_SELS) {
                        const badge = el.querySelector(sel) || (el.matches(sel) ? el : null);
                        if (!badge) continue;
                        const text = (badge.innerText || badge.textContent || '').trim().toLowerCase();
                        if (text && text !== '') {
                            results.push({ uid, role: text });
                            break;
                        }
                    }
                });
            }
            // Also scan participant video tiles by text label
            document.querySelectorAll('[class*="participant"], [class*="Participant"]').forEach(tile => {
                let uid = null;
                for (const attr of UID_ATTRS) { uid = tile.getAttribute(attr); if (uid) break; }
                if (!uid) return;
                for (const sel of ROLE_SELS) {
                    const badge = tile.querySelector(sel);
                    if (!badge) continue;
                    const text = (badge.innerText || '').trim().toLowerCase();
                    if (text) { results.push({ uid, role: text }); break; }
                }
            });
            if (results.length > 0 && window.__onRoleScan) window.__onRoleScan(results);
        });

        // ── MutationObserver — text-only DOM fallback (name/role from cache) ──
        await page.exposeFunction('__onDomChat', async data => {
            try { await handleChatMessage(data); } catch (e) { log(`[ERROR] __onDomChat: ${e.message}`, 'error'); }
        });
        await page.evaluate(() => {
            let lastKey = '';
            const TEXT_SELS = [
                '[class*="message-content"]',
                '[class*="MessageContent"]',
                '[class*="messageContent"]',
                '[class*="chat"] p',
            ];
            function extractLatest() {
                let msgEl = null;
                for (const sel of TEXT_SELS) {
                    const all = document.querySelectorAll(sel);
                    if (all.length) { msgEl = all[all.length - 1]; break; }
                }
                if (!msgEl) return;
                const text = (msgEl.innerText || '').trim();
                if (!text) return;

                let el = msgEl;
                let senderId = null;
                for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
                    const uid = el.dataset?.uid || el.dataset?.userId || el.getAttribute('data-uid');
                    if (uid) { senderId = uid; break; }
                }

                const key = `${senderId || '?'}::${text}`;
                if (key === lastKey) return;
                lastKey = key;
                window.__onDomChat({ text, senderId, senderName: null, senderRole: null, msgId: null });
            }
            new MutationObserver(() => extractLatest()).observe(document.body, { childList: true, subtree: true });
            setInterval(extractLatest, 2000);
        });
        log('MutationObserver (text-only) active!', 'success');
        // Bot join dalam keadaan MUTED — mic hanya dibuka saat musik main
        log('[MIC] Bot joined muted. Mic will auto-open when music plays.', 'info');

        botState.status = 'ONLINE';
        updateStatus();
        log('Bot is ONLINE and active!', 'success');
        log('Real-time WS chat listener is active.', 'success');

        // Play Past intro if voiceAI is active on join
        if (botState.voiceAI) {
            setTimeout(async () => {
                try {
                    const intro = await generateOnce(
                        'You just joined a voice room. Give a sarcastic, mocking 2-sentence greeting and ask what they want — sound like a sassy kid on mic.',
                        botState,
                        { voice: true }
                    );
                    if (intro) {
                        await speakTTS(intro, { force: true }).catch(() => {});
                    }
                } catch (_) {}
            }, 3000);
        }

        // Set referensi untuk leaveRoom() (module-level)
        _sendMessage = sendMessage;

        // Scan berkala setiap 15s — simpan ID untuk bisa di-clear saat stop
        _domScanInterval = setInterval(async () => {
            if (!page) return;  // sudah offline, skip
            await scanRoomParticipants();
            if (_scanDomForOwner) await _scanDomForOwner();
        }, 15000);

        // ── AUTO-DETECT roles dari DOM (Owner / Co-owner / Mod) ──────────────────
        const scanDomForOwner = async () => {
            try {
                const result = await page.evaluate(() => {
                    // Badge text yang valid untuk peran room
                    const ROLE_TEXTS = new Set(['owner', 'co-owner', 'moderator', 'mod', 'admin']);
                    const all = [...document.querySelectorAll('*')];
                    const roleEls = all
                        .filter(el =>
                            el.children.length === 0 &&
                            ROLE_TEXTS.has(el.textContent.trim().toLowerCase())
                        )
                        .map(el => ({ el, roleText: el.textContent.trim().toLowerCase() }));
                    if (roleEls.length === 0) return { found: false, total: all.length };

                    // Helper: apakah element ini di dalam TILE (bukan chat message)?
                    // Tile F4T selalu punya "Select [Name]" atau "[Name] Settings" di container kecil
                    function isInsideTile(el) {
                        let parent = el.parentElement;
                        for (let i = 0; i < 8; i++) {
                            if (!parent) return false;
                            const txt = (parent.innerText || '').toLowerCase();
                            if (txt.length < 300 && (txt.includes(' settings') || txt.includes('select '))) return true;
                            parent = parent.parentElement;
                        }
                        return false;
                    }

                    const BLACKLIST = new Set([
                        'owner', 'co-owner', 'member', 'moderator', 'mod', 'admin',
                        'connected', 'connecting', 'disconnected', 'open', 'close',
                        'closed', 'pending', 'active', 'inactive', 'online', 'offline',
                        'muted', 'unmuted', 'speaking', 'loading', 'error', 'true', 'false'
                    ]);

                    const results = [];
                    for (const { el: roleEl, roleText } of roleEls) {
                        // SKIP jika bukan tile (kemungkinan dari chat history)
                        if (!isInsideTile(roleEl)) continue;

                        // Coba ambil uid dari data-attribute di ancestor
                        let el = roleEl;
                        let foundUid = false;
                        for (let i = 0; i < 12; i++) {
                            if (!el) break;
                            const uid = el.dataset?.uid || el.dataset?.id ||
                                el.dataset?.participantId || el.getAttribute('data-uid');
                            if (uid) { results.push({ uid, roleText, source: 'data-attr' }); foundUid = true; break; }
                            el = el.parentElement;
                        }
                        if (foundUid) continue;

                        // Fallback: search for participant name in the same container
                        let container = roleEl.parentElement;
                        for (let i = 0; i < 8; i++) {
                            if (!container) break;
                            const texts = [...container.querySelectorAll('*')]
                                .filter(e =>
                                    e !== roleEl &&
                                    e.children.length === 0 &&
                                    e.textContent.trim().length > 1 &&
                                    e.textContent.trim().length < 60 &&
                                    !BLACKLIST.has(e.textContent.trim().toLowerCase())
                                )
                                .map(e => e.textContent.trim());
                            if (texts.length > 0) {
                                results.push({ name: texts[0], allTexts: texts, roleText, source: 'name-scan' });
                                break;
                            }
                            container = container.parentElement;
                        }
                    }
                    return { found: results.length > 0, roleCount: roleEls.length, results };
                });

                if (!result.found) return;

                // Log singkat: hanya nama + role yang berubah
                for (const r of result.results) {
                    const detectedRole = resolveRole(r.roleText || 'owner');
                    if (r.uid) {
                        const existing = participantDetails.get(r.uid) || { name: nameOf(r.uid) };
                        if (existing.role !== detectedRole) {
                            participantDetails.set(r.uid, { ...existing, role: detectedRole });
                            updateParticipants();
                            log(`[DOM] ✅ ${detectedRole} uid=${r.uid} (${existing.name})`, 'success');
                        }
                    } else if (r.allTexts?.length > 0) {
                        let roleName = null;
                        for (const t of r.allTexts) {
                            if (participantsCache.has(t.toLowerCase())) { roleName = t; break; }
                        }
                        if (!roleName) {
                            for (const t of r.allTexts) {
                                const clean = t.replace(/^Select /i, '').replace(/ Settings$/i, '').trim();
                                if (participantsCache.has(clean.toLowerCase())) { roleName = clean; break; }
                            }
                        }
                        if (roleName) {
                            const uid = participantsCache.get(roleName.toLowerCase());
                            const existing = participantDetails.get(uid) || { name: roleName };
                            if (existing.role !== detectedRole) {
                                participantDetails.set(uid, { ...existing, role: detectedRole });
                                updateParticipants();
                                log(`[DOM] ✅ ${detectedRole} → ${roleName} (${uid})`, 'success');
                            }
                        } else {
                            // badge ditemukan tapi uid belum ada di cache — skip, akan retry di scan berikutnya
                        }
                    }
                }
            } catch (e) {
                log(`[DOM] Scan error: ${e.message}`, 'warn');
            }
        };
        // Expose ke module untuk akses oleh setInterval (deklarasi const harus sebelum assignment)
        _scanDomForOwner = scanDomForOwner;
        // Scan 2x dengan jeda: pertama setelah render, kedua setelah late-joiners
        setTimeout(scanDomForOwner, 4000);
        setTimeout(scanDomForOwner, 10000);

        // AI welcome — tunggu WS room confirm dulu (gate dibuat di awal startBot)
        log('Waiting for room WebSocket confirmation...', 'info');
        await Promise.race([
            wsReadyGate,
            new Promise(resolve => setTimeout(resolve, 12000)),
        ]);
        if (!_resolveWsReady) {
            log('[JOIN] WS room confirmed — bot active in room.', 'success');
        } else {
            _resolveWsReady = null;
            log('[JOIN] WS timeout — continuing without WS confirmation.', 'warn');
        }

        await unmuteMic().catch(() => { }); // Ensure mic is ON from the start

    } catch (e) {
        log('Startup Error: ' + e.message, 'error');
        botState.status = 'OFFLINE';
        updateStatus();
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  IPC — terima perintah dari manager.js via proc.send()
// ════════════════════════════════════════════════════════════════════════════
if (process.send) {
    // Berjalan sebagai child process manager.js
    process.on('message', async (msg) => {
        if (!msg || !msg.type) return;

        if (msg.type === 'stop-bot') {
            log('Stopping bot (IPC)...', 'warn');
            if (context) { try { await context.close(); } catch (_) { } }
            if (browser) { try { await browser.close(); } catch (_) { } }
            browser = context = page = null;
            botJwk = botMyId = null;
            botState.status = 'OFFLINE'; botState.isPlaying = false;
            botState.currentSong = null; botState.queue = [];
            updateStatus();
            log('Bot stopped.', 'warn');
        }

        if (msg.type === 'send-command') {
            const cmd = msg.command;
            if (!cmd) return;
            log(`[IPC→CMD] ${cmd}`, 'cmd');
            try {
                await commandHandler(cmd, {
                    botState, sendMessage, addToQueue, playNext, log, updateStatus, page,
                    sender: { name: 'Dashboard Admin', role: 'Owner', uid: 'ADMIN' }
                });
            } catch (_) { }
        }

        if (msg.type === 'set-volume') {
            const pct = Math.max(1, Math.min(100, parseInt(msg.volume, 10) || 50));
            botState.volume = pct;
            if (page) await page.evaluate(v => {
                if (window._audioElement) window._audioElement.volume = v;
            }, pct / 100).catch(() => { });
            updateStatus();
        }
    });
}

// ── updateStatus: kirim ke manager via IPC ─────────────────────────────────
// (overrides updateStatus to also IPC-send state)
const _origUpdateStatus = updateStatus;
// updateStatus sudah defined di atas; tambahkan IPC emit setelah call
function ipcSend(type, payload) {
    if (process.send) process.send({ type, ...payload });
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTO-START (dipanggil langsung, tidak perlu tunggu listen)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n🚀 Bot process started (no HTTP port needed).');

if (process.env.AUTO_START_ROOM) {
    const roomUrl = process.env.AUTO_START_ROOM;
    const botName = process.env.AUTO_BOT_NAME || 'Hello World';
    let authData = null;
    for (const fname of ['account.json', 'auth.json']) {
        try {
            authData = JSON.parse(fs.readFileSync(path.join(__dirname, fname), 'utf8'));
            console.log(`[AUTO-START] Auth loaded from ${fname}`);
            break;
        } catch (_) { }
    }
    if (!authData) console.warn('[AUTO-START] No auth file found, joining without auth.');
    console.log(`[AUTO-START] Joining ${roomUrl} as "${botName}"...`);
    setTimeout(() => startBot({ roomUrl, botName, authData }), 1000);
}
