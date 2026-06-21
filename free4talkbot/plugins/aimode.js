/**
 * aimode.js — !ai off/on/sleep + !quiet
 * Manual mute for random AI interjections. Owner/Mod only.
 * State stored in botState.aiMuteUntil (timestamp ms; 0 = active).
 *
 * Note: "!ai" / "!quiet" commands only mute AI Tier-2/3 (random + question gating).
 * Direct mentions ("hello bot", "@helloworld") still respond — so owners can unmute even if the bot is off.
 */

const PRIVILEGED_ROLES = new Set(['Owner', 'Co-owner', 'Moderator', 'Admin']);

/** Parse duration like "5m", "30s", "1h" → ms. Returns null if invalid. */
function parseDuration(input) {
    if (!input) return null;
    const m = String(input).trim().toLowerCase().match(/^(\d+)\s*(s|m|min|h|hour)?$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (isNaN(n) || n <= 0) return null;
    const unit = m[2] || 'm';
    if (unit === 's')               return n * 1000;
    if (['m', 'min'].includes(unit)) return n * 60 * 1000;
    if (['h', 'hour'].includes(unit)) return n * 60 * 60 * 1000;
    return null;
}

function formatRemaining(ms) {
    if (ms <= 0) return '0 seconds';
    const s = Math.ceil(ms / 1000);
    if (s < 60) return `${s} seconds`;
    const m = Math.ceil(s / 60);
    if (m < 60) return `${m} minutes`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h} hours ${mm} minutes` : `${h} hours`;
}

module.exports = {
    commands: ['ai', 'quiet', 'unmute'],

    handle: async (cmd, args, msg, { sender, botState, sendMessage }) => {
        const role = sender?.role || 'Member';
        const isPriv = PRIVILEGED_ROLES.has(role);

        // ── !quiet → shortcut for 5-minute mute ─────────────────────────────
        if (cmd === 'quiet') {
            if (!isPriv) return await sendMessage(`❌ ${sender.name}, !quiet is for Owner/Mod only. Direct mentions ("hello bot") still work.`);
            botState.aiMuteUntil = Date.now() + 5 * 60 * 1000;
            return await sendMessage(`🤫 OK, AI random interjections muted for 5 minutes. Type !ai on to unmute.`);
        }

        // ── !unmute → alias for !ai on ───────────────────────────────────────────
        if (cmd === 'unmute') {
            if (!isPriv) return await sendMessage(`❌ ${sender.name}, only Owner/Mod can unmute.`);
            botState.aiMuteUntil = 0;
            return await sendMessage(`🔊 AI is active again. I can speak freely now.`);
        }

        // ── !ai <subcommand> ─────────────────────────────────────────────────
        const sub = (args || '').trim().toLowerCase().split(/\s+/);
        const action = sub[0] || 'status';

        // Status — anyone can check
        if (action === 'status' || action === '') {
            const now = Date.now();
            if (!botState.aiMuteUntil || botState.aiMuteUntil <= now) {
                return await sendMessage(`🟢 AI Status: ACTIVE. I can join the conversation and answer questions.`);
            }
            const remaining = botState.aiMuteUntil - now;
            return await sendMessage(`🔴 AI Status: MUTED (${formatRemaining(remaining)} left). Type !ai on to activate.`);
        }

        // Other actions require privilege
        if (!isPriv) {
            return await sendMessage(`❌ ${sender.name}, only Owner/Mod can change AI mode. Check status: !ai status`);
        }

        if (action === 'off' || action === 'mute') {
            // !ai off → permanent mute until !ai on
            // Use a timestamp far into the future (1 year) for simplicity.
            botState.aiMuteUntil = Date.now() + 365 * 24 * 60 * 60 * 1000;
            return await sendMessage(`🔇 AI random interjections muted. Direct mentions ("hello bot") will still respond.\nType !ai on to activate again.`);
        }

        if (action === 'on') {
            botState.aiMuteUntil = 0;
            return await sendMessage(`🔊 AI is active again. I can speak freely now.`);
        }

        if (action === 'sleep') {
            const durationStr = sub[1];
            if (!durationStr) {
                return await sendMessage(`❓ Format: !ai sleep <duration>\nExample: !ai sleep 5m, !ai sleep 30s, !ai sleep 1h`);
            }
            const ms = parseDuration(durationStr);
            if (!ms) {
                return await sendMessage(`❌ Duration "${durationStr}" is invalid. Format: 30s / 5m / 1h`);
            }
            // Cap at 24 hours
            const capped = Math.min(ms, 24 * 60 * 60 * 1000);
            botState.aiMuteUntil = Date.now() + capped;
            return await sendMessage(`😴 AI is sleeping for ${formatRemaining(capped)}. I will auto-wake after that.`);
        }

        // Help
        return await sendMessage(
            `🤖 *AI Mode Commands*\n` +
            `• !ai status — check status\n` +
            `• !ai off — mute random interjections (until !ai on)\n` +
            `• !ai on — activate again\n` +
            `• !ai sleep <duration> — temporary mute (e.g., 5m, 30s, 1h)\n` +
            `• !quiet — shortcut for 5-minute mute\n` +
            `• !unmute — alias for !ai on\n\n` +
            `*Note:* Direct mentions ("hello bot") still work even when muted.`
        );
    }
};
