const { generateOnce } = require('../ai.js');

module.exports = {
    commands: ['voiceai', 'hello'],

    handle: async (cmd, args, msg, { botState, sendMessage, speakTTS }) => {
        if (botState.voiceAI === undefined) botState.voiceAI = false;
        if (botState.voiceAIVoice === undefined) botState.voiceAIVoice = 'aria';
        if (botState.voiceAIPitch === undefined) botState.voiceAIPitch = '+15Hz';
        if (botState.voiceAIRate === undefined) botState.voiceAIRate = '+10%';

        const tokens = args.trim().toLowerCase().split(/\s+/);
        const action = tokens[0];
        const subAction = tokens[1];

        if (action === 'on') {
            botState.voiceAI = true;
            await sendMessage('👍');
            if (typeof speakTTS === 'function') {
                setTimeout(async () => {
                    try {
                        const intro = await generateOnce("You just turned on voice conversation mode. Give a very short (1 sentence), sarcastic, and sassy greeting to the room.", botState);
                        if (intro) {
                            await speakTTS(intro, { force: true }).catch(() => { });
                        }
                    } catch (_) { }
                }, 1000);
            }
        } else if (action === 'off') {
            botState.voiceAI = false;
            await sendMessage('👍');
        } else if (action === 'guy' || action === 'male') {
            botState.voiceAIVoice = 'guy';
            await sendMessage('👍');
        } else if (action === 'aria' || action === 'female') {
            botState.voiceAIVoice = 'aria';
            await sendMessage('👍');
        } else if (action === 'pitch') {
            if (!subAction) {
                return await sendMessage('👍');
            }
            if (subAction === 'baby' || subAction === 'cute') {
                botState.voiceAIPitch = '+15Hz';
                botState.voiceAIRate = '+10%';
                await sendMessage('👍');
            } else if (subAction === 'giant' || subAction === 'deep' || subAction === 'scary') {
                botState.voiceAIPitch = '-15Hz';
                botState.voiceAIRate = '-10%';
                await sendMessage('👍');
            } else if (subAction === 'normal' || subAction === 'reset') {
                botState.voiceAIPitch = '+0Hz';
                botState.voiceAIRate = '0%';
                await sendMessage('👍');
            } else {
                if (/^[+-]\d+hz$/i.test(subAction)) {
                    botState.voiceAIPitch = subAction.toUpperCase();
                    await sendMessage('👍');
                } else {
                    await sendMessage('👍');
                }
            }
        } else if (action === 'rate' || action === 'speed') {
            if (!subAction) {
                return await sendMessage('👍');
            }
            if (subAction === 'fast' || subAction === 'rap') {
                botState.voiceAIRate = '+30%';
                await sendMessage('👍');
            } else if (subAction === 'slow' || subAction === 'chill') {
                botState.voiceAIRate = '-20%';
                await sendMessage('👍');
            } else if (subAction === 'normal' || subAction === 'reset') {
                botState.voiceAIRate = '0%';
                await sendMessage('👍');
            } else {
                if (/^[+-]\d+%$/i.test(subAction)) {
                    botState.voiceAIRate = subAction;
                    await sendMessage('👍');
                } else {
                    await sendMessage('👍');
                }
            }
        } else if (action === 'reset' || action === 'clear') {
            botState.voiceAIVoice = 'aria';
            botState.voiceAIPitch = '+0Hz';
            botState.voiceAIRate = '0%';
            await sendMessage('👍');
        } else {
            botState.voiceAI = !botState.voiceAI;
            await sendMessage('👍');
        }
    }
};
