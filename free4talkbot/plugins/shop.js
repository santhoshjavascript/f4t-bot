const economy = require('../economy.js');

module.exports = {
    commands: ['shop', 'buy', 'inventory', 'inv', 'use', 'sell'],

    handle: async (cmd, args, msg, { sender, userMap, sendMessage, db }) => {

        if (cmd === 'shop') {
            const shop = db.settings.shop;
            if (!shop || typeof shop !== 'object') {
                return await sendMessage('❌ Shop is not configured! Please add "shop" data in economy.json > settings.');
            }
            const items = Object.entries(shop);

            const page = parseInt(args) || 1;
            const limit = 15;
            const totalPages = Math.ceil(items.length / limit);

            if (page < 1 || page > totalPages) return await sendMessage(`❌ Invalid page! The shop only has ${totalPages} pages.`);

            const start = (page - 1) * limit;
            const end = start + limit;
            const displayedItems = items.slice(start, end);

            let msg = `🛒 **KING'S SHOP (Page ${page}/${totalPages})** 🛒\n\n`;

            displayedItems.forEach(([itemName, item], i) => {
                const globalIndex = start + i + 1;
                msg += `${globalIndex}. **${itemName}**\n`;
                msg += `   💰 ${item.price} ${db.settings.currency}\n`;
                msg += `   📝 ${item.description}\n`;
            });

            msg += `\n📄 Type **!shop ${page + 1}** for the next page.`;
            msg += `\n🛒 Buy: **!buy <name/number>**`;

            await sendMessage(msg.trim());
        }

        else if (cmd === 'buy') {
            if (!args) return await sendMessage('❓ Format: !buy <item name / number> [amount]');

            const parts = args.split(' ');
            let amount = 1;
            let itemInput = args;

            if (parts.length > 1 && !isNaN(parts[parts.length - 1])) {
                amount = parseInt(parts[parts.length - 1]);
                itemInput = parts.slice(0, -1).join(' ');
            }

            if (amount < 1) amount = 1;

            const userId = sender.uid || userMap.get(sender.name) || sender.name;
            const user = economy.getUser(db, userId, sender.name);
            const shop = db.settings.shop;
            const shopKeys = Object.keys(shop);

            let itemName = null;

            const index = parseInt(itemInput);
            if (!isNaN(index) && index >= 1 && index <= shopKeys.length) {
                itemName = shopKeys[index - 1];
            } else {
                itemName = shopKeys.find(name =>
                    name.toLowerCase().includes(itemInput.toLowerCase()) ||
                    itemInput.toLowerCase().includes(name.toLowerCase().replace(/[^\w\s]/g, ''))
                );
            }

            if (!itemName) return await sendMessage(`❌ Item "${itemInput}" not found! Type !shop to see the list.`);

            const item = shop[itemName];
            const totalPrice = item.price * amount;

            if (user.balance < totalPrice) {
                return await sendMessage(`❌ ${sender.name}, insufficient balance!\n💰 Total: ${totalPrice} ${db.settings.currency}\n💳 Balance: ${user.balance} ${db.settings.currency}`);
            }

            user.balance -= totalPrice;

            if (!user.inventory) user.inventory = [];

            for (let i = 0; i < amount; i++) {
                user.inventory.push({
                    name: itemName,
                    type: item.type,
                    effect: item.effect,
                    boughtAt: Date.now()
                });
            }

            economy.saveEconomyDB(db);

            await sendMessage(`✅ ${sender.name} bought ${amount}x ${itemName}!\n💰 -${totalPrice} ${db.settings.currency}\n💳 Balance: ${user.balance} ${db.settings.currency}`);
        }

        else if (cmd === 'sell') {
            const userId = sender.uid || userMap.get(sender.name) || sender.name;
            const user = economy.getUser(db, userId, sender.name);
            const shop = db.settings.shop;

            const getSellPrice = (itemName) => {
                const prices = {
                    'Chip': 1000,
                    'Gold': 500, 'Diamond': 1000, 'Iron': 100, 'Junk': 10, 'Rock': 5,

                    'Wood': 50, 'Rice': 40, 'Bone': 25, 'Burger': 100, 'Holy Water': 200,
                    'Data Chip': 500, 'Chair': 150, 'Painting': 300, 'Scrap': 30,

                    'Fabric': 60, 'Silk': 120, 'Wooden Statue': 200, 'Flower Vase': 250, 'Iron Plate': 150,
                    'Dull Sword': 300, 'Spare Part': 100, 'Glass Bottle': 80,

                    'Potion': 250, 'Alcohol': 180, 'Bread': 50, 'Steak': 120, 'Juice': 60, 'Coffee': 70,

                    'Herb': 40, 'Leather': 80, 'Wool': 70, 'Milk': 50, 'Corn': 45, 'Berry': 30,
                    'Butterfly': 30, 'Rabbit': 150, 'Animal Track': 10,

                    'Formula': 600, 'Evidence': 500, 'Software': 800, 'Poison': 400,

                    'Song': 350, 'Novel': 500, 'Sketch': 100, 'Photo': 150, 'Movie': 700,

                    'Coins': 20, 'Tip': 50, 'Ticket': 100, 'Honor': 200, 'Tattoo': 300,
                    'Earring': 250, 'Hair': 10, 'Beauty': 150, 'Evil Spirit': 500, 'Karma': 1,
                    'Medal': 400, 'Map': 200, 'Intel': 600, 'Salary': 300, 'Fossil': 1000,
                    'Scrap Metal': 80
                };

                for (const [key, val] of Object.entries(prices)) {
                    if (itemName.includes(key)) return val;
                }

                const shopKey = Object.keys(shop).find(k => itemName.includes(k));
                if (shopKey) return Math.floor(shop[shopKey].price * 0.5);

                return 0;
            };

            const invMap = {};
            if (user.inventory) {
                user.inventory.forEach(item => {
                    invMap[item.name] = (invMap[item.name] || 0) + 1;
                });
            }
            const invItems = Object.entries(invMap);

            if (!args) {
                if (invItems.length === 0) return await sendMessage('📦 Inventory is empty! Nothing to sell.');

                let sellMsg = `🏪 **SECOND HAND MARKET** 🏪\n\n`;
                invItems.forEach(([name, count], i) => {
                    const price = getSellPrice(name);
                    const priceTag = price > 0 ? `💰 ${price}` : '❌ No value';
                    sellMsg += `${i + 1}. ${name} (x${count}) ➡️ ${priceTag}\n`;
                });

                sellMsg += `\nType: !sell <number> [amount]\nExample: !sell 1 5`;
                return await sendMessage(sellMsg.trim());
            }

            const parts = args.split(' ');
            let targetItemName = '';
            let amount = 1;

            if (!isNaN(parts[0])) {
                const idx = parseInt(parts[0]) - 1;
                if (idx >= 0 && idx < invItems.length) {
                    targetItemName = invItems[idx][0];
                    if (parts.length > 1 && !isNaN(parts[1])) amount = parseInt(parts[1]);
                } else {
                    return await sendMessage('❌ Invalid item number!');
                }
            } else {
                const nameInput = parts.length > 1 && !isNaN(parts[parts.length - 1]) ? parts.slice(0, -1).join(' ') : args;
                if (parts.length > 1 && !isNaN(parts[parts.length - 1])) amount = parseInt(parts[parts.length - 1]);

                targetItemName = Object.keys(invMap).find(n => n.toLowerCase().includes(nameInput.toLowerCase()));
            }

            if (!targetItemName) return await sendMessage('❌ Item not found in inventory!');

            const ownedCount = invMap[targetItemName];
            if (ownedCount < amount) return await sendMessage(`❌ Not enough items! You only have ${ownedCount} ${targetItemName}.`);

            const pricePerItem = getSellPrice(targetItemName);
            if (pricePerItem <= 0) return await sendMessage(`❌ ${targetItemName} cannot be sold!`);

            const totalEarned = pricePerItem * amount;

            let removed = 0;
            for (let i = user.inventory.length - 1; i >= 0; i--) {
                if (user.inventory[i].name === targetItemName && removed < amount) {
                    user.inventory.splice(i, 1);
                    removed++;
                }
            }

            user.balance += totalEarned;
            economy.saveEconomyDB(db);

            await sendMessage(`🤝 Deal! You sold ${amount}x ${targetItemName} for ${totalEarned} coins!`);
        }

        else if (cmd === 'inventory' || cmd === 'inv') {
            const userId = sender.uid || userMap.get(sender.name) || sender.name;
            const user = economy.getUser(db, userId, sender.name);

            const inv = user.inventory || [];

            const countItem = (name) => inv.filter(i => i.name.toLowerCase().includes(name.toLowerCase())).length;

            const health = user.health || 0;
            const maxHealth = user.maxHealth || 100;
            const armorLevel = countItem('Armor');
            const money = user.balance || 0;
            const level = user.level || 0;
            const exp = user.exp || 0;
            const maxExp = (level + 1) * 1000;
            const rankLevel = Object.values(db.users).sort((a, b) => b.level - a.level).findIndex(u => u.name === user.name) + 1;
            const rankMoney = Object.values(db.users).sort((a, b) => b.balance - a.balance).findIndex(u => u.name === user.name) + 1;

            const itemCounts = {};
            inv.forEach(item => {
                itemCounts[item.name] = (itemCounts[item.name] || 0) + 1;
            });

            const crates = [];
            const tools = [];
            const loot = [];

            Object.entries(itemCounts).forEach(([name, count]) => {
                if (name.includes('Crate')) {
                    crates.push(`${name.replace(' Crate', '')}: *${count}*`);
                } else if (['Pickaxe', 'Axe', 'Hoe', 'Shovel', 'Fishing Rod', 'Sword', 'Armor', 'Laptop', 'Guitar', 'Hammer', 'Brush', 'Flashlight', 'Needle', 'Loom', 'Chisel', 'Clay', 'Torch', 'Anvil', 'Wrench', 'Blower', 'Cauldron', 'Still', 'Oven', 'Grill', 'Blender', 'Roaster', 'Gloves', 'Knife', 'Shears', 'Bucket', 'Sickle', 'Basket', 'Net', 'Cage', 'Compass', 'Microscope', 'Magnifier', 'Server', 'Syringe', 'Pen', 'Typewriter', 'Pencil', 'Camera', 'VideoCam', 'Mic', 'Bowl', 'Harmonica', 'Balls', 'Mask', 'Podium', 'Oil', 'InkGun', 'Piercer', 'Scissors', 'MakeupKit', 'Cross', 'Mat', 'Badge', 'Binoculars', 'Spyglass', 'Shield', 'Crowbar'].some(t => name.includes(t))) {
                    tools.push(`${name} *${count > 1 ? '(x' + count + ')' : '✅'}*`);
                } else {
                    loot.push(`${name}: *${count}*`);
                }
            });

            let armorName = 'None';
            if (armorLevel > 0) armorName = 'Leather Armor';
            if (armorLevel > 5) armorName = 'Iron Armor';

            const xpLeft = maxExp - exp;
            const more = String.fromCharCode(8206);
            const readMore = more.repeat(4001);

            let invMsg = `Inventory *${sender.name}*

Health: *${health}*
Armor: *${armorName}*
Money: *${money}*
Level: *${level}*
Exp: *${exp}*

*Tools*
${tools.length > 0 ? tools.join('\n') : '- No tools owned'}

*Inventory / Loot*
${loot.length > 0 ? loot.join('\n') : '- Empty'}
Total inv: *${inv.length}* items

*Crate*
${crates.length > 0 ? crates.join('\n') : '- No crates owned'}

*Pet*
Horse: *None*
Fox: *None*
Cat: *None*

*Progress*
╭────────────────
│Level *${level}* To Level *${level + 1}*
│Exp *${exp}* -> *${maxExp}* [${xpLeft <= 0 ? `Ready to LevelUP!` : `${xpLeft} XP left`}]
╰────────────────

*Achievements*
1. Top level *${rankLevel}*
2. Top Money *${rankMoney}*
${readMore}
Warn: *0*
Banned: *No*`.trim();

            await sendMessage(invMsg);
        }

        else if (cmd === 'use') {
            if (!args) return await sendMessage('❓ Format: !use <item name>');

            const userId = sender.uid || userMap.get(sender.name) || sender.name;
            const user = economy.getUser(db, userId, sender.name);

            if (!user.inventory || user.inventory.length === 0) return await sendMessage(`❌ ${sender.name}, inventory is empty!`);

            const itemIndex = user.inventory.findIndex(item =>
                item.name.toLowerCase().includes(args.toLowerCase()) ||
                args.toLowerCase().includes(item.name.toLowerCase().replace(/[^\w\s]/g, ''))
            );

            if (itemIndex === -1) return await sendMessage(`❌ Item "${args}" not found in inventory!`);

            const item = user.inventory[itemIndex];

            if (item.type !== 'consumable') return await sendMessage(`❌ ${item.name} cannot be used! (Type: ${item.type})`);

            let resultMsg = `✅ ${sender.name} used ${item.name}!\n\n`;

            if (item.effect.randomReward) {
                const reward = economy.random(item.effect.randomReward.min, item.effect.randomReward.max);
                user.balance += reward;
                resultMsg += `🎁 Received ${reward} ${db.settings.currency}!\n💳 Balance: ${user.balance} ${db.settings.currency}`;
            } else if (item.effect.resetCooldown) {
                if (item.effect.resetCooldown === 'hunt') {
                    user.lastHunt = null;
                    resultMsg += `⚡ Hunt cooldown reset!`;
                } else if (item.effect.resetCooldown === 'daily') {
                    user.lastDaily = null;
                    resultMsg += `⚡ Daily cooldown reset!`;
                }
            } else if (item.effect.heal) {
                const healAmount = item.effect.heal;
                const oldHp = user.health || 0;
                user.health = Math.min((user.health || 0) + healAmount, user.maxHealth || 100);
                resultMsg += `❤️ Heal +${healAmount}! HP: ${oldHp} -> ${user.health}`;
            }

            user.inventory.splice(itemIndex, 1);
            economy.saveEconomyDB(db);

            await sendMessage(resultMsg.trim());
        }
    }
};
