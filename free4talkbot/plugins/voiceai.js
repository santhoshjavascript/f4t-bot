const { generateOnce } = require('../ai.js');

module.exports = {
    commands: ['voiceai', 'hello'],

    handle: async (cmd, args, msg, { botState, sendMessage, speakTTS }) => {
        if (botState.voiceAI === undefined) botState.voiceAI = false;
        if (botState.voiceAIVoice === undefined) botState.voiceAIVoice = 'guy';
        if (botState.voiceAIPitch === undefined) botState.voiceAIPitch = '-5Hz';
        if (botState.voiceAIRate === undefined) botState.voiceAIRate = '-5%';

        const tokens = args.trim().toLowerCase().split(/\s+/);
        const action = tokens[0];
        const subAction = tokens[1];

        if (action === 'on') {
            botState.voiceAI = true;
            await sendMessage('👍');
            if (typeof speakTTS === 'function') {
                setTimeout(async () => {
                    try {
                        const intro = await generateOnce(
                            'Voice mode is on. Give a sarcastic 2-sentence greeting to the room and ask what they want.',
                            botState,
                            { voice: true }
                        );
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
            botState.voiceAIPitch = '+0Hz';
            botState.voiceAIRate = '-5%';
            await sendMessage('👍');
        } else if (action === 'pitch') {
            if (!subAction) {
                return await sendMessage('👍');
            }
            if (subAction === 'baby' || subAction === 'cute') {
                botState.voiceAIPitch = '+10Hz';
                botState.voiceAIRate = '+5%';
                await sendMessage('👍');
            } else if (subAction === 'giant' || subAction === 'deep' || subAction === 'scary') {
                botState.voiceAIPitch = '-15Hz';
                botState.voiceAIRate = '-10%';
                await sendMessage('👍');
            } else if (subAction === 'normal' || subAction === 'reset' || subAction === 'mature') {
                botState.voiceAIPitch = '-5Hz';
                botState.voiceAIRate = '-5%';
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
                botState.voiceAIRate = '+15%';
                await sendMessage('👍');
            } else if (subAction === 'slow' || subAction === 'chill') {
                botState.voiceAIRate = '-15%';
                await sendMessage('👍');
            } else if (subAction === 'normal' || subAction === 'reset') {
                botState.voiceAIRate = '-5%';
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
            botState.voiceAIVoice = 'guy';
            botState.voiceAIPitch = '-5Hz';
            botState.voiceAIRate = '-5%';
            await sendMessage('👍');
        } else {
            botState.voiceAI = !botState.voiceAI;
            await sendMessage('👍');
        }
    }
};
