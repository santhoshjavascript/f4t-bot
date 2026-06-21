const economy = require('../economy.js');

module.exports = {
    commands: [
        'chop', 'farm', 'dig', 'cook', 'pray', 'hack', 'sing', 'build', 'paint', 'scavenge',
        'brew', 'research', 'sew', 'carve', 'weld', 'weave', 'forge', 'distill', 'pluck', 'skin',
        'shear', 'milk', 'extract', 'analyze', 'compose', 'sculpt', 'exorcise', 'meditate', 'program', 'stream',
        'beg', 'busk', 'juggle', 'perform', 'lecture', 'patrol', 'scout', 'spy', 'guard', 'massage',
        'tattoo', 'pierce', 'cut', 'makeup', 'photo', 'film', 'write', 'draw', 'bake', 'grill',
        'blend', 'roast', 'harvest', 'gather', 'collect', 'trap', 'track', 'excavate', 'salvage', 'repair'
    ],

    handle: async (cmd, args, msg, { sender, userMap, sendMessage, db }) => {
        const userId = sender.uid || userMap.get(sender.name) || sender.name;
        const user = economy.getUser(db, userId, sender.name);

        const activities = {
            'chop': { tool: 'Axe', cdKey: 'lastChop', cdTime: 300000, reward: 'Wood 🪵', xp: 50, verb: 'chopping wood' },
            'farm': { tool: 'Hoe', cdKey: 'lastFarm', cdTime: 300000, reward: 'Rice 🌾', xp: 50, verb: 'farming' },
            'dig': { tool: 'Shovel', cdKey: 'lastDig', cdTime: 300000, reward: 'Bone 🦴', xp: 40, verb: 'digging' },
            'cook': { tool: 'Pan', cdKey: 'lastCook', cdTime: 300000, reward: 'Burger 🍔', xp: 60, verb: 'cooking' },
            'pray': { tool: 'Rosary', cdKey: 'lastPray', cdTime: 600000, reward: 'Holy Water 💧', xp: 100, verb: 'praying' },
            'hack': { tool: 'Laptop', cdKey: 'lastHack', cdTime: 600000, reward: 'Data Chip 💾', xp: 150, verb: 'hacking' },
            'sing': { tool: 'Guitar', cdKey: 'lastSing', cdTime: 300000, reward: 'Tips (Money)', xp: 70, verb: 'singing' },
            'build': { tool: 'Hammer', cdKey: 'lastBuild', cdTime: 600000, reward: 'Chair 🪑', xp: 80, verb: 'building' },
            'paint': { tool: 'Brush', cdKey: 'lastPaint', cdTime: 450000, reward: 'Painting 🎨', xp: 80, verb: 'painting' },
            'scavenge': { tool: 'Flashlight', cdKey: 'lastScavenge', cdTime: 300000, reward: 'Scrap 🔩', xp: 40, verb: 'scavenging' },

            'sew': { tool: 'Needle', cdKey: 'lastSew', cdTime: 300000, reward: 'Fabric 🧵', xp: 50, verb: 'sewing' },
            'weave': { tool: 'Loom', cdKey: 'lastWeave', cdTime: 300000, reward: 'Silk 🧣', xp: 55, verb: 'weaving' },
            'carve': { tool: 'Chisel', cdKey: 'lastCarve', cdTime: 300000, reward: 'Wooden Statue 🗿', xp: 60, verb: 'carving' },
            'sculpt': { tool: 'Clay', cdKey: 'lastSculpt', cdTime: 300000, reward: 'Flower Vase 🏺', xp: 60, verb: 'sculpting' },
            'weld': { tool: 'Torch', cdKey: 'lastWeld', cdTime: 300000, reward: 'Iron Plate 🛡️', xp: 65, verb: 'welding' },
            'forge': { tool: 'Anvil', cdKey: 'lastForge', cdTime: 400000, reward: 'Dull Sword 🗡️', xp: 70, verb: 'forging' },
            'repair': { tool: 'Wrench', cdKey: 'lastRepair', cdTime: 300000, reward: 'Spare Part ⚙️', xp: 50, verb: 'repairing machine' },
            'glass': { tool: 'Blower', cdKey: 'lastGlass', cdTime: 300000, reward: 'Glass Bottle 🥃', xp: 55, verb: 'blowing glass' },

            'brew': { tool: 'Cauldron', cdKey: 'lastBrew', cdTime: 300000, reward: 'Potion 🧪', xp: 60, verb: 'brewing potion' },
            'distill': { tool: 'Still', cdKey: 'lastDistill', cdTime: 300000, reward: 'Alcohol 🍾', xp: 60, verb: 'distilling' },
            'bake': { tool: 'Oven', cdKey: 'lastBake', cdTime: 300000, reward: 'Bread 🍞', xp: 50, verb: 'baking bread' },
            'grill': { tool: 'Grill', cdKey: 'lastGrill', cdTime: 300000, reward: 'Steak 🥩', xp: 55, verb: 'grilling meat' },
            'blend': { tool: 'Blender', cdKey: 'lastBlend', cdTime: 240000, reward: 'Juice 🍹', xp: 40, verb: 'blending juice' },
            'roast': { tool: 'Roaster', cdKey: 'lastRoast', cdTime: 300000, reward: 'Coffee ☕', xp: 50, verb: 'roasting coffee' },

            'pluck': { tool: 'Gloves', cdKey: 'lastPluck', cdTime: 180000, reward: 'Herb 🌿', xp: 30, verb: 'plucking herbs' },
            'skin': { tool: 'Knife', cdKey: 'lastSkin', cdTime: 300000, reward: 'Leather 🐄', xp: 50, verb: 'skinning' },
            'shear': { tool: 'Shears', cdKey: 'lastShear', cdTime: 300000, reward: 'Wool 🧶', xp: 45, verb: 'shearing sheep' },
            'milk': { tool: 'Bucket', cdKey: 'lastMilk', cdTime: 240000, reward: 'Milk 🥛', xp: 40, verb: 'milking cow' },
            'harvest': { tool: 'Sickle', cdKey: 'lastHarvest', cdTime: 300000, reward: 'Corn 🌽', xp: 50, verb: 'harvesting' },
            'gather': { tool: 'Basket', cdKey: 'lastGather', cdTime: 240000, reward: 'Berry 🍒', xp: 35, verb: 'gathering fruit' },
            'collect': { tool: 'Net', cdKey: 'lastCollect', cdTime: 240000, reward: 'Butterfly 🦋', xp: 35, verb: 'collecting insects' },
            'trap': { tool: 'Cage', cdKey: 'lastTrap', cdTime: 400000, reward: 'Rabbit 🐇', xp: 60, verb: 'setting traps' },
            'track': { tool: 'Compass', cdKey: 'lastTrack', cdTime: 450000, reward: 'Animal Track 🐾', xp: 55, verb: 'tracking' },

            'research': { tool: 'Microscope', cdKey: 'lastResearch', cdTime: 600000, reward: 'Formula 🔬', xp: 120, verb: 'researching' },
            'analyze': { tool: 'Magnifier', cdKey: 'lastAnalyze', cdTime: 500000, reward: 'Evidence 🔎', xp: 100, verb: 'analyzing' },
            'program': { tool: 'Server', cdKey: 'lastProgram', cdTime: 600000, reward: 'Software 📀', xp: 150, verb: 'coding' },
            'extract': { tool: 'Syringe', cdKey: 'lastExtract', cdTime: 400000, reward: 'Poison ☠️', xp: 80, verb: 'extracting' },

            'compose': { tool: 'Pen', cdKey: 'lastCompose', cdTime: 450000, reward: 'Song 🎼', xp: 90, verb: 'composing song' },
            'write': { tool: 'Typewriter', cdKey: 'lastWrite', cdTime: 600000, reward: 'Novel 📖', xp: 100, verb: 'writing novel' },
            'draw': { tool: 'Pencil', cdKey: 'lastDraw', cdTime: 300000, reward: 'Sketch 📝', xp: 50, verb: 'drawing' },
            'photo': { tool: 'Camera', cdKey: 'lastPhoto', cdTime: 300000, reward: 'Photo 📷', xp: 60, verb: 'taking photos' },
            'film': { tool: 'VideoCam', cdKey: 'lastFilm', cdTime: 600000, reward: 'Movie 🎬', xp: 120, verb: 'filming' },
            'stream': { tool: 'Mic', cdKey: 'lastStream', cdTime: 600000, reward: 'Donations (Money)', xp: 100, verb: 'streaming' },

            'beg': { tool: 'Bowl', cdKey: 'lastBeg', cdTime: 120000, reward: 'Change (Money)', xp: 20, verb: 'begging' },
            'busk': { tool: 'Harmonica', cdKey: 'lastBusk', cdTime: 240000, reward: 'Tips (Money)', xp: 40, verb: 'busking' },
            'juggle': { tool: 'Balls', cdKey: 'lastJuggle', cdTime: 300000, reward: 'Tips (Money)', xp: 50, verb: 'juggling' },
            'perform': { tool: 'Mask', cdKey: 'lastPerform', cdTime: 400000, reward: 'Ticket 🎫', xp: 80, verb: 'performing arts' },
            'lecture': { tool: 'Podium', cdKey: 'lastLecture', cdTime: 600000, reward: 'Salary (Money)', xp: 100, verb: 'lecturing' },
            'massage': { tool: 'Oil', cdKey: 'lastMassage', cdTime: 300000, reward: 'Tips (Money)', xp: 60, verb: 'massaging' },
            'tattoo': { tool: 'InkGun', cdKey: 'lastTattoo', cdTime: 400000, reward: 'Tattoo 🐉', xp: 80, verb: 'tattooing' },
            'pierce': { tool: 'Piercer', cdKey: 'lastPierce', cdTime: 300000, reward: 'Earring 💍', xp: 60, verb: 'piercing' },
            'cut': { tool: 'Scissors', cdKey: 'lastCut', cdTime: 300000, reward: 'Hair 💇', xp: 50, verb: 'cutting hair' },
            'makeup': { tool: 'MakeupKit', cdKey: 'lastMakeup', cdTime: 300000, reward: 'Beauty 💄', xp: 50, verb: 'applying makeup' },

            'exorcise': { tool: 'Cross', cdKey: 'lastExorcise', cdTime: 600000, reward: 'Evil Spirit 👻', xp: 100, verb: 'exorcising' },
            'meditate': { tool: 'Mat', cdKey: 'lastMeditate', cdTime: 600000, reward: 'Karma 🕉️', xp: 100, verb: 'meditating' },
            'patrol': { tool: 'Badge', cdKey: 'lastPatrol', cdTime: 600000, reward: 'Medal 🏅', xp: 80, verb: 'patrolling' },
            'scout': { tool: 'Binoculars', cdKey: 'lastScout', cdTime: 400000, reward: 'Map 🗺️', xp: 60, verb: 'scouting' },
            'spy': { tool: 'Spyglass', cdKey: 'lastSpy', cdTime: 600000, reward: 'Intel 📁', xp: 100, verb: 'spying' },
            'guard': { tool: 'Shield', cdKey: 'lastGuard', cdTime: 600000, reward: 'Salary (Money)', xp: 90, verb: 'guarding' },
            'excavate': { tool: 'Brush', cdKey: 'lastExcavate', cdTime: 600000, reward: 'Fossil 🦖', xp: 100, verb: 'excavating' },
            'salvage': { tool: 'Crowbar', cdKey: 'lastSalvage', cdTime: 400000, reward: 'Scrap Metal ⛓️', xp: 60, verb: 'salvaging' }
        };

        const act = activities[cmd];
        if (!act) return;

        const hasTool = user.inventory.find(i => i.name === act.tool);
        if (!hasTool) {
            return await sendMessage(`❌ You need a **${act.tool}** for ${cmd}! Buy it in the shop.`);
        }

        const lastTime = user[act.cdKey] || 0;
        const check = economy.checkCooldown(lastTime, act.cdTime);
        if (!check.ready) {
            return await sendMessage(`⏳ Take it easy, wait ${economy.formatTime(check.timeLeft)} more for ${cmd}.`);
        }

        user[act.cdKey] = Date.now();
        const leveledUp = economy.addXp(user, act.xp);

        let rewardMsg = '';

        if (act.reward.includes('(Money)')) {
            const baseMoney = 50 + (user.level * 10);
            const moneyEarned = economy.random(baseMoney, baseMoney * 3);
            user.balance += moneyEarned;
            rewardMsg = `received ${act.reward.replace('(Money)', '')} of 💰 ${moneyEarned} coins!`;
        } else {
            let qty = 1;
            if (Math.random() < 0.25) qty = 2;
            if (Math.random() < 0.05) qty = 3;

            for (let i = 0; i < qty; i++) {
                user.inventory.push({
                    name: act.reward,
                    type: 'material',
                    effect: {},
                    boughtAt: Date.now()
                });
            }
            rewardMsg = `received ${qty}x ${act.reward}!`;
        }

        economy.saveEconomyDB(db);

        let msgOutput = `✅ ${sender.name} is ${act.verb}... ${rewardMsg}\n⭐ +${act.xp} XP`;
        if (leveledUp) {
            msgOutput += `\n🎉 LEVEL UP! Level ${user.level} (Full Heal + Bonus Coins)`;
        }

        await sendMessage(msgOutput);
    }
};
