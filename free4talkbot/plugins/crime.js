const economy = require('../economy.js');

module.exports = {
    commands: ['rob', 'bankrob'],

    handle: async (cmd, args, msg, { sender, userMap, sendMessage, db }) => {

        const userId = sender.uid || userMap.get(sender.name) || sender.name;
        const user = economy.getUser(db, userId, sender.name);

        if (cmd === 'rob') {
            if (!args) return await sendMessage('❓ Who is the target? Format: !rob <name/@mention>');

            const hasMask = user.inventory ? user.inventory.find(i => i.name.toLowerCase().includes('mask')) : false;

            const cooldownCheck = economy.checkCooldown(user.lastRob, 600000);
            if (!cooldownCheck.ready) {
                const timeLeft = economy.formatTime(cooldownCheck.timeLeft);
                return await sendMessage(`🚓 Police are on patrol! Wait ${timeLeft} more.`);
            }

            let targetName = args.split(' ')[0];
            if (targetName.startsWith('@')) targetName = targetName.substring(1);
            if (targetName.toLowerCase() === sender.name.toLowerCase()) return await sendMessage('❌ You cannot rob yourself, that is weird.');

            let targetUserId = userMap.get(targetName);
            if (!targetUserId) {
                const matchedName = Array.from(userMap.keys()).find(name =>
                    name.toLowerCase().includes(targetName.toLowerCase()) ||
                    targetName.toLowerCase().includes(name.toLowerCase())
                );
                if (matchedName) {
                    targetUserId = userMap.get(matchedName);
                    targetName = matchedName;
                } else {
                    targetUserId = targetName;
                }
            }

            const targetUser = economy.getUser(db, targetUserId, targetName);

            if (targetName.toLowerCase().includes('gilang') || targetName.toLowerCase().includes('raja')) {
                return await sendMessage(`😡 **HEY!** You want to rob the Developer?! Have some respect! You will get bad karma.`);
            }

            if (targetUser.balance < 100) return await sendMessage(`❌ ${targetName} is too poor, it is not worth robbing them.`);

            let successChance = 0.3;
            if (hasMask) successChance += 0.2;

            user.lastRob = Date.now();

            if (Math.random() < successChance) {
                const percent = (Math.random() * 0.2) + 0.05;
                const stolen = Math.floor(targetUser.balance * percent);

                targetUser.balance -= stolen;
                user.balance += stolen;
                user.stats.robSuccess = (user.stats.robSuccess || 0) + 1;

                economy.saveEconomyDB(db);
                await sendMessage(`🥷 SUCCESS! ${sender.name} successfully robbed ${stolen} coins from ${targetName}! Run away! 🏃`);
            } else {
                const fine = 500;
                user.balance = Math.max(0, user.balance - fine);
                user.stats.robFail = (user.stats.robFail || 0) + 1;

                economy.saveEconomyDB(db);
                await sendMessage(`🚓 FAILED! ${sender.name} was caught by the police while trying to rob ${targetName}! Fined ${fine} coins.`);
            }
        }

        else if (cmd === 'bankrob') {
            const hasLockpick = user.inventory ? user.inventory.find(i => i.name.toLowerCase().includes('lockpick')) : false;
            if (!hasLockpick) return await sendMessage(`❌ You need a **Lockpick** to break into the bank! Buy it in the shop.`);

            const cooldownCheck = economy.checkCooldown(user.lastBankRob, 3600000);
            if (!cooldownCheck.ready) {
                const timeLeft = economy.formatTime(cooldownCheck.timeLeft);
                return await sendMessage(`🏦 The bank is under heavy guard! Wait ${timeLeft} more.`);
            }

            const itemIdx = user.inventory.findIndex(i => i.name.toLowerCase().includes('lockpick'));
            user.inventory.splice(itemIdx, 1);
            user.lastBankRob = Date.now();

            if (Math.random() < 0.5) {
                const stolen = Math.floor(Math.random() * 5000) + 2000;
                user.balance += stolen;
                economy.addXp(user, 500);

                economy.saveEconomyDB(db);
                await sendMessage(`🤑 JACKPOT! ${sender.name} successfully cracked the bank vault! Earned ${stolen} coins + 500 XP!`);
            } else {
                user.health = 1;
                const fine = Math.floor(user.balance * 0.1);
                user.balance -= fine;

                economy.saveEconomyDB(db);
                await sendMessage(`🚑 WEEE OOO WEEE OOO! Alarm triggered! ${sender.name} was beaten by security until critical (HP: 1) and fined ${fine} coins!`);
            }
        }
    }
};
