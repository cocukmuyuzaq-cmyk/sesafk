import config from './config.js';
import {
    Client as PanelClient, GatewayIntentBits, EmbedBuilder, ActivityType,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    InteractionType, Events, PermissionsBitField
} from 'discord.js';
import { Client as SelfClient } from 'discord.js-selfbot-v13';
import { joinVoiceChannel, VoiceConnectionStatus, entersState, getVoiceConnection } from '@discordjs/voice';
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

const activeSessions = new Map(); // userId -> { client, connection, config, muted, deafened, streaming }
const userPanels = new Map(); // userId -> { messageId, channelId }

// ─── Self bot başlat ───
async function startSelfBot(entry) {
    const { userId, token, guildId, channelId, muted = false, deafened = true } = entry;
    if (activeSessions.has(userId)) {
        await stopSelfBot(userId);
    }

    const client = new SelfClient({ checkUpdate: false });

    return new Promise((resolve) => {
        const timeout = setTimeout(() => { try { client.destroy(); } catch {} resolve({ ok: false, msg: 'Giriş zaman aşımı' }); }, 30000);

        client.once('ready', async () => {
            clearTimeout(timeout);
            logOk('SELF', `Giriş: ${client.user.tag}`);

            try { client.user.setPresence({ activities: [{ name: 'Sesde AFK', type: 'CUSTOM', state: 'Sesde AFK' }], status: 'online' }); } catch {}

            const guild = client.guilds.cache.get(guildId);
            if (!guild) { try { client.destroy(); } catch {} return resolve({ ok: false, msg: 'Sunucu bulunamadı' }); }
            const channel = guild.channels.cache.get(channelId);
            if (!channel) { try { client.destroy(); } catch {} return resolve({ ok: false, msg: 'Kanal bulunamadı' }); }

            try {
                const connection = joinVoiceChannel({
                    channelId: channel.id, guildId: guild.id,
                    adapterCreator: guild.voiceAdapterCreator,
                    selfMute: muted, selfDeaf: deafened,
                });
                await entersState(connection, VoiceConnectionStatus.Ready, 30000);
                logOk('SELF', `'${channel.name}' kanalına bağlandı`);

                activeSessions.set(userId, { client, connection, config: entry, muted, deafened, streaming: false });

                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    logWarn('SELF', `Bağlantı koptu, yeniden bağlanılıyor...`);
                    try {
                        await Promise.race([
                            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
                        ]);
                    } catch {
                        connection.destroy();
                        if (config.RECONNECT.enabled) setTimeout(() => reconnectSelf(entry), config.RECONNECT.delayMs);
                    }
                });
                resolve({ ok: true, msg: `'${channel.name}' kanalına bağlandı` });
            } catch (e) {
                try { client.destroy(); } catch {}
                resolve({ ok: false, msg: `Ses hatası: ${e.message}` });
            }
        });

        client.on('error', (e) => logErr('SELF', `Client hatası: ${e.message}`));
        client.login(token).catch((e) => { clearTimeout(timeout); resolve({ ok: false, msg: `Giriş hatası: ${e.message}` }); });
    });
}

async function reconnectSelf(entry) {
    const old = activeSessions.get(entry.userId);
    if (old) { try { old.connection?.destroy(); } catch {} try { old.client?.destroy(); } catch {} activeSessions.delete(entry.userId); }
    await startSelfBot(entry);
}

async function stopSelfBot(userId) {
    const entry = activeSessions.get(userId);
    if (!entry) return { ok: false, msg: 'Aktif oturum yok' };
    try { entry.connection?.destroy(); } catch {}
    try { entry.client?.destroy(); } catch {}
    activeSessions.delete(userId);
    return { ok: true, msg: 'Durduruldu' };
}

// ─── Panel embed ───
function buildPanelEmbed(db, userId) {
    const session = activeSessions.get(userId);
    const userEntry = db.users.find(u => u.userId === userId);
    const status = session ? '🟢 Bağlı' : '🔴 Bağlı değil';
    const accountCount = db.users.filter(u => u.userId === userId).length;

    return new EmbedBuilder()
        .setColor(session ? 0x00ff00 : 0xff8fc7)
        .setTitle('🎙️ SES AFK PANELİ')
        .setDescription(
            `**Durum:** ${status}\n` +
            `**Hesap Sayısı:** ${accountCount}\n` +
            (session ? `**Kanal:** <#${session.config.channelId}>\n**Mikrofon:** ${session.muted ? '🔇 Kapalı' : '🔊 Açık'}\n**Kulaklık:** ${session.deafened ? '🔇 Kapalı' : '🔊 Açık'}\n**Yayın:** ${session.streaming ? '🟢 Aktif' : '⚫ Kapalı'}\n` : '') +
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
        new ButtonBuilder().setCustomId('btn_stream_start').setLabel('Yayın Başlat').setEmoji('🔴').setStyle(ButtonStyle.Danger).setDisabled(!session || session.streaming),
        new ButtonBuilder().setCustomId('btn_stream_stop').setLabel('Durdur').setEmoji('⏹️').setStyle(ButtonStyle.Secondary).setDisabled(!session || !session.streaming),
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_leave').setLabel('Ses Kanalından Çıkar').setEmoji('🚪').setStyle(ButtonStyle.Danger).setDisabled(!session),
        new ButtonBuilder().setCustomId('btn_reconnect').setLabel('Yenile (Sıfırdan Bağla)').setEmoji('🔄').setStyle(ButtonStyle.Primary).setDisabled(!session),
        new ButtonBuilder().setCustomId('btn_move_channel').setLabel('Kanal Taşı').setEmoji('📢').setStyle(ButtonStyle.Secondary).setDisabled(!session),
        new ButtonBuilder().setCustomId('btn_rpc').setLabel('RPC Ayarla').setEmoji('🎮').setStyle(ButtonStyle.Secondary).setDisabled(!session),
    );

    return [row1, row2, row3];
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

// ─── Slash + buton + modal + select ───
main.on(Events.InteractionCreate, async (interaction) => {
    const userId = interaction.user.id;
    let db = loadDB();

    // Slash
    if (interaction.isChatInputCommand()) {
        if (['panel', 'tokencontrol'].includes(interaction.commandName)) {
            const embed = buildPanelEmbed(db, userId);
            const components = buildPanelComponents(db, userId);
            return interaction.reply({ embeds: [embed], components });
        }
    }

    // Buton
    if (interaction.isButton()) {
        const id = interaction.customId;

        if (id === 'btn_token_add') {
            const modal = new ModalBuilder().setCustomId('modal_token_add').setTitle('🤖 Token Ekle');
            const tokenInput = new TextInputBuilder().setCustomId('token').setLabel('Discord Kullanıcı Token').setStyle(TextInputStyle.Short).setPlaceholder('Token yapıştır...').setRequired(true).setMinLength(50);
            const guildInput = new TextInputBuilder().setCustomId('guild_id').setLabel('Sunucu ID').setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678').setRequired(true).setMinLength(17);
            const channelInput = new TextInputBuilder().setCustomId('channel_id').setLabel('Ses Kanalı ID').setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678').setRequired(true).setMinLength(17);
            modal.addComponents(new ActionRowBuilder().addComponents(tokenInput), new ActionRowBuilder().addComponents(guildInput), new ActionRowBuilder().addComponents(channelInput));
            return interaction.showModal(modal);
        }

        if (id === 'btn_token_delete') {
            const userAccounts = db.users.filter(u => u.userId === userId);
            if (userAccounts.length === 0) return interaction.reply({ content: '❌ Silinecek hesap yok.', ephemeral: true });
            const options = userAccounts.map((u, i) => ({ label: `Hesap ${i + 1}`, description: `Guild: ${u.guildId} | Kanal: ${u.channelId}`, value: u.id }));
            const select = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId('select_token_delete').setPlaceholder('Silinecek hesabı seç').addOptions(options)
            );
            return interaction.reply({ content: '🗑️ Silinecek hesabı seç:', components: [select], ephemeral: true });
        }

        if (id === 'btn_account_select') {
            const userAccounts = db.users.filter(u => u.userId === userId);
            if (userAccounts.length === 0) return interaction.reply({ content: '❌ Hesap yok.', ephemeral: true });
            const options = userAccounts.map((u, i) => ({ label: `Hesap ${i + 1}`, description: `Guild: ${u.guildId} | Kanal: ${u.channelId}`, value: u.id }));
            const select = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId('select_account_active').setPlaceholder('Aktif hesabı seç').addOptions(options)
            );
            return interaction.reply({ content: '👤 Aktif hesabı seç:', components: [select], ephemeral: true });
        }

        if (id === 'btn_refresh') {
            return refreshPanel(interaction, db, userId);
        }

        if (id === 'btn_mic_toggle') {
            const s = activeSessions.get(userId);
            if (!s) return interaction.reply({ content: '❌ Aktif oturum yok.', ephemeral: true });
            s.muted = !s.muted;
            try { await s.connection?.setSpeaking?.(!s.muted); } catch {}
            // discord.js-selfbot-v13 voice selfMute değiştirme
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

        if (id === 'btn_stream_start') {
            const s = activeSessions.get(userId);
            if (!s) return interaction.reply({ content: '❌ Aktif oturum yok.', ephemeral: true });
            s.streaming = true;
            return refreshPanel(interaction, db, userId);
        }

        if (id === 'btn_stream_stop') {
            const s = activeSessions.get(userId);
            if (!s) return interaction.reply({ content: '❌ Aktif oturum yok.', ephemeral: true });
            s.streaming = false;
            return refreshPanel(interaction, db, userId);
        }

        if (id === 'btn_leave') {
            await stopSelfBot(userId);
            return refreshPanel(interaction, db, userId);
        }

        if (id === 'btn_reconnect') {
            const entry = db.users.find(u => u.userId === userId);
            if (!entry) return interaction.reply({ content: '❌ Kayıtlı hesap yok.', ephemeral: true });
            await stopSelfBot(userId);
            await startSelfBot(entry);
            return refreshPanel(interaction, db, userId);
        }

        if (id === 'btn_move_channel') {
            const s = activeSessions.get(userId);
            if (!s) return interaction.reply({ content: '❌ Aktif oturum yok.', ephemeral: true });
            const modal = new ModalBuilder().setCustomId('modal_move_channel').setTitle('📢 Kanal Taşı');
            const chInput = new TextInputBuilder().setCustomId('new_channel').setLabel('Yeni Ses Kanalı ID').setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678').setRequired(true).setMinLength(17);
            modal.addComponents(new ActionRowBuilder().addComponents(chInput));
            return interaction.showModal(modal);
        }

        if (id === 'btn_rpc') {
            const modal = new ModalBuilder().setCustomId('modal_rpc').setTitle('🎮 RPC Ayarla');
            const nameInput = new TextInputBuilder().setCustomId('rpc_name').setLabel('Oynanıyor Metni').setStyle(TextInputStyle.Short).setPlaceholder('Örn: Minecraft').setRequired(true).setMaxLength(128);
            const urlInput = new TextInputBuilder().setCustomId('rpc_url').setLabel('Twitch URL (opsiyonel)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200);
            modal.addComponents(new ActionRowBuilder().addComponents(nameInput), new ActionRowBuilder().addComponents(urlInput));
            return interaction.showModal(modal);
        }
    }

    // Select menu
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

    // Modal submit
    if (interaction.type === InteractionType.ModalSubmit) {
        if (interaction.customId === 'modal_token_add') {
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

        if (interaction.customId === 'modal_move_channel') {
            const newCh = interaction.fields.getTextInputValue('new_channel').trim();
            if (!/^\d+$/.test(newCh)) return interaction.reply({ content: '❌ ID sayı olmalı.', ephemeral: true });
            const s = activeSessions.get(userId);
            if (!s) return interaction.reply({ content: '❌ Aktif oturum yok.', ephemeral: true });
            await interaction.deferReply({ ephemeral: true });
            const entry = { ...s.config, channelId: newCh };
            await stopSelfBot(userId);
            const result = await startSelfBot(entry);
            return interaction.editReply({ content: result.ok ? `✅ Kanal taşındı: ${result.msg}` : `❌ ${result.msg}` });
        }

        if (interaction.customId === 'modal_rpc') {
            const name = interaction.fields.getTextInputValue('rpc_name').trim();
            const url = interaction.fields.getTextInputValue('rpc_url').trim();
            const s = activeSessions.get(userId);
            if (!s) return interaction.reply({ content: '❌ Aktif oturum yok.', ephemeral: true });
            try {
                s.client.user.setPresence({
                    activities: [{ name, type: url ? 1 : 0, url: url || undefined }],
                    status: 'online'
                });
                return interaction.reply({ content: `✅ RPC ayarlandı: **${name}**`, ephemeral: true });
            } catch (e) {
                return interaction.reply({ content: `❌ RPC hatası: ${e.message}`, ephemeral: true });
            }
        }
    }
});

main.on('error', (e) => logErr('MAIN', e.message));

process.on('SIGINT', async () => {
    for (const [, s] of activeSessions) {
        try { s.connection?.destroy(); } catch {}
        try { s.client?.destroy(); } catch {}
    }
    main.destroy();
    process.exit(0);
});

main.login(config.MAIN_BOT_TOKEN);
