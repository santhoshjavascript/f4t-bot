/**
 * who.js — !who | !list | !room
 * Displays everyone currently in the room
 */
module.exports = {
    commands: ['who', 'list', 'room'],

    async handle(cmd, args, fullMsg, ctx) {
        const { botState, sendMessage } = ctx;
        const participants = botState.participants || [];

        if (participants.length === 0) {
            return sendMessage('📋 Participant data not loaded yet. Please try again in a few seconds.');
        }

        // Sort: Owner first, then Mod, then Member
        const roleOrder = { 'Owner': 0, 'Co-owner': 1, 'Moderator': 2, 'Admin': 3, 'Member': 4 };
        const sorted = [...participants].sort((a, b) =>
            (roleOrder[a.role] ?? 5) - (roleOrder[b.role] ?? 5)
        );

        const roleIcon = {
            'Owner': '👑',
            'Co-owner': '🥈',
            'Moderator': '🛡️',
            'Admin': '⚙️',
            'Member': '👤'
        };

        const lines = sorted.map(p => {
            const icon = roleIcon[p.role] || '👤';
            return `${icon} ${p.name} [${p.role || 'Member'}]`;
        });

        return sendMessage(`📋 Users in room (${participants.length}):\n${lines.join('\n')}`);
    }
};
