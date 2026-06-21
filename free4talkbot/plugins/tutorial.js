const economy = require('../economy.js');

module.exports = {
    commands: ['tutorial', 'guide'],

    handle: async (cmd, args, msg, { sender, userMap, sendMessage, db }) => {

        const part1 = `
📚 **COMPLETE RPG BOT TUTORIAL (Part 1/3)** 📚
Welcome to the RPG world! Here you can become anything: a Tycoon, a Farmer, a Mafia boss, or a Professional Gambler.

💰 **HOW TO EARN MONEY (FOR BEGINNERS)**
1.  **!daily** : Daily check-in (Mandatory! Get coins & XP).
2.  **!hunt** : Hunt wild animals. Be careful, your HP will decrease!
3.  **!adventure** : Go on an adventure to find treasure. Needs courage.
4.  **!fish** : Catch fish (Requires *Fishing Rod*).
5.  **!mine** : Mine rocks/diamonds (Requires *Pickaxe*).

🛒 **SHOPPING & SELLING**
*   **!shop** : View item catalog (Tools, Potions, Crates).
*   **!buy <name/number>** : Buy an item. Example: \`!buy Axe\` or \`!buy 1\`.
*   **!sell** : View the selling price of items in your bag.
*   **!inv** : Check your inventory, status, and level.
*   **!use <name>** : Use an item (e.g., Potion to heal).

❤️ **HEALTH MATTERS!**
Don't forget to check your HP. If HP is 0, you can't work!
Buy **Potions** in the shop or Level Up to fully restore your health.
`;

        const part2 = `
🛠️ **JOBS & GRINDING (Part 2/3)** 🛠️
You need SPECIAL TOOLS for work. Buy them in \`!shop\` first!

🌲 **NATURE & FARMING**
*   **!chop** (Axe) -> Chop Wood 🪵
*   **!farm** (Hoe) -> Farm Rice 🌾
*   **!dig** (Shovel) -> Dig Soil 🦴
*   **!pluck** (Gloves) -> Pluck Herbs 🌿
*   **!shear** (Shears) -> Shear Sheep 🧶
*   **!milk** (Bucket) -> Milk Cows 🥛

🔨 **CRAFTING & SKILLS**
*   **!cook** (Pan) -> Cook Burger 🍔
*   **!build** (Hammer) -> Build Chair 🪑
*   **!sew** (Needle) -> Sew Fabric 🧵
*   **!forge** (Anvil) -> Forge Sword ⚔️
*   **!brew** (Cauldron) -> Brew Potion 🧪
*   **!repair** (Wrench) -> Repair Machine ⚙️

🎨 **ARTS & TECH**
*   **!paint** (Brush) -> Painting 🎨
*   **!sing** (Guitar) -> Busking 🎵
*   **!hack** (Laptop) -> Hacking Data 💾
*   **!research** (Microscope) -> Science Research 🔬
*   **!stream** (Mic) -> Stream for Donations 🎙️

...and many more! Check **!cd** to see your work timers.
`;

        const part3 = `
🎲 **CRIME & CASINO (Part 3/3)** 🎲
The fast way to get rich (or poor). At your own risk!

🔫 **CRIMINAL**
*   **!rob <user>** : Rob someone else's money! (Requires *Thief Mask* for safety).
*   **!bankrob** : Break into the Main Bank! Requires *Lockpick*. High risk, high reward!
*   **!scavenge** : Scavenge for junk (Honest but dirty work).

🎰 **NEW UPDATE: CASINO**
*   **!slot** : Play the Slot Machine. Winning the jackpot can make you instantly rich!
*   **!flip** : Flip a coin (Head/Tail). 50:50 bet.
*   *Tips: Buy **Chips** in the shop before gambling!*

🏆 **LEADERBOARD**
*   **!lb** : Check who is the wealthiest and most legendary on the server.

Have fun playing! Don't forget to rest (just kidding, keep grinding!). 🔥
`;

        await sendMessage(part1.trim());

        await new Promise(r => setTimeout(r, 1000));
        await sendMessage(part2.trim());

        await new Promise(r => setTimeout(r, 1000));
        await sendMessage(part3.trim());
    }
};
