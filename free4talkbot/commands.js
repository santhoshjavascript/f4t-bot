const fs = require('fs');
const path = require('path');
const OLLAMA_API_KEY = '';
const yts = require('yt-search');

const economy = require('./economy.js');
let userMap = new Map();

// ── Time helpers ────────────────────────────────────────────────────────────
/** "3:45" or "1:23:45" → seconds */
function parseDuration(ts) {
    if (!ts) return 0;
    const parts = String(ts).split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return Number(parts[0]) || 0;
}

/** seconds → "m:ss" or "h:mm:ss" */
function formatSec(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

/** 0.0-1.0 → [████░░░░░░░░] */
function buildBar(progress, width = 12) {
    const filled = Math.round(Math.min(1, Math.max(0, progress)) * width);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

const plugins = {};
const pluginCommands = new Map();

function loadPlugins() {
    const pluginDir = path.join(__dirname, 'plugins');
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir);

    try {
        const economyPath = path.join(__dirname, 'economy.js');
        delete require.cache[require.resolve(economyPath)];
    } catch (e) { }

    fs.readdirSync(pluginDir).forEach(file => {
        if (file.endsWith('.js')) {
            try {
                const pluginPath = path.join(pluginDir, file);
                delete require.cache[require.resolve(pluginPath)];
                const plugin = require(pluginPath);

                for (const [cmd, pFile] of pluginCommands.entries()) {
                    if (pFile === file) pluginCommands.delete(cmd);
                }

                plugins[file] = plugin;

                if (plugin.commands) {
                    plugin.commands.forEach(cmd => pluginCommands.set(cmd, file));
                }
                process.stdout.write(`Loaded plugin: ${file}\n`);
            } catch (err) {
                console.error(`❌ Failed to load plugin ${file}:`, err);
            }
        }
    });
}
loadPlugins();

module.exports = async function handleCommand(msg, { botState, sendMessage, addToQueue, playNext, log, updateStatus, page, sender, speakTTS, isTTSBusy, clearPendingSongRequests }) {
    if (!msg || typeof msg !== 'string') return;

    msg = msg.trim();
    if (!msg) return;

    loadPlugins();

    let cmd = msg.split(' ')[0].toLowerCase();
    
    if (botState.wyr && botState.wyr.active) {
        if (msg.toLowerCase() === 'a') cmd = '!a';
        if (msg.toLowerCase() === 'b') cmd = '!b';
    }

    const firstSpaceIdx = msg.indexOf(' ');
    let args = firstSpaceIdx === -1 ? '' : msg.substring(firstSpaceIdx + 1).trim();

    if (cmd.startsWith('!vol') && cmd.length > 4) {
        args = cmd.substring(4) + (args ? ' ' + args : '');
        cmd = '!vol';
    }

    const cleanCmd = cmd.startsWith('!') ? cmd.substring(1) : cmd;
    if (cmd.startsWith('!') && pluginCommands.has(cleanCmd)) {
        const pluginName = pluginCommands.get(cleanCmd);
        const plugin = plugins[pluginName];

        try {
            console.log(`🔌 Plugin Command: ${cleanCmd}`);
            const db = economy.loadEconomyDB();
            await plugin.handle(cleanCmd, args, msg, {
                botState, sendMessage, addToQueue, log, updateStatus, page, sender, userMap, db,
                speakTTS, isTTSBusy, clearPendingSongRequests
            });
            return;
        } catch (error) {
            console.error(`Error executing plugin command ${cleanCmd}:`, error);
            await sendMessage('❌ An error occurred in the plugin.');
            return;
        }
    }

    if (cmd === '!play' || cmd === '!p') {
        if (!args) return await sendMessage('❓ Please enter a song title. Example: !play lofi');

        const choice = parseInt(args);
        if (!isNaN(choice) && botState.searchResults && botState.searchResults.length > 0) {
            if (choice >= 1 && choice <= botState.searchResults.length) {
                const selected = botState.searchResults[choice - 1];
                botState.searchResults = [];
                await addToQueue(selected.url, sender.name);
                return;
            }
        }

        await addToQueue(args, sender.name);
    }
    else if (cmd === '!search') {
        if (!args) return await sendMessage('❓ Please enter a song title to search. Example: !search lofi');

        log(`Searching for: "${args}"...`, 'info');
        await sendMessage(`🔍 Searching top 10 results for: "${args}"...`);

        try {
            const r = await yts(args);
            const videos = r.videos.slice(0, 10);

            if (videos.length === 0) {
                return await sendMessage('❌ No results found for that search.');
            }

            botState.searchResults = videos;

            let response = `🔎 Search Results for: "${args}"\n\n`;
            videos.forEach((v, i) => {
                response += `${i + 1}. ${v.title} (${v.timestamp})\n`;
            });
            response += `\n💡 Type !play [number] to play.`;

            await sendMessage(response.trim());
        } catch (e) {
            log('Search Error: ' + e.message, 'error');
            await sendMessage('❌ An error occurred during search.');
        }
    }
    else if (cmd === '!skip' || cmd === '!s') {
        if (!botState.currentSong) return await sendMessage('❓ No music is currently playing.');

        log(`Skipping... (by ${sender.name})`, 'cmd');
        await sendMessage(`⏩ Skipping... (Requested by ${sender.name})`);
        botState.isRepeating = false;
        botState.isPlaying = false;
        if (page) await page.evaluate(() => {
            if (window._audioElement) { window._audioElement.pause(); window._audioElement.src = ''; }
        }).catch(() => { });
        await playNext();
    }
    else if (cmd === '!stop') {
        if (typeof clearPendingSongRequests === 'function') clearPendingSongRequests();
        botState.queue = [];
        botState.isRepeating = false;
        botState.isPlaying = false;
        botState.currentSong = null;
        if (page) await page.evaluate(() => {
            if (window._audioElement) { window._audioElement.pause(); window._audioElement.src = ''; }
        }).catch(() => { });
        log(`Stopped & Queue cleared (by ${sender.name}).`, 'warn');
        updateStatus();
        await sendMessage(`⏹️ Music stopped & Queue cleared by ${sender.name}.`);
    }
    else if (cmd === '!repeat' || cmd === '!r') {
        botState.isRepeating = !botState.isRepeating;
        updateStatus();
        await sendMessage(botState.isRepeating ? '🔄 Repeat ON' : '🔄 Repeat OFF');
    }
    else if (cmd === '!autoplay' || cmd === '!ap') {
        botState.autoPlay = !botState.autoPlay;
        updateStatus();
        await sendMessage(botState.autoPlay ? '📻 AutoPlay ON (Radio Mode)' : '📻 AutoPlay OFF');
    }
    else if (cmd === '!np') {
        if (!botState.currentSong) return await sendMessage('❓ No music is currently playing.');

        const s = botState.currentSong;
        let elapsed = 0, audioDur = 0;

        if (page) {
            try {
                const info = await page.evaluate(() => ({
                    currentTime: window._audioElement?.currentTime || 0,
                    duration: window._audioElement?.duration || 0
                }));
                elapsed = Math.floor(info.currentTime);
                audioDur = isFinite(info.duration) ? Math.floor(info.duration) : 0;
            } catch (_) { }
        }

        const totalSec = audioDur || parseDuration(s.duration);
        const remaining = Math.max(0, totalSec - elapsed);
        const progress = totalSec > 0 ? elapsed / totalSec : 0;

        let npMsg = `🎵 *${s.title}*\n`;
        npMsg += `👤 Requested by: ${s.requestedBy}\n`;
        if (totalSec > 0) {
            npMsg += `${buildBar(progress)} ${formatSec(elapsed)} / ${formatSec(totalSec)}\n`;
            npMsg += `⏳ Finishing in: ${formatSec(remaining)}`;
        } else {
            npMsg += `⏳ Duration unavailable`;
        }

        await sendMessage(npMsg);
    }
    else if (cmd === '!queue' || cmd === '!q') {
        let elapsed = 0;
        if (page && botState.currentSong) {
            try {
                const info = await page.evaluate(() => ({ currentTime: window._audioElement?.currentTime || 0 }));
                elapsed = Math.floor(info.currentTime);
            } catch (_) { }
        }

        if (!botState.currentSong && botState.queue.length === 0)
            return await sendMessage('❓ Queue is empty and no music is playing.');

        let response = '';

        if (botState.currentSong) {
            const s = botState.currentSong;
            const dur = parseDuration(s.duration);
            const rem = dur > 0 ? Math.max(0, dur - elapsed) : 0;
            const prog = dur > 0 ? elapsed / dur : 0;
            const durStr = s.duration ? ` (${s.duration})` : '';
            const barStr = dur > 0 ? `\n${buildBar(prog)} ${formatSec(elapsed)}/${formatSec(dur)}` : '';
            const remStr = rem > 0 ? ` ⏳ ~${formatSec(rem)} left` : '';

            response += `🎵 *Now Playing*${durStr}${remStr}\n${s.title}\n👤 ${s.requestedBy}${barStr}`;
        }

        if (botState.queue.length > 0) {
            const totalQueueSec = botState.queue.reduce((sum, s) => sum + parseDuration(s.duration), 0);
            const curRem = botState.currentSong
                ? Math.max(0, parseDuration(botState.currentSong.duration) - elapsed)
                : 0;
            const totalWait = curRem + totalQueueSec;

            const list = botState.queue.map((s, i) => {
                const d = s.duration ? ` (${s.duration})` : '';
                return `${i + 1}. ${s.title}${d} — ${s.requestedBy}`;
            }).join('\n');

            const totalStr = totalQueueSec > 0 ? ` | total ${formatSec(totalQueueSec)}` : '';
            response += `\n\n📋 Queue (${botState.queue.length} songs${totalStr}):\n${list}`;

            if (totalWait > 0) {
                response += `\n\n🕒 Estimated finish: ~${formatSec(totalWait)}`;
            }
        } else {
            response += '\n\n(Next queue is empty)';
        }

        await sendMessage(response.trim());
    }
    else if (cmd === '!vol') {
        const rawArg = (args || '').trim().toLowerCase();

        // !vol max / !vol min shortcuts
        if (rawArg === 'max') {
            botState.volume = 100;
            if (page) await page.evaluate(v => {
                if (window._audioElement) window._audioElement.volume = v;
                window._botVolume = v;
            }, 1.0);
            updateStatus();
            return await sendMessage(`🔊 Volume: 100% (MAX)`);
        }
        if (rawArg === 'min') {
            botState.volume = 1;
            if (page) await page.evaluate(v => {
                if (window._audioElement) window._audioElement.volume = v;
                window._botVolume = v;
            }, 0.01);
            updateStatus();
            return await sendMessage(`🔊 Volume: 1% (MIN)`);
        }

        // !vol +N or !vol -N — increment/decrement
        if (rawArg.startsWith('+') || rawArg.startsWith('-')) {
            const delta = parseInt(rawArg, 10);
            if (!isNaN(delta)) {
                const pct  = Math.max(1, Math.min(100, (botState.volume || 10) + delta));
                const frac = pct / 100;
                botState.volume = pct;
                if (page) await page.evaluate(v => {
                    if (window._audioElement) window._audioElement.volume = v;
                    window._botVolume = v;
                }, frac);
                updateStatus();
                return await sendMessage(`🔊 Volume: ${pct}%`);
            }
        }

        const n = parseInt(rawArg, 10);
        if (isNaN(n)) {
            return await sendMessage(`🔊 Current volume: ${botState.volume}%\nUse: !vol [1-100] | !vol +10 | !vol -10 | !vol max | !vol min`);
        }

        const pct = Math.max(1, Math.min(100, n));
        const frac = pct / 100;

        botState.volume = pct;
        if (page) await page.evaluate(v => {
            if (window._audioElement) window._audioElement.volume = v;
            window._botVolume = v;
        }, frac);
        updateStatus();
        await sendMessage(`🔊 Volume: ${pct}%`);
    }
    else if (cmd === '!help') {
        const menu = [
            `🎵 --- ${botState.botName.toUpperCase()} ---`,
            '▶ !play [title/number] - Play music',
            '🔍 !search [title] - Search top 10 songs',
            '⏩ !skip - Skip current song',
            '🔄 !repeat - Repeat this song',
            '⏹ !stop - Stop & clear queue',
            '📋 !queue - View song queue',
            '🎵 !np - Current song info',
            '🔊 !vol [1-100 / max / +10 / -10] - Adjust volume',
            '🎤 !lirik - Search lyrics for current song',
            '❓ !help - Help menu'
        ].join('\n');
        await sendMessage(menu);
    }
    else if (cmd === '!lirik') {
        let query = args;
        if (!query && botState.currentSong) {
            query = botState.currentSong.title;
        }

        if (!query) {
            return await sendMessage('❓ Play a song first or type: !lirik [song title]');
        }

        const cleanQuery = query
            .replace(/official (lyric video|music video|video|audio)/gi, '')
            .replace(/\blirik( & terjemahan)?\b/gi, '')
            .replace(/\blyrics?( & translation)?\b/gi, '')
            .replace(/\bfull album\b/gi, '')
            .replace(/\[.*?\]/g, '')
            .replace(/\(.*?\)/g, '')
            .replace(/\|.*/, '')
            .replace(/\s{2,}/g, ' ')
            .trim();

        const dashParts = cleanQuery.split(' - ').map(s => s.trim()).filter(Boolean);
        const ytArtist  = dashParts.length >= 2 ? dashParts[0] : '';
        const ytTrack   = dashParts.length >= 2 ? dashParts.slice(1).join(' - ') : cleanQuery;

        log(`Searching lyrics: "${ytTrack}" by "${ytArtist || '?'}" via lrclib.net...`, 'info');
        await sendMessage(`🔍 Searching lyrics for: ${cleanQuery}...`);

        let lirik = '';
        try {
            const tryLrc = async (track, artist) => {
                const url = 'https://lrclib.net/api/search?track_name=' + encodeURIComponent(track)
                          + (artist ? '&artist_name=' + encodeURIComponent(artist) : '');
                const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0 && data[0].plainLyrics) return data[0];
                return null;
            };
            let hit = null;
            if (ytArtist) hit = await tryLrc(ytTrack, ytArtist);
            if (!hit)     hit = await tryLrc(ytTrack, '');
            if (!hit)     hit = await tryLrc(cleanQuery, '');
            if (hit) {
                lirik = hit.plainLyrics;
                log(`lrclib ✅ "${hit.trackName}" - ${hit.artistName}`, 'info');
            }
        } catch (e) {
            log('lrclib Error: ' + e.message, 'error');
        }

        if (!lirik || lirik.length < 20) {
            return await sendMessage('❌ Failed to find lyrics for this song.');
        }

        const lines = lirik.split('\n');
        let currentChunk = `🎤 Lyrics: ${cleanQuery}\n\n`;

        for (const line of lines) {
            if ((currentChunk + line).length > 450) {
                await sendMessage(currentChunk.trim());
                await new Promise(r => setTimeout(r, 800));
                currentChunk = '';
            }
            currentChunk += line + '\n';
        }

        if (currentChunk.trim()) {
            await sendMessage(currentChunk.trim());
        }
    }
};

module.exports.updateUserMap = function (map) {
    userMap = map;
    console.log(`User map updated: ${userMap.size} users`);
};

module.exports.CORE_COMMANDS = [
    'play', 'p', 'search', 'skip', 's', 'stop',
    'repeat', 'r', 'np', 'queue', 'q',
    'vol', 'help', 'lirik'
];

module.exports.getPluginCommands = () => pluginCommands;
