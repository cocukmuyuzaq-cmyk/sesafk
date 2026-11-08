import config from './config.js';
import {
    Client as PanelClient, GatewayIntentBits, EmbedBuilder, ActivityType,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    InteractionType, Events
} from 'discord.js';
import { Client as SelfClient } from 'discord.js-selfbot-v13';
import 'libsodium-wrappers';
import { saveEncrypted, loadEncrypted } from './crypto.js';

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m' };
function ts() { return new Date().toLocaleTimeString('tr-TR', { hour12: false }); }
function log(tag, msg, color = C.cyan) { console.log(`${C.gray}[${ts()}]${C.reset} ${color}[${tag}]${C.reset} ${msg}`); }
const logOk = (t, m) => log(t, `✅ ${m}`, C.green);
const logWarn = (t, m) => log(t, `⚠️  ${m}`, C.yellow);
const logErr = (t, m) => log(t, `❌ ${m}`, C.red);

if (!config.MAIN_BOT_TOKEN) { console.error('❌ MAIN_BOT_TOKEN yok'); process.exit(1); }
if (!config.AES_KEY || config.AES_KEY.length < 16) { console.error('❌ AES_KEY yok'); process.exit(1); }

function loadDB() { return loadEncrypted(config.DB_FILE, config.AES_KEY, { users: [] }); }
function saveDB(db) { saveEncrypted(config.DB_FILE, db, config.AES_KEY); }

const activeSessions = new Map();

// ─── Self bot başlat (kütüphanenin kendi voice manager'ı ile) ───
async function startSelfBot(entry) {
    const { id, userId, token, guildId, channelId, muted = false, deafened = true } = entry;

    if (activeSessions.has(userId)) {
        await stopSelfBot(userId);
    }

    const client = new SelfClient({ checkUpdate: false });

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            try { client.destroy(); } catch {}
            resolve({ ok: false, msg: 'Giriş zaman aşımı (30s)' });
        }, 30000);

        client.once('ready', async () => {
            clearTimeout(timeout);
            logOk('SELF', `Giriş: ${client.user.tag}`);

            try {
                client.user.setPresence({
                    activities: [{ name: 'Sesde AFK', type: 'CUSTOM', state: 'Sesde AFK' }],
                    status: 'online'
                });
            } catch {}

            const guild = client.guilds.cache.get(guildId);
            if (!guild) { try { client.destroy(); } catch {} return resolve({ ok: false, msg: 'Sunucu bulunamadı' }); }

            const channel = guild.channels.cache.get(channelId);
            if (!channel) { try { client.destroy(); } catch {} return resolve({ ok: false, msg: 'Kanal bulunamadı' }); }

            // Kanal dolu mu kontrolü (abort hatasının sık nedeni)
            if (channel.userLimit > 0 && channel.members.size >= channel.userLimit) {
                try { client.destroy(); } catch {}
                return resolve({ ok: false, msg: `Kanal dolu (limit: ${channel.userLimit})` });
            }

            try {
                // Kütüphanenin kendi joinChannel metodu
                const connection = await client.voice.joinChannel(channel, {
                    selfMute: muted,
                    selfDeaf: deafened,
                    timeout: 60000, // 60 saniye timeout
                });

                logOk('SELF', `'${channel.name}' kanalına bağlandı`);

                activeSessions.set(userId, { client, connection, config: entry, muted, deafened, streaming: false });

                // Bağlantı koptuğunda yeniden bağlan
                connection.on('disconnect', () => {
                    logWarn('SELF', `Bağlantı koptu, yeniden bağlanılıyor...`);
                    if (config.RECONNECT.enabled) {
                        setTimeout(() => reconnectSelf(entry), config.RECONNECT.delayMs);
                    }
                });

                resolve({ ok: true, msg: `'${channel.name}' kanalına bağlandı` });
            } catch (e) {
                logErr('SELF', `Ses hatası: ${e.message}`);
                try { client.destroy(); } catch {}
                resolve({ ok: false, msg: `Ses hatası: ${e.message}` });
            }
        });

        client.on('error', (e) => logErr('SELF', `Client hatası: ${e.message}`));

        client.login(token).catch((e) => {
            clearTimeout(timeout);
            resolve({ ok: false, msg: `Giriş hatası: ${e.message}` });
        });
    });
}

async function reconnectSelf(entry) {
    const old = activeSessions.get(entry.userId);
    if (old) {
        try { old.connection?.disconnect(); } catch {}
        try { old.client?.destroy(); } catch {}
        activeSessions.delete(entry.userId);
    }
    await startSelfBot(entry);
}

async function stopSelfBot(userId) {
    const entry = activeSessions.get(userId);
    if (!entry) return { ok: false, msg: 'Aktif oturum yok' };
    try { entry.connection?.disconnect(); } catch {}
    try { entry.client?.destroy(); } catch {}
    activeSessions.delete(userId);
    return { ok: true, msg: 'Durduruldu' };
}

// ─── Panel embed (aynı) ───
function buildPanelEmbed(db, userId) {
    const session = activeSessions.get(userId);
    const accountCount = db.users.filter(u => u.userId === userId).length;
    const status = session ? '🟢 Bağlı' : '🔴 Bağlı değil';

    return new EmbedBuilder()
        .setColor(session ? 0x00ff00 : 0xff8fc7)
        .setTitle('🎙️ SES AFK PANELİ')
        .setDescription(
            `**Durum:** ${status}\n` +
            `**Hesap Sayısı:** ${accountCount}\n` +
            (session ? `**Kanal:** <#${session.config.channelId}>\n**Mikrofon:** ${session.muted ? '🔇 Kapalı' : '🔊 Açık'}\n**Kulaklık:** ${session.deafened ? '🔇 Kapalı' : '🔊 Açık'}\n` : '') +
            `\n**Token:** AES-256-GCM ile şifreli`
        )
        .setThumbnail(config.LOGO_URL)
        .setFooter({ text: 'SES AFK • 7/24 Ses Kanalı', iconURL: config.LOGO_URL })
        .setTimestamp();
}

function buildPanelComponents(db, userId) {
    const session = activeSessions.get(userId);
    const hasAccounts = db.users.some(u => u.userId === userId);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_token_add').setLabel('Token Ekle').setEmoji('🤖').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_token_delete').setLabel('Token Sil').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!hasAccounts),
        new ButtonBuilder().setCustomId('btn_account_select').setLabel('Hesap Seç').setEmoji('👤').setStyle(ButtonStyle.Secondary).setDisabled(!hasAccounts),
        new ButtonBuilder().setCustomId('btn_refresh').setLabel('Yenile').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_mic_toggle').setLabel(session?.muted ? 'Mik Aç' : 'Mik Kapat').setEmoji(session?.muted ? '🔊' : '🔇').setStyle(ButtonStyle.Secondary).setDisabled(!session),
        new ButtonBuilder().setCustomId('btn_deaf_toggle').setLabel(session?.deafened ? 'Kulak Aç' : 'Kulak Kapat').setEmoji(session?.deafened ? '🔊' : '🔇').setStyle(ButtonStyle.Secondary).setDisabled(!session),
        new ButtonBuilder().setCustomId('btn_leave').setLabel('Ses Kanalından Çıkar').setEmoji('🚪').setStyle(ButtonStyle.Danger).setDisabled(!session),
        new ButtonBuilder().setCustomId('btn_reconnect').setLabel('Yenile (Sıfırdan)').setEmoji('🔄').setStyle(ButtonStyle.Primary).setDisabled(!session),
    );

    return [row1, row2];
}

async function refreshPanel(interaction, db, userId) {
    const embed = buildPanelEmbed(db, userId);
    const components = buildPanelComponents(db, userId);
    if (interaction.replied || interaction.deferred) {
        return interaction.editReply({ embeds: [embed], components });
    }
    return interaction.update({ embeds: [embed], components });
}

// ─── Panel botu ───
const main = new PanelClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

main.once(Events.ClientReady, async () => {
    console.log('');
    logOk('MAIN', `Panel hazır: ${main.user.tag}`);
    try { await main.user.setUsername(config.BOT_NAME); } catch {}
    try { main.user.setPresence({ activities: [{ name: 'Sesde AFK', type: ActivityType.Custom, state: 'Sesde AFK' }], status: 'online' }); } catch {}
    console.log('');

    const commands = [
        { name: 'panel', description: 'SES AFK panelini aç' },
        { name: 'tokencontrol', description: 'Token kontrol panelini aç' },
    ];
    try { await main.application.commands.set(commands); logOk('MAIN', `${commands.length} slash komut kaydedildi`); } catch (e) { logErr('MAIN', `Slash kayıt hatası: ${e.message}`); }

    import('http').then(({ createServer }) => {
        createServer((req, res) => res.end(`${config.BOT_NAME} aktif`)).listen(process.env.PORT || 3000);
    });
});

// ─── Etkileşimler ───
main.on(Events.InteractionCreate, async (interaction) => {
    const userId = interaction.user.id;
    let db = loadDB();

    if (interaction.isChatInputCommand()) {
        if (['panel', 'tokencontrol'].includes(interaction.commandName)) {
            return interaction.reply({ embeds: [buildPanelEmbed(db, userId)], components: buildPanelComponents(db, userId) });
        }
    }

    if (interaction.isButton()) {
        const id = interaction.customId;

        if (id === 'btn_token_add') {
            const modal = new ModalBuilder().setCustomId('modal_token_add').setTitle('🤖 Token Ekle');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('token').setLabel('Discord Kullanıcı Token').setStyle(TextInputStyle.Short).setPlaceholder('Token yapıştır...').setRequired(true).setMinLength(50)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('guild_id').setLabel('Sunucu ID').setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678').setRequired(true).setMinLength(17)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel_id').setLabel('Ses Kanalı ID').setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678').setRequired(true).setMinLength(17)),
            );
            return interaction.showModal(modal);
        }

        if (id === 'btn_token_delete' || id === 'btn_account_select') {
            const userAccounts = db.users.filter(u => u.userId === userId);
            if (userAccounts.length === 0) return interaction.reply({ content: '❌ Hesap yok.', ephemeral: true });
            const options = userAccounts.map((u, i) => ({ label: `Hesap ${i + 1}`, description: `Guild: ${u.guildId} | Kanal: ${u.channelId}`, value: u.id }));
            const select = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId(id === 'btn_token_delete' ? 'select_token_delete' : 'select_account_active').setPlaceholder('Hesap seç').addOptions(options)
            );
            return interaction.reply({ content: 'Hesap seç:', components: [select], ephemeral: true });
        }

        if (id === 'btn_refresh') return refreshPanel(interaction, db, userId);
        if (id === 'btn_leave') { await stopSelfBot(userId); return refreshPanel(interaction, db, userId); }

        if (id === 'btn_reconnect') {
            const entry = db.users.find(u => u.userId === userId);
            if (!entry) return interaction.reply({ content: '❌ Kayıtlı hesap yok.', ephemeral: true });
            await stopSelfBot(userId);
            await startSelfBot(entry);
            return refreshPanel(interaction, db, userId);
        }

        if (id === 'btn_mic_toggle') {
            const s = activeSessions.get(userId);
            if (!s) return interaction.reply({ content: '❌ Aktif oturum yok.', ephemeral: true });
            s.muted = !s.muted;
            try { await s.connection?.setSpeaking?.(!s.muted); } catch {}
            try { await s.client.voice?.setSelfMute?.(s.muted); } catch {}
            return refreshPanel(interaction, db, userId);
        }

        if (id === 'btn_deaf_toggle') {
            const s = activeSessions.get(userId);
            if (!s) return interaction.reply({ content: '❌ Aktif oturum yok.', ephemeral: true });
            s.deafened = !s.deafened;
            try { await s.client.voice?.setSelfDeaf?.(s.deafened); } catch {}
            return refreshPanel(interaction, db, userId);
        }
    }

    if (interaction.isStringSelectMenu()) {
        const val = interaction.values[0];
        if (interaction.customId === 'select_token_delete') {
            db.users = db.users.filter(u => u.id !== val);
            saveDB(db);
            await stopSelfBot(userId);
            return interaction.update({ content: '✅ Hesap silindi.', components: [] });
        }
        if (interaction.customId === 'select_account_active') {
            const entry = db.users.find(u => u.id === val);
            if (!entry) return interaction.update({ content: '❌ Hesap bulunamadı.', components: [] });
            await stopSelfBot(userId);
            await startSelfBot(entry);
            return interaction.update({ content: `✅ Aktif hesap: \`${entry.id}\``, components: [] });
        }
    }

    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === 'modal_token_add') {
        const token = interaction.fields.getTextInputValue('token').trim();
        const guildId = interaction.fields.getTextInputValue('guild_id').trim();
        const channelId = interaction.fields.getTextInputValue('channel_id').trim();
        if (!/^\d+$/.test(guildId) || !/^\d+$/.test(channelId)) return interaction.reply({ content: '❌ ID sayı olmalı.', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });
        const id = 'acc_' + Date.now();
        const entry = { id, userId, token, guildId, channelId, muted: false, deafened: true, createdAt: Date.now() };
        const result = await startSelfBot(entry);

        if (result.ok) {
            db.users.push(entry);
            saveDB(db);
            return interaction.editReply({ content: `✅ Hesap eklendi: ${result.msg}\n**Token AES-256-GCM ile şifrelendi.**` });
        }
        return interaction.editReply({ content: `❌ Başarısız: ${result.msg}` });
    }
});

main.on('error', (e) => logErr('MAIN', e.message));

process.on('SIGINT', async () => {
    for (const [, s] of activeSessions) {
        try { s.connection?.disconnect(); } catch {}
        try { s.client?.destroy(); } catch {}
    }
    main.destroy();
    process.exit(0);
});

main.login(config.MAIN_BOT_TOKEN);
