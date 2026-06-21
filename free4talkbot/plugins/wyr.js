module.exports = {
    commands: ['wyr', 'a', 'b'],

    handle: async (cmd, args, msg, { sender, sendMessage, botState }) => {
        // Initialize state if it doesn't exist
        if (!botState.wyr) {
            botState.wyr = { active: false, votesA: new Set(), votesB: new Set() };
        }

        if (cmd === 'wyr') {
            if (botState.wyr.active) {
                return await sendMessage(`⏳ A game is already active! Wait for the results.`);
            }

            const questions = [
                "Would you rather have fingers as long as your legs, OR legs as long as your fingers?",
                "Would you rather speak all languages, OR be able to speak to all animals?",
                "Would you rather go back to the past and meet your ancestors, OR go to the future and meet your great-grandchildren?",
                "Would you rather have a flying carpet, OR a car that can drive underwater?",
                "Would you rather always be 10 minutes late, OR always be 20 minutes early?",
                "Would you rather lose the ability to read, OR lose the ability to speak?",
                "Would you rather fight one horse-sized duck, OR 100 duck-sized horses?",
                "Would you rather have a rewind button for your life, OR a pause button?",
                "Would you rather never eat chocolate again, OR never eat cheese again?",
                "Would you rather be famous but poor, OR rich but unknown?",
                "Would you rather have a completely automated home, OR a self-driving car?",
                "Would you rather be a genius in a world of idiots, OR an idiot in a world of geniuses?",
                "Would you rather know HOW you are going to die, OR WHEN you are going to die?",
                "Would you rather have unlimited free food for life, OR unlimited free flights for life?",
                "Would you rather be Batman, OR Iron Man?"
            ];

            const q = questions[Math.floor(Math.random() * questions.length)];

            botState.wyr.active = true;
            botState.wyr.votesA.clear();
            botState.wyr.votesB.clear();

            await sendMessage(`🤔 **WOULD YOU RATHER...**\n\n${q}\n\nType A for the first option, or B for the second option. You have 30 seconds!`);

            setTimeout(async () => {
                botState.wyr.active = false;
                const a = botState.wyr.votesA.size;
                const b = botState.wyr.votesB.size;
                const total = a + b;

                if (total === 0) {
                    await sendMessage(`⏰ Time's up! Nobody voted. You guys are boring!`);
                } else {
                    const pctA = Math.round((a / total) * 100);
                    const pctB = Math.round((b / total) * 100);
                    
                    let winnerText = "It's a perfect tie!";
                    if (pctA > pctB) winnerText = 'Option A wins! You guys are weird.';
                    if (pctB > pctA) winnerText = 'Option B wins! Good choice.';

                    await sendMessage(`⏰ **RESULTS ARE IN!**\n\n🔴 Option A: ${pctA}% (${a} votes)\n🔵 Option B: ${pctB}% (${b} votes)\n\n${winnerText}`);
                }
            }, 30000);
            return;
        }

        // Handle votes (intercepted from raw 'A' or 'B' or explicitly '!a' / '!b')
        if ((cmd === 'a' || cmd === 'b') && botState.wyr.active) {
            // Allow changing vote
            if (botState.wyr.votesA.has(sender.name)) botState.wyr.votesA.delete(sender.name);
            if (botState.wyr.votesB.has(sender.name)) botState.wyr.votesB.delete(sender.name);

            if (cmd === 'a') {
                botState.wyr.votesA.add(sender.name);
                await sendMessage(`✅ ${sender.name} voted for Option A!`);
            }
            if (cmd === 'b') {
                botState.wyr.votesB.add(sender.name);
                await sendMessage(`✅ ${sender.name} voted for Option B!`);
            }
        }
    }
};
