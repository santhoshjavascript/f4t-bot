/**
 * voicechat.js — toggle voice conversation mode (wake word listen via Groq STT)
 *
 * Commands:
 *   !voice on  / !listen on   → activate wake word mode (default)
 *   !voice off / !listen off  → disable all voice
 *   !voice talk               → toggle Talk Mode (responds to ALL utterances, no wake word)
 *   !talkmode [on|off]        → same as !voice talk
 *   !voice                    → status
 *
 * Owner / Mod only.
 */

const { getVoiceStatus } = require('../voice.js');

function isOwnerOrMod(sender) {
    if (!sender?.role) return false;
    const r = String(sender.role).toLowerCase().trim();
    // Use includes() to catch 'Owner', 'co-owner', 'Moderator', 'Admin', etc.
    return r.includes('owner') || r.includes('mod') || r.includes('admin') || r.includes('creator');
}

module.exports = {
    commands: ['voice', 'listen', 'talkmode'],

    handle: async (cmd, args, msg, { sender, botState, sendMessage, page, log }) => {
        const arg = String(args || '').trim().toLowerCase();

        // ── !talkmode on/off/toggle ────────────────────────────────────────
        if (cmd === 'talkmode' || arg === 'talk') {
            log?.('[VOICE] talkmode cmd - sender: ' + sender?.name + ', role: ' + JSON.stringify(sender?.role), 'info');
            if (!isOwnerOrMod(sender)) {
                log?.(`[VOICE] Permission denied for ${sender?.name} (Role: ${sender?.role})`, 'warn');
                return await sendMessage(`❌ ${sender.name}, only Owner/Mod can use talk mode.`);
            }

            // Determine target state
            let enable;
            if (arg === 'on'  || (cmd === 'talkmode' && arg === 'on'))  enable = true;
            else if (arg === 'off' || (cmd === 'talkmode' && arg === 'off')) enable = false;
            else enable = !botState.voiceTalkMode;   // toggle if no arg given

            botState.voiceTalkMode     = enable;
            botState.voiceListenActive = true;  // ensure listening is active

            log?.(`[VOICE] Talk mode ${enable ? 'ON' : 'OFF'} (by ${sender.name})`, enable ? 'success' : 'warn');

            if (enable) {
                return await sendMessage(
                    `🎙️ *Talk Mode ACTIVE*\n` +
                    `Bot will now respond to EVERYTHING said — no wake word needed.\n` +
                    `8s cooldown per user to prevent spam.\n\n` +
                    `Turn off: !talkmode off or !voice talk`
                );
            } else {
                return await sendMessage(
                    `🔇 *Talk Mode OFF* — back to wake word mode.\n` +
                    `Say "${botState.botName}" first to talk via voice.`
                );
            }
        }

        // Cek role kalau mau ubah state (status query bebas)
        if (arg === 'on' || arg === 'off') {
            if (!isOwnerOrMod(sender)) {
                return await sendMessage(`❌ ${sender.name}, only Owner/Mod can change voice listen mode.`);
            }
        }

        // ── Status ─────────────────────────────────────────────────────────
        if (!arg) {
            const status   = getVoiceStatus();
            const state    = botState?.voiceListenActive ? '🟢 ON' : '🔴 OFF';
            const talkMode = botState?.voiceTalkMode ? '🎙️ TALK MODE (responds to all)' : '🔔 Wake word mode';
            const keys     = status.sttReady ? `✅ ${status.sttKeys} key` : '❌ no key (set in stt.js)';
            return await sendMessage(
                `🎙️ *Voice Status*\n` +
                `Listen: ${state}\n` +
                `Mode  : ${talkMode}\n` +
                `STT   : ${keys}\n` +
                `Busy  : ${status.busy ? 'yes' : 'no'}\n\n` +
                `Use: !voice on/off/talk | !talkmode on/off`
            );
        }

        // ── Toggle ON ──────────────────────────────────────────────────────
        if (arg === 'on') {
            botState.voiceListenActive = true;
            if (page) await page.evaluate(() => { window._voiceListenActive = true; }).catch(() => {});
            log?.(`[VOICE] Listen mode ON (by ${sender.name})`, 'success');
            const mode = botState.voiceTalkMode ? '🎙️ Talk mode active' : `Say "${botState.botName}" + command`;
            return await sendMessage(
                `🟢 *Voice listen mode ACTIVE*\n` +
                `${mode}`
            );
        }

        // ── Toggle OFF ─────────────────────────────────────────────────────
        if (arg === 'off') {
            botState.voiceListenActive = false;
            botState.voiceTalkMode     = false;  // also disable talk mode
            if (page) await page.evaluate(() => { window._voiceListenActive = false; }).catch(() => {});
            log?.(`[VOICE] Listen mode OFF (by ${sender.name})`, 'warn');
            return await sendMessage(`🔴 *Voice listen mode OFF* — bot is no longer listening.`);
        }

        await sendMessage(`❓ Use: !voice on / off / talk | !talkmode on/off`);
    }
};
