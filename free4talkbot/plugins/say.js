/**
 * say.js — !say <text>
 * Bot speaks via TTS (Microsoft Edge Read Aloud) → broadcast to voice room
 * via virtual mic pipeline.
 *
 * Can be called:
 *   1. Directly: !say hello how are you
 *   2. Via AI natural language: user says "hello world try saying hello"
 *      → AI emits [CMD:!say hello] → command handler triggers this plugin.
 *
 * Constraints:
 *   - Rejected if !play music is active (audio output conflict).
 *   - Rejected if another TTS is still speaking.
 *   - Max 200 chars, cooldown 15s per user.
 */

const MAX_LENGTH      = 200;
const COOLDOWN_MS     = 15000;
const _userCooldowns  = new Map(); // userId → lastUsedTs

// Voice aliases (can be overridden with prefix --voice <name>)
const VOICE_ALIASES = ['ardi', 'gadis', 'aria', 'guy'];

function parseArgs(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return { text: '', voice: null };

    // Format: !say --voice aria hello world
    const voiceMatch = trimmed.match(/^--voice\s+(\w+)\s+(.+)/i);
    if (voiceMatch) {
        const v = voiceMatch[1].toLowerCase();
        if (VOICE_ALIASES.includes(v)) {
            return { text: voiceMatch[2].trim(), voice: v };
        }
    }
    return { text: trimmed, voice: null };
}

module.exports = {
    commands: ['say', 'speak'],

    handle: async (cmd, args, msg, { sender, botState, sendMessage, speakTTS, isTTSBusy, log }) => {
        if (typeof speakTTS !== 'function') {
            return await sendMessage('❌ TTS is not ready. Please restart the bot.');
        }

        const { text, voice } = parseArgs(args);

        if (!text) {
            return await sendMessage(
                `🗣️ *!say <text>* — bot speaks via voice\n` +
                `Example: !say hello everyone\n` +
                `Select voice: !say --voice aria hello (female) | --voice guy (male)\n` +
                `Max ${MAX_LENGTH} characters, cooldown ${COOLDOWN_MS / 1000}s.`
            );
        }

        if (text.length > MAX_LENGTH) {
            return await sendMessage(`❌ Too long! Max ${MAX_LENGTH} characters (you sent ${text.length}).`);
        }

        // Cooldown per user
        const userKey = sender.uid || sender.name || 'unknown';
        const lastUsed = _userCooldowns.get(userKey) || 0;
        const elapsed  = Date.now() - lastUsed;
        if (elapsed < COOLDOWN_MS) {
            const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
            return await sendMessage(`⏳ ${sender.name}, please wait ${remaining}s before using !say again.`);
        }

        // Reject if !play music is active (audio pipeline conflict)
        if (botState?.isPlaying || botState?.currentSong) {
            return await sendMessage(`❌ Music is currently playing. Stop it first using !stop, then use !say.`);
        }

        // Reject if another TTS is still speaking
        if (typeof isTTSBusy === 'function' && isTTSBusy()) {
            return await sendMessage(`❌ Bot is already speaking, please wait until it's finished.`);
        }

        // Set cooldown before calling so rapid retries don't bypass
        _userCooldowns.set(userKey, Date.now());

        try {
            await sendMessage(`🗣️ *${sender.name}* asked me to say: "${text}"`);
            await speakTTS(text, { voice: voice || 'aria' });
            // Finished — no need to send another message to avoid spam.
        } catch (e) {
            log?.(`[!say] error: ${e.message}`, 'error');
            await sendMessage(`❌ Failed to speak: ${e.message}`);
        }
    }
};
