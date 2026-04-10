const { Client, GatewayIntentBits } = require("discord.js");
const { Client: PGClient } = require("pg");

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// ============================================================
// CONSTANTES
// ============================================================

const COOLDOWN_MS = 20 * 60 * 1000;

const RARITY_EMOJIS = {
  'Commun':     '⚪',
  'Peu Commun': '🟢',
  'Rare':       '🔵',
  'Épique':     '🟣',
  'Légendaire': '🟡',
};

const RARITY_WEIGHTS = {
  'Commun':     50,
  'Peu Commun': 30,
  'Rare':       15,
  'Épique':      4,
  'Légendaire':  1,
};

// Haki — chances indépendantes pour chaque type
const HAKI_TYPES = [
  {
    key:      'observation',
    label:    "Haki de l'Observation",
    emoji:    '👁️',
    role:     "Haki Observation",
    chance:   65,   // 65%
  },
  {
    key:      'armement',
    label:    "Haki de l'Armement",
    emoji:    '⚔️',
    role:     "Haki Armement",
    chance:   55,   // 55%
  },
  {
    key:      'rois',
    label:    "Haki des Rois",
    emoji:    '👑',
    role:     "Haki des Rois",
    chance:   5,    // 5% — rare
  },
];

// Entraînement Haki
const TRAIN_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 heures
const TRAIN_XP_MIN      = 20;
const TRAIN_XP_MAX      = 50;
const TRAIN_THRESHOLDS  = { observation: 150, armement: 400, rois: 2000 };

function progressBar(current, max, len = 10) {
  const filled = Math.min(len, Math.round((Math.min(current, max) / max) * len));
  return '`' + '█'.repeat(filled) + '░'.repeat(len - filled) + '`';
}

// Niveaux de maîtrise Haki et leurs bonus en combat
// Observation → seuil d'esquive de la CIBLE
// Armement    → bonus d'attaque de l'ATTAQUANT
// Rois        → bonus dégâts fixes de l'ATTAQUANT
function getHakiBonuses(haki, obsXp, armXp, roisXp) {
  if (!haki) return { dodgeBonus: 0, attackBonus: 0, dmgBonus: 0, levels: {} };
  const levels = {};
  let dodgeBonus = 0, attackBonus = 0, dmgBonus = 0;

  if (haki.observation) {
    if      (obsXp >= 1000) { dodgeBonus = 15; levels.observation = 'Maître'; }
    else if (obsXp >=  600) { dodgeBonus = 10; levels.observation = 'Avancé'; }
    else if (obsXp >=  300) { dodgeBonus =  5; levels.observation = 'Intermédiaire'; }
    else                    { dodgeBonus =  0; levels.observation = 'Débutant'; }
  }

  if (haki.armement) {
    if      (armXp >= 1500) { attackBonus = 6; levels.armement = 'Maître'; }
    else if (armXp >= 1000) { attackBonus = 4; levels.armement = 'Avancé'; }
    else if (armXp >=  700) { attackBonus = 2; levels.armement = 'Intermédiaire'; }
    else                    { attackBonus = 0; levels.armement = 'Débutant'; }
  }

  if (haki.rois) {
    if      (roisXp >= 5000) { dmgBonus = 20; levels.rois = 'Maître'; }
    else if (roisXp >= 4000) { dmgBonus = 15; levels.rois = 'Avancé'; }
    else if (roisXp >= 3000) { dmgBonus = 10; levels.rois = 'Intermédiaire'; }
    else                     { dmgBonus =  5; levels.rois = 'Débutant'; }
  }

  return { dodgeBonus, attackBonus, dmgBonus, levels };
}

// ── Quêtes ────────────────────────────────────────────────────
const QUEST_DIFF = {
  'Facile':     { ennemi_hp: 50,  ennemi_atk: 5,  ennemi_def: 2,  reward_min: 500,   reward_max: 2000  },
  'Normal':     { ennemi_hp: 120, ennemi_atk: 10, ennemi_def: 5,  reward_min: 2000,  reward_max: 6000  },
  'Difficile':  { ennemi_hp: 280, ennemi_atk: 18, ennemi_def: 10, reward_min: 5000,  reward_max: 15000 },
  'Légendaire': { ennemi_hp: 600, ennemi_atk: 30, ennemi_def: 20, reward_min: 15000, reward_max: 60000 },
};

const QUEST_TEMPLATES = [
  { type: 'combat',  nom: 'Escouade de Marines',     ennemi: 'Capitaine Marine',     desc: 'Une patrouille de Marines menace les habitants.' },
  { type: 'combat',  nom: 'Robots en maraude',        ennemi: 'Robot de combat',      desc: 'Des robots fous dévastent le quartier portuaire.' },
  { type: 'combat',  nom: 'Bande de pirates véreux',  ennemi: 'Chef des pirates',     desc: 'Une bande de pirates pillent les marchands locaux.' },
  { type: 'combat',  nom: 'Chasseur de primes ennemi',ennemi: 'Chasseur d\'élite',    desc: 'Un chasseur de primes s\'en prend aux habitants.' },
  { type: 'tresor',  nom: 'Coffre du Capitaine',      ennemi: 'Gardien du trésor',    desc: 'Un coffre caché, protégé par un mystérieux gardien.' },
  { type: 'tresor',  nom: 'Épave maudite',             ennemi: 'Esprit de l\'épave',   desc: 'Une épave légendaire recèle des trésors... et des dangers.' },
  { type: 'tresor',  nom: 'Grotte aux joyaux',         ennemi: 'Créature des cavernes',desc: 'Des gemmes rares gardées par une créature souterraine.' },
  { type: 'chasse',  nom: 'Créature menaçante',        ennemi: 'Bête sauvage',         desc: 'Une créature féroce s\'attaque aux villageois innocents.' },
  { type: 'chasse',  nom: 'Monstre des profondeurs',   ennemi: 'Monstre marin',        desc: 'Un monstre marin bloque l\'accès au port.' },
  { type: 'chasse',  nom: 'Hors-la-loi en fuite',      ennemi: 'Criminel recherché',   desc: 'Un dangereux criminel doit être mis hors d\'état de nuire.' },
];

const QUEST_EMOJI       = { combat: '⚔️', tresor: '💎', chasse: '🎯' };
const DIFF_STARS        = { 'Facile': '⭐', 'Normal': '⭐⭐', 'Difficile': '⭐⭐⭐', 'Légendaire': '⭐⭐⭐⭐' };
const COMBAT_CD_MS      = 30 * 60 * 1000; // 30 min entre chaque round

function generateQuestForDiff(difficulte, ile) {
  const conf   = QUEST_DIFF[difficulte];
  const tpl    = QUEST_TEMPLATES[Math.floor(Math.random() * QUEST_TEMPLATES.length)];
  const reward = Math.floor(Math.random() * (conf.reward_max - conf.reward_min + 1)) + conf.reward_min;
  return { ...tpl, difficulte, ile, recompense: reward,
    ennemi_hp: conf.ennemi_hp, ennemi_atk: conf.ennemi_atk, ennemi_def: conf.ennemi_def };
}

// ── Îles disponibles ──────────────────────────────────────────
const ISLANDS = [
  'Fuschia', 'Loguetown', 'Arlong Park', 'Alabasta', 'Skypiea',
  'Water 7', 'Enies Lobby', 'Thriller Bark', 'Sabaody Archipelago',
  'Fishman Island', 'Dressrosa', 'Whole Cake Island', 'Wano'
];

// Coût en durabilité par traversée (min–max)
const DURAB_COST_MIN = 10;
const DURAB_COST_MAX = 25;

// ── Articles du Port (shop fixe, consommables) ─────────────────
const PORT_ITEMS = [
  { key: 'planche',       name: 'Planche de bois',    prix: 500,   repair: 20,  heal: 0  },
  { key: 'planches5',     name: 'Lot de planches ×5', prix: 2000,  repair: 100, heal: 0  },
  { key: 'potion',        name: 'Potion de soin',      prix: 300,   repair: 0,   heal: 20 },
  { key: 'grande_potion', name: 'Grande potion',       prix: 800,   repair: 0,   heal: 50 },
  { key: 'kit_reparation',name: 'Kit de réparation',  prix: 4500,  repair: 200, heal: 0  },
];

const DEFAULT_LOOT_POOL = [
  { name: 'Boulet de canon',       rarity: 'Commun' },
  { name: 'Corde de marin',        rarity: 'Commun' },
  { name: 'Bouteille de rhum',     rarity: 'Commun' },
  { name: 'Chapeau de paille usé', rarity: 'Commun' },
  { name: 'Épée rouillée',         rarity: 'Peu Commun' },
  { name: 'Carte maritime',        rarity: 'Peu Commun' },
  { name: 'Boussole de marin',     rarity: 'Peu Commun' },
  { name: 'Drapeau de pirates',    rarity: 'Peu Commun' },
  { name: 'Katana',                rarity: 'Rare' },
  { name: 'Lunettes du navigateur',rarity: 'Rare' },
  { name: 'Pistolet de flibustier',rarity: 'Rare' },
  { name: 'Épée maudite',          rarity: 'Épique' },
  { name: 'Carte au trésor',       rarity: 'Épique' },
  { name: 'Fragment de Ponéglyphe',rarity: 'Légendaire' },
];

// ============================================================
// INITIALISATION BDD
// ============================================================

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      user_id   TEXT PRIMARY KEY,
      money     INTEGER NOT NULL DEFAULT 1000,
      inventory JSONB   NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS bounties (
      user_id TEXT    PRIMARY KEY,
      amount  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cooldowns (
      user_id   TEXT   PRIMARY KEY,
      last_used BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shop_items (
      name_key TEXT    PRIMARY KEY,
      name     TEXT    NOT NULL,
      price    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loot_pool (
      name   TEXT PRIMARY KEY,
      rarity TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS haki_results (
      user_id     TEXT    PRIMARY KEY,
      observation BOOLEAN NOT NULL DEFAULT FALSE,
      armement    BOOLEAN NOT NULL DEFAULT FALSE,
      rois        BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS training (
      user_id    TEXT    PRIMARY KEY,
      obs_xp     INTEGER NOT NULL DEFAULT 0,
      arm_xp     INTEGER NOT NULL DEFAULT 0,
      rois_xp    INTEGER NOT NULL DEFAULT 0,
      last_train BIGINT
    );
    CREATE TABLE IF NOT EXISTS bateaux (
      user_id        TEXT    PRIMARY KEY,
      durabilite     INTEGER NOT NULL DEFAULT 100,
      durabilite_max INTEGER NOT NULL DEFAULT 100,
      ile_actuelle   TEXT    NOT NULL DEFAULT 'Fuschia'
    );
    CREATE TABLE IF NOT EXISTS quetes_actives (
      user_id        TEXT    PRIMARY KEY,
      quete_nom      TEXT    NOT NULL,
      quete_desc     TEXT    NOT NULL,
      type_quete     TEXT    NOT NULL,
      difficulte     TEXT    NOT NULL,
      ile            TEXT    NOT NULL,
      recompense     INTEGER NOT NULL,
      ennemi_nom     TEXT    NOT NULL,
      ennemi_hp      INTEGER NOT NULL,
      ennemi_hp_max  INTEGER NOT NULL,
      ennemi_atk     INTEGER NOT NULL,
      ennemi_def     INTEGER NOT NULL,
      commencee_at   BIGINT  NOT NULL,
      last_combat    BIGINT
    );
  `);

  // Colonnes de combat (ajout rétrocompatible)
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS hp      INTEGER NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS max_hp  INTEGER NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS attack  INTEGER NOT NULL DEFAULT 10`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS defense INTEGER NOT NULL DEFAULT 5`);

  // Amorcer le pool de loot si vide
  const { rowCount } = await pool.query('SELECT 1 FROM loot_pool LIMIT 1');
  if (rowCount === 0) {
    for (const item of DEFAULT_LOOT_POOL) {
      await pool.query(
        'INSERT INTO loot_pool (name, rarity) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [item.name, item.rarity]
      );
    }
    console.log('✅ Pool de loot initialisé avec les items par défaut.');
  }
}

// ============================================================
// FONCTIONS BDD — JOUEURS
// ============================================================

async function getPlayer(userId) {
  await pool.query(
    'INSERT INTO players (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [userId]
  );
  const { rows } = await pool.query('SELECT * FROM players WHERE user_id = $1', [userId]);
  return rows[0];
}

async function addMoney(userId, amount) {
  await pool.query('UPDATE players SET money = money + $1 WHERE user_id = $2', [amount, userId]);
}

async function deductMoney(userId, amount) {
  await pool.query('UPDATE players SET money = money - $1 WHERE user_id = $2', [amount, userId]);
}

async function addToInventory(userId, itemName) {
  await pool.query(
    "UPDATE players SET inventory = inventory || $1::jsonb WHERE user_id = $2",
    [JSON.stringify([itemName]), userId]
  );
}

async function updateHP(userId, hp) {
  await pool.query('UPDATE players SET hp = $1 WHERE user_id = $2', [hp, userId]);
}

async function updateMaxHP(userId, maxHp) {
  await pool.query('UPDATE players SET max_hp = $1 WHERE user_id = $2', [maxHp, userId]);
}

async function updateStat(userId, col, val) {
  await pool.query(`UPDATE players SET ${col} = $1 WHERE user_id = $2`, [val, userId]);
}

// ============================================================
// FONCTIONS BDD — BATEAUX
// ============================================================

async function getBateau(userId) {
  await pool.query(
    'INSERT INTO bateaux (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [userId]
  );
  const { rows } = await pool.query('SELECT * FROM bateaux WHERE user_id = $1', [userId]);
  return rows[0];
}

async function updateDurabilite(userId, dur) {
  await pool.query('UPDATE bateaux SET durabilite = $1 WHERE user_id = $2', [dur, userId]);
}

async function setIsland(userId, ile) {
  await pool.query('UPDATE bateaux SET ile_actuelle = $1 WHERE user_id = $2', [ile, userId]);
}

// ============================================================
// FONCTIONS BDD — QUÊTES
// ============================================================

async function getQuete(userId) {
  const { rows } = await pool.query('SELECT * FROM quetes_actives WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

async function startQuete(userId, q) {
  await pool.query(`
    INSERT INTO quetes_actives
      (user_id, quete_nom, quete_desc, type_quete, difficulte, ile, recompense,
       ennemi_nom, ennemi_hp, ennemi_hp_max, ennemi_atk, ennemi_def, commencee_at, last_combat)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,NULL)
    ON CONFLICT (user_id) DO UPDATE SET
      quete_nom=$2, quete_desc=$3, type_quete=$4, difficulte=$5, ile=$6, recompense=$7,
      ennemi_nom=$8, ennemi_hp=$9, ennemi_hp_max=$9, ennemi_atk=$10, ennemi_def=$11,
      commencee_at=$12, last_combat=NULL`,
    [userId, q.nom, q.desc, q.type, q.difficulte, q.ile, q.recompense,
     q.ennemi_nom, q.ennemi_hp, q.ennemi_atk, q.ennemi_def, Date.now()]
  );
}

async function updateQueteHP(userId, hp, lastCombat) {
  await pool.query(
    'UPDATE quetes_actives SET ennemi_hp = $1, last_combat = $2 WHERE user_id = $3',
    [hp, lastCombat, userId]
  );
}

async function deleteQuete(userId) {
  await pool.query('DELETE FROM quetes_actives WHERE user_id = $1', [userId]);
}

// ============================================================
// FONCTIONS BDD — COOLDOWN
// ============================================================

async function getCooldownRemaining(userId) {
  const { rows } = await pool.query('SELECT last_used FROM cooldowns WHERE user_id = $1', [userId]);
  if (rows.length === 0) return 0;
  return Math.max(0, COOLDOWN_MS - (Date.now() - Number(rows[0].last_used)));
}

async function setCooldown(userId) {
  await pool.query(
    `INSERT INTO cooldowns (user_id, last_used) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET last_used = EXCLUDED.last_used`,
    [userId, Date.now()]
  );
}

// ============================================================
// FONCTIONS BDD — PRIMES
// ============================================================

async function addBounty(userId, amount) {
  await pool.query(
    `INSERT INTO bounties (user_id, amount) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET amount = bounties.amount + EXCLUDED.amount`,
    [userId, amount]
  );
}

async function getBounty(userId) {
  const { rows } = await pool.query('SELECT amount FROM bounties WHERE user_id = $1', [userId]);
  return rows.length > 0 ? rows[0].amount : 0;
}

// ============================================================
// FONCTIONS BDD — SHOP
// ============================================================

async function getShopItems() {
  const { rows } = await pool.query('SELECT * FROM shop_items ORDER BY name');
  return rows;
}

async function getShopItem(key) {
  const { rows } = await pool.query('SELECT * FROM shop_items WHERE name_key = $1', [key]);
  return rows[0] || null;
}

async function addShopItem(name, price) {
  const key = name.trim().toLowerCase();
  await pool.query(
    'INSERT INTO shop_items (name_key, name, price) VALUES ($1, $2, $3)',
    [key, name.trim(), price]
  );
}

async function removeShopItem(key) {
  const { rowCount } = await pool.query('DELETE FROM shop_items WHERE name_key = $1', [key]);
  return rowCount > 0;
}

// ============================================================
// FONCTIONS BDD — LOOT POOL
// ============================================================

async function getLootPool() {
  const { rows } = await pool.query('SELECT * FROM loot_pool');
  return rows;
}

async function addLootItem(name, rarity) {
  await pool.query(
    'INSERT INTO loot_pool (name, rarity) VALUES ($1, $2)',
    [name.trim(), rarity]
  );
}

async function removeLootItem(name) {
  const { rowCount } = await pool.query(
    'DELETE FROM loot_pool WHERE LOWER(name) = LOWER($1)', [name]
  );
  return rowCount > 0;
}

// ============================================================
// FONCTIONS BDD — HAKI
// ============================================================

async function getHaki(userId) {
  const { rows } = await pool.query('SELECT * FROM haki_results WHERE user_id = $1', [userId]);
  return rows[0] || null; // null = pas encore tiré
}

async function saveHaki(userId, observation, armement, rois) {
  await pool.query(
    `INSERT INTO haki_results (user_id, observation, armement, rois)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, observation, armement, rois]
  );
}

async function unlockHakiField(userId, field) {
  await pool.query(`UPDATE haki_results SET ${field} = TRUE WHERE user_id = $1`, [userId]);
}

async function resetHaki(userId) {
  await pool.query('DELETE FROM haki_results WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM training   WHERE user_id = $1', [userId]);
}

async function getTraining(userId) {
  await pool.query(
    'INSERT INTO training (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [userId]
  );
  const { rows } = await pool.query('SELECT * FROM training WHERE user_id = $1', [userId]);
  return rows[0];
}

async function setTrainingXP(userId, obsXp, armXp, roisXp) {
  await pool.query(
    'UPDATE training SET obs_xp = $1, arm_xp = $2, rois_xp = $3, last_train = $4 WHERE user_id = $5',
    [obsXp, armXp, roisXp, Date.now(), userId]
  );
}

// ============================================================
// LOOT
// ============================================================

function formatBerries(n) {
  return Number(n).toLocaleString('fr-FR');
}

async function rollLootItem() {
  const items = await getLootPool();
  if (items.length === 0) return { name: 'Objet mystérieux', rarity: 'Commun' };

  const total = items.reduce((s, i) => s + (RARITY_WEIGHTS[i.rarity] || 1), 0);
  let rand = Math.random() * total;
  for (const item of items) {
    rand -= RARITY_WEIGHTS[item.rarity] || 1;
    if (rand <= 0) return item;
  }
  return items[items.length - 1];
}

function rollFruitType() {
  const rand = Math.random() * 3;
  if (rand < 1) return { fruitType: 'Logia',    item: 'Fruit du Démon Logia 🌊' };
  if (rand < 2) return { fruitType: 'Paramecia', item: 'Fruit du Démon Paramecia ✨' };
  return             { fruitType: 'Zoan',     item: 'Fruit du Démon Zoan 🐉' };
}

// ============================================================
// HANDLER
// ============================================================

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {

    // ── /loot ──────────────────────────────────────────────────
    if (interaction.commandName === 'loot') {
      const userId    = interaction.user.id;
      const remaining = await getCooldownRemaining(userId);

      if (remaining > 0) {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        return interaction.reply({
          content: `⏳ Attends encore **${mins}m ${secs}s** avant de chercher du butin !`,
          ephemeral: true
        });
      }

      await setCooldown(userId);
      await getPlayer(userId); // s'assure que le joueur existe

      const rand = Math.random() * 100;

      if (rand < 30) {
        return interaction.reply("Tu n'as rien trouvé...");
      }

      if (rand < 90) {
        const amount = Math.floor(Math.random() * 99500) + 500;
        await addMoney(userId, amount);
        return interaction.reply(`💰 Tu gagnes **${formatBerries(amount)} Berries** !`);
      }

      if (rand < 99) {
        const lootItem = await rollLootItem();
        const emoji    = RARITY_EMOJIS[lootItem.rarity] || '⚪';
        const itemName = `${lootItem.name} (${lootItem.rarity})`;
        await addToInventory(userId, itemName);
        return interaction.reply(
          `${emoji} Tu trouves : **${lootItem.name}** — *${lootItem.rarity}*`
        );
      }

      // Fruit du Démon (1%)
      const fruit = rollFruitType();
      await addToInventory(userId, fruit.item);
      return interaction.reply(
        `🍈 INCROYABLE ! Tu as trouvé un **Fruit du Démon ${fruit.fruitType}** : ${fruit.item} !`
      );
    }

    // ── /balance ───────────────────────────────────────────────
    if (interaction.commandName === 'balance') {
      const player = await getPlayer(interaction.user.id);
      const prime  = await getBounty(interaction.user.id);
      let msg = `💰 Tu as **${formatBerries(player.money)} Berries**`;
      if (prime > 0) msg += `\n🔴 Ta prime : **${formatBerries(prime)} Berries**`;
      return interaction.reply(msg);
    }

    // ── /inventory ─────────────────────────────────────────────
    if (interaction.commandName === 'inventory') {
      const player = await getPlayer(interaction.user.id);
      const inv    = Array.isArray(player.inventory) ? player.inventory : [];
      return interaction.reply(`🎒 Inventaire : ${inv.join(', ') || 'vide'}`);
    }

    // ── /prime ─────────────────────────────────────────────────
    if (interaction.commandName === 'prime') {
      const sub   = interaction.options.getSubcommand();
      const cible = interaction.options.getUser('joueur');

      if (sub === 'ajouter') {
        const montant = interaction.options.getInteger('montant');
        await addBounty(cible.id, montant);
        const total = await getBounty(cible.id);
        return interaction.reply(
          `🔴 La prime de **${cible.username}** est maintenant de **${formatBerries(total)} Berries** !`
        );
      }

      if (sub === 'voir') {
        const prime = await getBounty(cible.id);
        return interaction.reply(
          prime === 0
            ? `📋 **${cible.username}** n'a pas encore de prime.`
            : `🔴 Prime de **${cible.username}** : **${formatBerries(prime)} Berries**`
        );
      }
    }

    // ── /shop ──────────────────────────────────────────────────
    if (interaction.commandName === 'shop') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'voir') {
        const items = await getShopItems();
        if (items.length === 0) return interaction.reply('🏪 Le shop est vide pour l\'instant.');
        const liste = items
          .map((i, idx) => `**${idx + 1}.** ${i.name} — ${formatBerries(i.price)} Berries`)
          .join('\n');
        return interaction.reply(`🏪 **Shop :**\n${liste}`);
      }

      if (sub === 'acheter') {
        const nom    = interaction.options.getString('article');
        const key    = nom.trim().toLowerCase();
        const item   = await getShopItem(key);

        if (!item) {
          return interaction.reply({
            content: `❌ **${nom}** n'existe pas dans le shop. Fais \`/shop voir\` pour la liste.`,
            ephemeral: true
          });
        }

        const player = await getPlayer(interaction.user.id);
        if (player.money < item.price) {
          return interaction.reply({
            content: `❌ Il te manque **${formatBerries(item.price - player.money)} Berries** pour acheter **${item.name}**.`,
            ephemeral: true
          });
        }

        await deductMoney(interaction.user.id, item.price);
        await addToInventory(interaction.user.id, item.name);
        const updated = await getPlayer(interaction.user.id);
        return interaction.reply(
          `🛒 Tu as acheté **${item.name}** pour **${formatBerries(item.price)} Berries** !\n💰 Solde restant : **${formatBerries(updated.money)} Berries**`
        );
      }

      if (sub === 'ajouter') {
        const nom  = interaction.options.getString('nom').trim();
        const prix = interaction.options.getInteger('prix');
        const key  = nom.toLowerCase();

        const existe = await getShopItem(key);
        if (existe) {
          return interaction.reply({
            content: `⚠️ **${nom}** existe déjà dans le shop (${formatBerries(existe.price)} Berries).`,
            ephemeral: true
          });
        }

        await addShopItem(nom, prix);
        return interaction.reply(`✅ **${nom}** ajouté au shop pour **${formatBerries(prix)} Berries** !`);
      }

      if (sub === 'retirer') {
        const nom = interaction.options.getString('nom').trim();
        const ok  = await removeShopItem(nom.toLowerCase());
        return interaction.reply(
          ok
            ? `🗑️ **${nom}** retiré du shop.`
            : { content: `❌ **${nom}** n'existe pas dans le shop.`, ephemeral: true }
        );
      }
    }

    // ── /lootpool ──────────────────────────────────────────────
    if (interaction.commandName === 'lootpool') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'voir') {
        const items   = await getLootPool();
        const grouped = {};
        for (const item of items) {
          if (!grouped[item.rarity]) grouped[item.rarity] = [];
          grouped[item.rarity].push(item.name);
        }
        const order = ['Commun', 'Peu Commun', 'Rare', 'Épique', 'Légendaire'];
        const lines = order
          .filter(r => grouped[r])
          .map(r => `${RARITY_EMOJIS[r]} **${r}** : ${grouped[r].join(', ')}`);
        return interaction.reply(`🎲 **Pool de loot (9%) :**\n${lines.join('\n')}`);
      }

      if (sub === 'ajouter') {
        const nom    = interaction.options.getString('nom').trim();
        const rarete = interaction.options.getString('rarete');
        const items  = await getLootPool();
        const existe = items.some(i => i.name.toLowerCase() === nom.toLowerCase());
        if (existe) {
          return interaction.reply({ content: `⚠️ **${nom}** est déjà dans le pool.`, ephemeral: true });
        }
        await addLootItem(nom, rarete);
        return interaction.reply(
          `✅ **${nom}** ajouté au pool avec la rareté ${RARITY_EMOJIS[rarete]} **${rarete}** !`
        );
      }

      if (sub === 'retirer') {
        const nom = interaction.options.getString('nom').trim();
        const ok  = await removeLootItem(nom);
        return interaction.reply(
          ok
            ? `🗑️ **${nom}** retiré du pool de loot.`
            : { content: `❌ **${nom}** n'existe pas dans le pool.`, ephemeral: true }
        );
      }
    }

    // ── /haki ──────────────────────────────────────────────────
    if (interaction.commandName === 'haki') {
      const sub    = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      // ---- haki decouvrir ----
      if (sub === 'decouvrir') {
        const existing = await getHaki(userId);

        // Déjà tiré → afficher les résultats sauvegardés
        if (existing) {
          const lines = HAKI_TYPES
            .filter(h => existing[h.key])
            .map(h => `${h.emoji} **${h.label}**`);
          const none = lines.length === 0;
          return interaction.reply({
            content: none
              ? `🌀 Tu as déjà fait ta découverte. Tu ne maîtrises **aucun Haki** naturellement — entraîne-toi avec \`/entrainement\` !`
              : `🌀 Tu as déjà découvert ton potentiel :\n${lines.join('\n')}\n\n*Continue à t'entraîner avec \`/entrainement\` pour débloquer les types manquants !*`,
            ephemeral: true
          });
        }

        // Premier tirage — roll indépendant pour chaque Haki
        let obs  = Math.random() * 100 < 65;
        let arm  = Math.random() * 100 < 55;
        let rois = Math.random() * 100 < 5;

        await saveHaki(userId, obs, arm, rois);

        // Assignation des rôles Discord
        const rolesIntrouvables = [];
        try {
          await interaction.guild.roles.fetch();
          for (const haki of HAKI_TYPES) {
            const obtained = { observation: obs, armement: arm, rois }[haki.key];
            if (!obtained) continue;
            const role = interaction.guild.roles.cache.find(r => r.name === haki.role);
            if (role) {
              await interaction.member.roles.add(role);
            } else {
              rolesIntrouvables.push(`"${haki.role}"`);
            }
          }
        } catch (roleErr) {
          console.error('Erreur assignation rôles Haki :', roleErr);
        }

        const obtained = HAKI_TYPES.filter(h => ({ observation: obs, armement: arm, rois })[h.key]);
        const locked   = HAKI_TYPES.filter(h => !({ observation: obs, armement: arm, rois })[h.key]);
        const lines    = obtained.map(h => `${h.emoji} **${h.label}**`);

        let msg = obtained.length === 0
          ? `🌀 **${interaction.user.username}**, le destin a décidé...\nTu ne maîtrises **aucun Haki** naturellement. La route sera difficile...`
          : `🌀 **${interaction.user.username}**, tu as découvert ton potentiel !\n\n${lines.join('\n')}`;

        if (rois) {
          msg += `\n\n👑 **EXTRAORDINAIRE !** Le Haki des Rois coule dans tes veines — un pouvoir réservé à une poignée d'élus !`;
        }

        if (locked.length > 0) {
          msg += `\n\n🏋️ *Les Haki non-découverts peuvent être débloqués à force d'entraînement — utilise \`/entrainement\` !*`;
        }

        if (rolesIntrouvables.length > 0) {
          msg += `\n\n⚠️ *(Rôles introuvables : ${rolesIntrouvables.join(', ')} — créez-les sur le serveur.)*`;
        }

        return interaction.reply(msg);
      }

      // ---- haki reset ----
      if (sub === 'reset') {
        const cible = interaction.options.getUser('joueur');
        await resetHaki(cible.id);
        return interaction.reply({
          content: `🔄 Le Haki et l'entraînement de **${cible.username}** ont été réinitialisés. Il peut refaire \`/haki decouvrir\`.`,
          ephemeral: true
        });
      }
    }

    // ── /entrainement ───────────────────────────────────────────
    if (interaction.commandName === 'entrainement') {
      const userId = interaction.user.id;
      const choix  = interaction.options.getString('type');
      const haki   = await getHaki(userId);

      if (!haki) {
        return interaction.reply({
          content: `🌀 Tu dois d'abord faire \`/haki decouvrir\` avant de t'entraîner !`,
          ephemeral: true
        });
      }

      // Vérification cooldown (commune à tous les types d'entraînement)
      const train = await getTraining(userId);
      const now   = Date.now();
      if (train.last_train && now - Number(train.last_train) < TRAIN_COOLDOWN_MS) {
        const reste = TRAIN_COOLDOWN_MS - (now - Number(train.last_train));
        const rh    = Math.floor(reste / 3_600_000);
        const rm    = Math.floor((reste % 3_600_000) / 60_000);
        return interaction.reply({
          content: `⏳ Tu es épuisé ! Repose-toi encore **${rh}h ${rm}min** avant de t'entraîner à nouveau.`,
          ephemeral: true
        });
      }

      // ─── Entraînement STATS PHYSIQUES ────────────────────────
      if (choix === 'force' || choix === 'endurance' || choix === 'defense') {
        const joueur = await getPlayer(userId);
        let statLabel, gain, ancienneVal, nouvelleVal, colonne;

        if (choix === 'force') {
          gain       = Math.floor(Math.random() * 2) + 1; // +1 ou +2
          ancienneVal = joueur.attack;
          nouvelleVal = joueur.attack + gain;
          colonne    = 'attack';
          statLabel  = '⚔️ Attaque';
        } else if (choix === 'endurance') {
          gain       = Math.floor(Math.random() * 5) + 3; // +3 à +7
          ancienneVal = joueur.max_hp;
          nouvelleVal = joueur.max_hp + gain;
          colonne    = 'max_hp';
          statLabel  = '❤️ PV max';
        } else {
          gain       = 1;
          ancienneVal = joueur.defense;
          nouvelleVal = joueur.defense + gain;
          colonne    = 'defense';
          statLabel  = '🛡️ Défense';
        }

        await updateStat(userId, colonne, nouvelleVal);
        // Mettre à jour le cooldown sans toucher aux XP Haki
        await setTrainingXP(userId, train.obs_xp, train.arm_xp, train.rois_xp);

        return interaction.reply(
          `🏋️ **Entraînement physique terminé !**\n\n` +
          `${statLabel} : **${ancienneVal}** → **${nouvelleVal}** *(+${gain})*\n\n` +
          `*Prochain entraînement dans 2 heures.*`
        );
      }

      // ─── Entraînement HAKI ───────────────────────────────────
      const xpGain = Math.floor(Math.random() * (TRAIN_XP_MAX - TRAIN_XP_MIN + 1)) + TRAIN_XP_MIN;

      // XP toujours croissant — continue après déblocage pour la maîtrise
      const newObs  = train.obs_xp  + xpGain;
      const newArm  = train.arm_xp  + xpGain;
      const newRois = train.rois_xp + xpGain;

      await setTrainingXP(userId, newObs, newArm, newRois);

      // Vérification des déblocages
      const debloqués = [];
      try {
        await interaction.guild.roles.fetch();
        for (const h of HAKI_TYPES) {
          if (haki[h.key]) continue;
          const xpActuel = { observation: newObs, armement: newArm, rois: newRois }[h.key];
          if (xpActuel >= TRAIN_THRESHOLDS[h.key]) {
            await unlockHakiField(userId, h.key);
            debloqués.push(h);
            const role = interaction.guild.roles.cache.find(r => r.name === h.role);
            if (role) await interaction.member.roles.add(role).catch(() => {});
          }
        }
      } catch (roleErr) {
        console.error('Erreur déblocage rôles :', roleErr);
      }

      const hakiMaj  = await getHaki(userId);
      const bonusMaj = getHakiBonuses(hakiMaj, newObs, newArm, newRois);

      let msg = `🌀 **Entraînement Haki terminé !** +**${xpGain} XP**\n\n`;

      if (debloqués.length > 0) {
        msg += debloqués.map(h => `✨ **DÉBLOQUÉ !** ${h.emoji} **${h.label}** !`).join('\n') + '\n\n';
      }

      // Affichage des Haki avec niveau de maîtrise et bonus
      const xpMap = { observation: newObs, armement: newArm, rois: newRois };
      const bonusDesc = {
        observation: `+${bonusMaj.dodgeBonus}% esquive`,
        armement:    `+${bonusMaj.attackBonus} attaque`,
        rois:        `+${bonusMaj.dmgBonus} dégâts`,
      };
      const xpKey = { observation: 'obs_xp', armement: 'arm_xp', rois: 'rois_xp' };

      const lignesProgress = [];
      for (const h of HAKI_TYPES) {
        const xp = xpMap[h.key];
        if (hakiMaj[h.key]) {
          const niveau = bonusMaj.levels[h.key] || 'Débutant';
          lignesProgress.push(`${h.emoji} **${h.label}** — ✅ ${niveau} *(${bonusDesc[h.key]})* — XP : ${xp}`);
        } else {
          const threshold = TRAIN_THRESHOLDS[h.key];
          const bar       = progressBar(xp, threshold);
          lignesProgress.push(`${h.emoji} **${h.label}** — ${bar} ${Math.min(xp, threshold)}/${threshold} XP`);
        }
      }

      msg += lignesProgress.join('\n');
      msg += `\n\n*Prochain entraînement dans 2 heures.*`;

      return interaction.reply(msg);
    }

    // ── /attaquer ───────────────────────────────────────────────
    if (interaction.commandName === 'attaquer') {
      const cibleUser = interaction.options.getUser('cible');

      if (cibleUser.id === interaction.user.id) {
        return interaction.reply({ content: '❌ Tu ne peux pas t\'attaquer toi-même.', ephemeral: true });
      }
      if (cibleUser.bot) {
        return interaction.reply({ content: '❌ Tu ne peux pas attaquer un bot.', ephemeral: true });
      }

      const attaquant = await getPlayer(interaction.user.id);
      const cible     = await getPlayer(cibleUser.id);

      // Récupération des bonus Haki
      const attaquantHaki  = await getHaki(interaction.user.id);
      const attaquantTrain = attaquantHaki ? await getTraining(interaction.user.id) : null;
      const attBonus       = getHakiBonuses(
        attaquantHaki,
        attaquantTrain?.obs_xp  ?? 0,
        attaquantTrain?.arm_xp  ?? 0,
        attaquantTrain?.rois_xp ?? 0
      );

      const cibleHaki  = await getHaki(cibleUser.id);
      const cibleTrain = cibleHaki ? await getTraining(cibleUser.id) : null;
      const cibleBonus = getHakiBonuses(
        cibleHaki,
        cibleTrain?.obs_xp  ?? 0,
        cibleTrain?.arm_xp  ?? 0,
        cibleTrain?.rois_xp ?? 0
      );

      // Seuil d'esquive ajusté par l'Observation de la CIBLE
      const dodgeThreshold = 30 + cibleBonus.dodgeBonus;
      const critThreshold  = dodgeThreshold + 10;

      // Roll principal (0–100)
      const roll = Math.random() * 100;

      let esquive  = false;
      let critique = false;
      let degats   = 0;

      if (roll < dodgeThreshold) {
        esquive = true;
      } else {
        if (roll < critThreshold) critique = true;

        const bonusRnd    = Math.floor(Math.random() * 5) + 1;
        const attackTotal = attaquant.attack + attBonus.attackBonus;
        degats = Math.max(1, attackTotal - cible.defense + bonusRnd + attBonus.dmgBonus);
        if (critique) degats *= 2;
      }

      // Application des dégâts
      const hpAvant  = cible.hp;
      let   hpApres  = hpAvant - degats;
      let   ko       = false;

      if (hpApres <= 0) {
        ko     = true;
        hpApres = cible.max_hp; // reset au MAX entraîné, pas forcément 100
      }

      await updateHP(cibleUser.id, hpApres);

      // Construction du résultat
      const lignes = [
        `⚔️ **${interaction.user.username}** attaque **${cibleUser.username}**`,
        ``,
        `🎲 Roll : \`${Math.floor(roll)}\` *(esquive < ${dodgeThreshold}, critique ${dodgeThreshold}–${critThreshold})*`,
      ];

      // Bonus actifs
      const bonusActifs = [];
      if (attBonus.attackBonus > 0)  bonusActifs.push(`⚔️ Armement ${attBonus.levels.armement} (+${attBonus.attackBonus} ATQ)`);
      if (attBonus.dmgBonus    > 0)  bonusActifs.push(`👑 Rois ${attBonus.levels.rois} (+${attBonus.dmgBonus} dégâts)`);
      if (cibleBonus.dodgeBonus > 0) bonusActifs.push(`👁️ Obs. ${cibleBonus.levels.observation} (+${cibleBonus.dodgeBonus}% esquive)`);
      if (bonusActifs.length > 0) lignes.push(`✨ Bonus : ${bonusActifs.join(' | ')}`);

      lignes.push('');

      if (esquive) {
        lignes.push(`💨 Résultat : **ESQUIVE** — 0 dégât`);
        lignes.push(`❤️ PV de ${cibleUser.username} : **${hpAvant}** *(inchangé)*`);
      } else {
        lignes.push(`${critique ? '💥 Résultat : **COUP CRITIQUE**' : '🗡️ Résultat : Attaque normale'}`);
        lignes.push(`📉 Dégâts infligés : **${degats}**`);
        if (ko) {
          lignes.push(`💀 **${cibleUser.username}** est KO ! *(PV réinitialisés à ${cible.max_hp})*`);
          lignes.push(`❤️ PV de ${cibleUser.username} : **${hpAvant} → 0** *(KO → reset ${cible.max_hp})*`);
        } else {
          lignes.push(`❤️ PV de ${cibleUser.username} : **${hpAvant}** → **${hpApres}** / ${cible.max_hp}`);
        }
      }

      return interaction.reply(lignes.join('\n'));
    }

    // ── /quetes ─────────────────────────────────────────────────
    if (interaction.commandName === 'quetes') {
      const sub    = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      // ---- quetes voir ----
      if (sub === 'voir') {
        const bateau = await getBateau(userId);
        const ile    = bateau.ile_actuelle;
        const active = await getQuete(userId);

        const lignes = Object.entries(QUEST_DIFF).map(([diff, conf]) => {
          const tpl   = QUEST_TEMPLATES[Math.floor(Math.random() * QUEST_TEMPLATES.length)];
          const emoji = QUEST_EMOJI[tpl.type];
          const stars = DIFF_STARS[diff];
          return (
            `${stars} **${diff}** — ${emoji} *${tpl.nom}*\n` +
            `   💰 ${formatBerries(conf.reward_min)}–${formatBerries(conf.reward_max)} Berries` +
            ` | 👹 ${conf.ennemi_hp} PV | ⚔️ ATQ ${conf.ennemi_atk} | 🛡️ DEF ${conf.ennemi_def}`
          );
        });

        let msg = `📋 **Quêtes disponibles à ${ile}**\n\n` + lignes.join('\n\n');
        if (active) {
          msg += `\n\n⚠️ *Tu as déjà une quête active : **${active.quete_nom}** (${active.difficulte}). Utilise \`/quetes statut\` ou \`/quetes combattre\`.*`;
        } else {
          msg += `\n\n*Lance-toi avec \`/quetes commencer\` !*`;
        }
        return interaction.reply(msg);
      }

      // ---- quetes commencer ----
      if (sub === 'commencer') {
        const diff   = interaction.options.getString('difficulte');
        const active = await getQuete(userId);

        if (active) {
          return interaction.reply({
            content: `❌ Tu as déjà une quête : **${active.quete_nom}** (${active.difficulte}).\nTermine-la ou utilise \`/quetes abandonner\`.`,
            ephemeral: true
          });
        }

        const bateau = await getBateau(userId);
        const q      = generateQuestForDiff(diff, bateau.ile_actuelle);
        const conf   = QUEST_DIFF[diff];
        await startQuete(userId, q);

        return interaction.reply(
          `${QUEST_EMOJI[q.type]} **Quête acceptée : ${q.nom}** ${DIFF_STARS[diff]}\n\n` +
          `📍 Île : **${bateau.ile_actuelle}**\n` +
          `📖 *${q.desc}*\n\n` +
          `👹 Ennemi : **${q.ennemi_nom}**\n` +
          `   ❤️ ${conf.ennemi_hp} PV | ⚔️ ATQ ${conf.ennemi_atk} | 🛡️ DEF ${conf.ennemi_def}\n\n` +
          `💰 Récompense : **${formatBerries(q.recompense)} Berries**\n\n` +
          `*Utilise \`/quetes combattre\` pour attaquer l'ennemi ! (cooldown 30 min entre chaque round)*`
        );
      }

      // ---- quetes statut ----
      if (sub === 'statut') {
        const quete = await getQuete(userId);
        if (!quete) {
          return interaction.reply({
            content: `📭 Aucune quête active. Lance-en une avec \`/quetes commencer\` !`,
            ephemeral: true
          });
        }

        const bar  = progressBar(quete.ennemi_hp_max - quete.ennemi_hp, quete.ennemi_hp_max, 12);
        const pct  = Math.round(((quete.ennemi_hp_max - quete.ennemi_hp) / quete.ennemi_hp_max) * 100);
        const now  = Date.now();
        const cdInfo = quete.last_combat && (now - Number(quete.last_combat) < COMBAT_CD_MS)
          ? (() => {
              const reste = COMBAT_CD_MS - (now - Number(quete.last_combat));
              return `⏳ Prochain round dans **${Math.ceil(reste / 60_000)} min**`;
            })()
          : `✅ Prêt à combattre !`;

        return interaction.reply(
          `${QUEST_EMOJI[quete.type_quete]} **Quête : ${quete.quete_nom}** ${DIFF_STARS[quete.difficulte]}\n\n` +
          `📍 Île : **${quete.ile}**\n` +
          `📖 *${quete.quete_desc}*\n\n` +
          `👹 **${quete.ennemi_nom}**\n` +
          `   ❤️ PV : ${bar} **${quete.ennemi_hp}/${quete.ennemi_hp_max}** *(${pct}% dégâts infligés)*\n\n` +
          `💰 Récompense : **${formatBerries(quete.recompense)} Berries**\n` +
          `${cdInfo}`
        );
      }

      // ---- quetes combattre ----
      if (sub === 'combattre') {
        const quete = await getQuete(userId);
        if (!quete) {
          return interaction.reply({ content: `📭 Aucune quête active !`, ephemeral: true });
        }

        // Cooldown entre rounds
        const now = Date.now();
        if (quete.last_combat && now - Number(quete.last_combat) < COMBAT_CD_MS) {
          const reste = COMBAT_CD_MS - (now - Number(quete.last_combat));
          return interaction.reply({
            content: `⏳ Tu récupères encore ! Prochain round dans **${Math.ceil(reste / 60_000)} min**.`,
            ephemeral: true
          });
        }

        const joueur = await getPlayer(userId);
        if (joueur.hp <= 0) {
          return interaction.reply({
            content: `💀 Tu es KO (${joueur.hp} PV) ! Soigne-toi au \`/port\` avant de combattre.`,
            ephemeral: true
          });
        }

        // Récupération bonus Haki de l'attaquant
        const haki       = await getHaki(userId);
        const trainData  = haki ? await getTraining(userId) : null;
        const hakiBonus  = getHakiBonuses(haki, trainData?.obs_xp ?? 0, trainData?.arm_xp ?? 0, trainData?.rois_xp ?? 0);

        // Round de combat
        const bonusRnd    = Math.floor(Math.random() * 5) + 1;
        const attackTotal = joueur.attack + hakiBonus.attackBonus;
        const dmgToEnnemi = Math.max(1, attackTotal - quete.ennemi_def + bonusRnd + hakiBonus.dmgBonus);

        const defRnd      = Math.floor(Math.random() * 5) + 1;
        const dmgToJoueur = Math.max(1, quete.ennemi_atk - joueur.defense + defRnd);

        const newEnnemiHP = Math.max(0, quete.ennemi_hp - dmgToEnnemi);
        const newJoueurHP = Math.max(0, joueur.hp      - dmgToJoueur);

        const lignes = [
          `${QUEST_EMOJI[quete.type_quete]} **Round de combat — ${quete.quete_nom}** ${DIFF_STARS[quete.difficulte]}`,
          ``,
          `🗡️ Tu infliges **${dmgToEnnemi}** dégâts à **${quete.ennemi_nom}**` +
            (hakiBonus.attackBonus > 0 || hakiBonus.dmgBonus > 0 ? ` *(bonus Haki actif)*` : ''),
          `💢 **${quete.ennemi_nom}** te rend **${dmgToJoueur}** dégâts`,
          ``,
        ];

        if (newEnnemiHP <= 0) {
          // ─ VICTOIRE ─
          await deleteQuete(userId);
          await addMoney(userId, quete.recompense);
          const hpFinal = newJoueurHP <= 0 ? joueur.max_hp : newJoueurHP;
          await updateHP(userId, hpFinal);

          lignes.push(`🏆 **VICTOIRE !** **${quete.ennemi_nom}** est vaincu !`);
          lignes.push(`💰 **+${formatBerries(quete.recompense)} Berries** ajoutés à ton compte !`);
          lignes.push(`❤️ Tes PV : **${joueur.hp}** → **${hpFinal}** / ${joueur.max_hp}` +
            (newJoueurHP <= 0 ? ` *(KO simultané — reset à ${joueur.max_hp})*` : ''));
        } else if (newJoueurHP <= 0) {
          // ─ KO du joueur ─
          await updateQueteHP(userId, newEnnemiHP, now);
          await updateHP(userId, joueur.max_hp);

          const bar = progressBar(quete.ennemi_hp_max - newEnnemiHP, quete.ennemi_hp_max, 10);
          lignes.push(`💀 **Tu es KO !** Tes PV sont réinitialisés à **${joueur.max_hp}**.`);
          lignes.push(`👹 **${quete.ennemi_nom}** : ${bar} **${newEnnemiHP}/${quete.ennemi_hp_max}** PV restants`);
          lignes.push(`*Soigne-toi au \`/port\` et reviens au prochain round (30 min).*`);
        } else {
          // ─ Combat en cours ─
          await updateQueteHP(userId, newEnnemiHP, now);
          await updateHP(userId, newJoueurHP);

          const bar = progressBar(quete.ennemi_hp_max - newEnnemiHP, quete.ennemi_hp_max, 10);
          lignes.push(`👹 **${quete.ennemi_nom}** : ${bar} **${newEnnemiHP}/${quete.ennemi_hp_max}** PV`);
          lignes.push(`❤️ Tes PV : **${joueur.hp}** → **${newJoueurHP}** / ${joueur.max_hp}`);
          lignes.push(`*Prochain round dans 30 minutes.*`);
        }

        return interaction.reply(lignes.join('\n'));
      }

      // ---- quetes abandonner ----
      if (sub === 'abandonner') {
        const quete = await getQuete(userId);
        if (!quete) {
          return interaction.reply({ content: `📭 Aucune quête active.`, ephemeral: true });
        }
        await deleteQuete(userId);
        return interaction.reply(
          `🏳️ Tu abandonnes **${quete.quete_nom}** (${quete.difficulte}).\n` +
          `*Démarre une nouvelle quête avec \`/quetes commencer\`.*`
        );
      }
    }

    // ── /bateau ─────────────────────────────────────────────────
    if (interaction.commandName === 'bateau') {
      const userId = interaction.user.id;
      const bateau = await getBateau(userId);

      const pct  = Math.round((bateau.durabilite / bateau.durabilite_max) * 100);
      const bar  = progressBar(bateau.durabilite, bateau.durabilite_max, 12);
      const etat = pct >= 75 ? '🟢 Bon état'
                 : pct >= 40 ? '🟡 Endommagé'
                 : pct >= 15 ? '🟠 Critique'
                 :             '🔴 Inutilisable';

      return interaction.reply(
        `🚢 **État du bateau de ${interaction.user.username}**\n\n` +
        `📍 Île actuelle : **${bateau.ile_actuelle}**\n` +
        `🔧 Durabilité : ${bar} **${bateau.durabilite}/${bateau.durabilite_max}** — ${etat}\n\n` +
        `*Répare ton bateau au \`/port\` avec des planches de bois.*`
      );
    }

    // ── /voyager ─────────────────────────────────────────────────
    if (interaction.commandName === 'voyager') {
      const userId      = interaction.user.id;
      const destination = interaction.options.getString('ile');
      const bateau      = await getBateau(userId);

      if (bateau.ile_actuelle === destination) {
        return interaction.reply({
          content: `📍 Tu es déjà à **${destination}** !`,
          ephemeral: true
        });
      }

      if (bateau.durabilite <= 0) {
        return interaction.reply({
          content: `🔴 Ton bateau est **hors d'usage** ! Achète des planches au \`/port\` pour le réparer.`,
          ephemeral: true
        });
      }

      const cout     = Math.floor(Math.random() * (DURAB_COST_MAX - DURAB_COST_MIN + 1)) + DURAB_COST_MIN;
      const newDurab = Math.max(0, bateau.durabilite - cout);

      await updateDurabilite(userId, newDurab);
      await setIsland(userId, destination);

      const pct  = Math.round((newDurab / bateau.durabilite_max) * 100);
      const bar  = progressBar(newDurab, bateau.durabilite_max, 10);
      const alerte = newDurab <= 0
        ? `\n\n🔴 **ATTENTION !** Ton bateau est maintenant **hors d'usage** — achète des planches au \`/port\` !`
        : newDurab < 20
        ? `\n\n🟠 **Alerte !** Durabilité critique (${newDurab}) — répare vite au \`/port\` !`
        : '';

      return interaction.reply(
        `⛵ **${interaction.user.username}** fait voile vers **${destination}** !\n\n` +
        `📉 Durabilité dépensée : **-${cout}**\n` +
        `🔧 Bateau : ${bar} **${newDurab}/${bateau.durabilite_max}**${alerte}`
      );
    }

    // ── /port ────────────────────────────────────────────────────
    if (interaction.commandName === 'port') {
      const sub    = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      // ---- port voir ----
      if (sub === 'voir') {
        const lignes = PORT_ITEMS.map(item => {
          const effet = item.repair > 0 && item.heal > 0
            ? `Répare +${item.repair} durabilité & +${item.heal} PV`
            : item.repair > 0
            ? `Répare +${item.repair} durabilité`
            : `Restaure +${item.heal} PV`;
          return `🛒 **${item.name}** — ${formatBerries(item.prix)} Berries\n   ↳ ${effet}`;
        });

        return interaction.reply(
          `⚓ **Port — Boutique de consommables**\n\n` +
          lignes.join('\n\n') +
          `\n\n*Achète avec \`/port acheter\`*`
        );
      }

      // ---- port acheter ----
      if (sub === 'acheter') {
        const choix  = interaction.options.getString('article');
        const item   = PORT_ITEMS.find(i => i.key === choix);
        if (!item) return interaction.reply({ content: '❌ Article introuvable.', ephemeral: true });

        const joueur = await getPlayer(userId);
        if (joueur.money < item.prix) {
          return interaction.reply({
            content: `❌ Tu n'as pas assez de Berries ! Il te faut **${formatBerries(item.prix)}** Berries (tu as **${formatBerries(joueur.money)}**).`,
            ephemeral: true
          });
        }

        await deductMoney(userId, item.prix);

        const effets = [];

        // Réparation bateau
        if (item.repair > 0) {
          const bateau   = await getBateau(userId);
          const newDurab = Math.min(bateau.durabilite_max, bateau.durabilite + item.repair);
          await updateDurabilite(userId, newDurab);
          effets.push(`🔧 Durabilité : **${bateau.durabilite}** → **${newDurab}** / ${bateau.durabilite_max}`);
        }

        // Soin PV
        if (item.heal > 0) {
          const joueurMaj = await getPlayer(userId);
          const newHP     = Math.min(joueurMaj.max_hp, joueurMaj.hp + item.heal);
          await updateHP(userId, newHP);
          effets.push(`❤️ PV : **${joueurMaj.hp}** → **${newHP}** / ${joueurMaj.max_hp}`);
        }

        return interaction.reply(
          `✅ **${item.name}** acheté pour **${formatBerries(item.prix)} Berries** !\n\n` +
          effets.join('\n') +
          `\n\n💰 Solde restant : **${formatBerries(joueur.money - item.prix)} Berries**`
        );
      }
    }

  } catch (err) {
    console.error('Erreur interaction :', err);
    const msg = { content: '❌ Une erreur est survenue. Réessaie dans un instant.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// ============================================================
// DÉMARRAGE
// ============================================================

(async () => {
  try {
    await initDB();
    console.log('✅ Base de données prête.');
    await client.login(token);
  } catch (err) {
    console.error('Erreur au démarrage :', err);
    process.exit(1);
  }
})();

client.once('clientReady', (c) => {
  console.log(`✅ Bot en ligne : ${c.user.tag}`);
});

client.login(process.env.TOKEN);
