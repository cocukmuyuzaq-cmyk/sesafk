import config from './config.js';
import {
    Client, GatewayIntentBits, EmbedBuilder, ActivityType,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    InteractionType, Events
} from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import 'libsodium-wrappers';
import { saveEncrypted, loadEncrypted } from './crypto.js';

const C = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
function ts() { return new Date().toLocaleTimeString('tr-TR', { hour12: false }); }
function log(tag, msg, color = C.cyan) {
    console.log(`${C.gray}[${ts()}]${C.reset} ${color}[${tag}]${C.reset} ${msg}`);
}
const logOk   = (t, m) => log(t, `✅ ${m}`, C.green);
const logWarn = (t, m) => log(t, `⚠️  ${m}`, C.yellow);
const logErr  = (t, m) => log(t, `❌ ${m}`, C.red);
const logInfo = (t, m) => log(t, `ℹ️  ${m}`, C.blue);

if (!config.MAIN_BOT_TOKEN) { console.error('❌ MAIN_BOT_TOKEN yok'); process.exit(1); }
if (!config.AES_KEY || config.AES_KEY.length < 16) { console.error('❌ AES_KEY yok'); process.exit(1); }

function loadDB() { return loadEncrypted(config.DB_FILE, config.AES_KEY, { afk: [] }); }
function saveDB(db) { saveEncrypted(config.DB_FILE, db, config.AES_KEY); }

const activeBots = new Map();

async function startAFKBot(entry) {
    const { id, token, guildId, channelId } = entry;
    if (activeBots.has(id)) return { ok: false, msg: 'Bu bot zaten çalışıyor' };

    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            try { client.destroy(); } catch {}
            resolve({ ok: false, msg: 'Giriş zaman aşımı' });
        }, 30000);

        client.once('ready', async () => {
            clearTimeout(timeout);
            logOk('AFK', `Bot ${id} giriş: ${client.user.tag}`);

            try { await client.user.setUsername(config.BOT_NAME); } catch {}
            try {
                client.user.setPresence({
                    activities: [{ name: 'Sesde AFK', type: ActivityType.Custom, state: 'Sesde AFK' }],
                    status: 'online',
                });
            } catch {}

            const guild = client.guilds.cache.get(guildId);
            if (!guild) { try { client.destroy(); } catch {} return resolve({ ok: false, msg: 'Sunucu bulunamadı' }); }
            const channel = guild.channels.cache.get(channelId);
            if (!channel) { try { client.destroy(); } catch {} return resolve({ ok: false, msg: 'Kanal bulunamadı' }); }

            try {
                const connection = joinVoiceChannel({
                    channelId: channel.id, guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                    selfMute: false, selfDeaf: true,
                });
                await entersState(connection, VoiceConnectionStatus.Ready, 30000);
                logOk('AFK', `Bot ${id} '${channel.name}' kanalına bağlandı`);
                activeBots.set(id, { client, connection, info: entry });

                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    try {
                        await Promise.race([
                            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                        ]);
                    } catch {
                        connection.destroy();
                        if (config.RECONNECT.enabled) setTimeout(() => reconnectBot(entry), config.RECONNECT.delayMs);
                    }
                });
                resolve({ ok: true, msg: `'${channel.name}' kanalına bağlandı` });
            } catch (e) {
                try { client.destroy(); } catch {}
                resolve({ ok: false, msg: `Ses hatası: ${e.message}` });
            }
        });

        client.on('error', (e) => logErr('AFK', `Bot ${id} client hatası: ${e.message}`));
        client.login(token).catch((e) => {
            clearTimeout(timeout);
            resolve({ ok: false, msg: `Giriş hatası: ${e.message}` });
        });
    });
}

async function reconnectBot(entry) {
    const old = activeBots.get(entry.id);
    if (old) {
        try { old.connection?.destroy(); } catch {}
        try { old.client?.destroy(); } catch {}
        activeBots.delete(entry.id);
    }
    await startAFKBot(entry);
}

async function stopAFKBot(id) {
    const entry = activeBots.get(id);
    if (!entry) return { ok: false, msg: 'Bu bot çalışmıyor' };
    try { entry.connection?.destroy(); } catch {}
    try { entry.client?.destroy(); } catch {}
    activeBots.delete(id);
    return { ok: true, msg: 'Durduruldu' };
}

function makeEmbed(title, description, color = 0xff8fc7) {
    return new EmbedBuilder()
        .setColor(color).setTitle(title).setDescription(description)
        .setThumbnail(config.LOGO_URL)
        .setFooter({ text: `${config.BOT_NAME} • AES-256-GCM`, iconURL: config.LOGO_URL })
        .setTimestamp();
}

const main = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

main.once(Events.ClientReady, async () => {
    console.log('');
    logOk('MAIN', `Hazır: ${main.user.tag}`);
    try { await main.user.setUsername(config.BOT_NAME); } catch {}
    try {
        main.user.setPresence({
            activities: [{ name: 'Sesde AFK', type: ActivityType.Custom, state: 'Sesde AFK' }],
            status: 'online',
        });
    } catch {}
    console.log('');

    // Slash komutları kaydet (global)
    const commands = [
        { name: 'panel', description: 'SES AFK panelini aç' },
        { name: 'afk-liste', description: 'Kayıtlı AFK botlarını listele' },
        { name: 'afk-durum', description: 'Aktif botların durumunu göster' },
    ];
    try {
        await main.application.commands.set(commands);
        logOk('MAIN', `${commands.length} slash komut kaydedildi`);
    } catch (e) {
        logErr('MAIN', `Slash komut kaydedilemedi: ${e.message}`);
    }

    // Render için HTTP
    import('http').then(({ createServer }) => {
        createServer((req, res) => res.end(`${config.BOT_NAME} aktif`)).listen(process.env.PORT || 3000);
    });
});

// ─── Mesaj komutları (prefix !) ───
main.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.content.startsWith('!')) return;
    const args = msg.content.slice(1).trim().split(/\s+/);
    const cmd = args.shift().toLowerCase();

    if (cmd === 'panel') {
        const embed = makeEmbed('🎙️ SES AFK PANELİ',
            'Aşağıdaki **"Sesde AFK Ol"** butonuna bas, formu doldur.\n\n' +
            '**Gerekli bilgiler:**\n' +
            '• **Bot Token** — Developer Portal\'dan aldığın token\n' +
            '• **Sunucu ID** — Sunucuya sağ tık → ID Kopyala\n' +
            '• **Ses Kanalı ID** — Kanala sağ tık → ID Kopyala\n\n' +
            '> ⚠️ Token AES-256-GCM ile şifrelenip saklanır.'
        );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('open_afk_modal')
                .setLabel('Sesde AFK Ol')
                .setEmoji('🎙️')
                .setStyle(ButtonStyle.Success),
        );
        return msg.reply({ embeds: [embed], components: [row] });
    }

    if (cmd === 'afk-liste') {
        const db = loadDB();
        if (db.afk.length === 0) return msg.reply({ embeds: [makeEmbed('📋 AFK Botlar', 'Kayıt yok.', 0xffd93d)] });
        const lines = db.afk.map((e) => `${activeBots.has(e.id) ? '🟢' : '🔴'} \`${e.id}\` — Guild: \`${e.guildId}\` — Kanal: \`${e.channelId}\``);
        return msg.reply({ embeds: [makeEmbed('📋 AFK Botlar', lines.join('\n'))] });
    }

    if (cmd === 'afk-durum') {
        if (activeBots.size === 0) return msg.reply({ embeds: [makeEmbed('📊 Durum', 'Aktif bot yok.', 0xffd93d)] });
        const lines = [];
        for (const [id, b] of activeBots) lines.push(`🟢 \`${id}\` — ${b.client.user?.tag || '?'} — **${b.connection?.state?.status || 'unknown'}**`);
        return msg.reply({ embeds: [makeEmbed('📊 Aktif Botlar', lines.join('\n'))] });
    }

    if (cmd === 'afk-sil') {
        const id = args[0];
        if (!id) return msg.reply({ embeds: [makeEmbed('❌ Hata', 'Kullanım: `!afk-sil <id>`', 0xff0000)] });
        await stopAFKBot(id);
        const db = loadDB();
        const before = db.afk.length;
        db.afk = db.afk.filter(e => e.id !== id);
        saveDB(db);
        if (db.afk.length === before) return msg.reply({ embeds: [makeEmbed('⚠️ Uyarı', `\`${id}\` bulunamadı.`, 0xffd93d)] });
        return msg.reply({ embeds: [makeEmbed('✅ Silindi', `\`${id}\` silindi.`, 0x00ff00)] });
    }
});

// ─── Slash komutlar ───
main.on(Events.InteractionCreate, async (interaction) => {
    // Slash komut
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'panel') {
            const embed = makeEmbed('🎙️ SES AFK PANELİ',
                'Aşağıdaki **"Sesde AFK Ol"** butonuna bas, formu doldur.\n\n' +
                '**Gerekli bilgiler:**\n' +
                '• **Bot Token** — Developer Portal\'dan aldığın token\n' +
                '• **Sunucu ID** — Sunucuya sağ tık → ID Kopyala\n' +
                '• **Ses Kanalı ID** — Kanala sağ tık → ID Kopyala\n\n' +
                '> ⚠️ Token AES-256-GCM ile şifrelenip saklanır.'
            );
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('open_afk_modal')
                    .setLabel('Sesde AFK Ol')
                    .setEmoji('🎙️')
                    .setStyle(ButtonStyle.Success),
            );
            return interaction.reply({ embeds: [embed], components: [row] });
        }

        if (interaction.commandName === 'afk-liste') {
            const db = loadDB();
            if (db.afk.length === 0) return interaction.reply({ embeds: [makeEmbed('📋 AFK Botlar', 'Kayıt yok.', 0xffd93d)] });
            const lines = db.afk.map((e) => `${activeBots.has(e.id) ? '🟢' : '🔴'} \`${e.id}\` — Guild: \`${e.guildId}\` — Kanal: \`${e.channelId}\``);
            return interaction.reply({ embeds: [makeEmbed('📋 AFK Botlar', lines.join('\n'))] });
        }

        if (interaction.commandName === 'afk-durum') {
            if (activeBots.size === 0) return interaction.reply({ embeds: [makeEmbed('📊 Durum', 'Aktif bot yok.', 0xffd93d)] });
            const lines = [];
            for (const [id, b] of activeBots) lines.push(`🟢 \`${id}\` — ${b.client.user?.tag || '?'} — **${b.connection?.state?.status || 'unknown'}**`);
            return interaction.reply({ embeds: [makeEmbed('📊 Aktif Botlar', lines.join('\n'))] });
        }
    }

    // Buton
    if (interaction.isButton() && interaction.customId === 'open_afk_modal') {
        const modal = new ModalBuilder()
            .setCustomId('afk_modal_submit')
            .setTitle('🎙️ Sesde AFK Ol');

        const tokenInput = new TextInputBuilder()
            .setCustomId('token')
            .setLabel('Bot Token')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('MTU2...')
            .setRequired(true)
            .setMinLength(50);

        const guildInput = new TextInputBuilder()
            .setCustomId('guild_id')
            .setLabel('Sunucu ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('123456789012345678')
            .setRequired(true)
            .setMinLength(17);

        const channelInput = new TextInputBuilder()
            .setCustomId('channel_id')
            .setLabel('Ses Kanalı ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('123456789012345678')
            .setRequired(true)
            .setMinLength(17);

        modal.addComponents(
            new ActionRowBuilder().addComponents(tokenInput),
            new ActionRowBuilder().addComponents(guildInput),
            new ActionRowBuilder().addComponents(channelInput),
        );

        return interaction.showModal(modal);
    }

    // Modal submit
    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'afk_modal_submit') {
        const token = interaction.fields.getTextInputValue('token').trim();
        const guildId = interaction.fields.getTextInputValue('guild_id').trim();
        const channelId = interaction.fields.getTextInputValue('channel_id').trim();

        if (!/^\d+$/.test(guildId) || !/^\d+$/.test(channelId)) {
            return interaction.reply({ embeds: [makeEmbed('❌ Hata', 'Sunucu ID ve Kanal ID sayı olmalı.', 0xff0000)], ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const db = loadDB();
        const id = 'afk_' + Date.now();
        const result = await startAFKBot({ id, token, guildId, channelId });

        if (result.ok) {
            db.afk.push({ id, token, guildId, channelId, createdAt: Date.now() });
            saveDB(db);
            return interaction.editReply({
                embeds: [makeEmbed('✅ Başarılı',
                    `Bot \`${id}\` oluşturuldu.\n${result.msg}\n\n**Token AES-256-GCM ile şifrelendi.**`, 0x00ff00)]
            });
        } else {
            return interaction.editReply({
                embeds: [makeEmbed('❌ Başarısız', result.msg, 0xff0000)]
            });
        }
    }
});

main.on('error', (e) => logErr('MAIN', e.message));

process.on('SIGINT', async () => {
    logWarn('SISTEM', 'Kapatılıyor...');
    for (const [, b] of activeBots) {
        try { b.connection?.destroy(); } catch {}
        try { b.client?.destroy(); } catch {}
    }
    main.destroy();
    process.exit(0);
});

main.login(config.MAIN_BOT_TOKEN);