export default {
    MAIN_BOT_TOKEN: process.env.MAIN_BOT_TOKEN || '',
    AES_KEY: process.env.AES_KEY || '',
    BOT_NAME: 'SES AFK',
    LOGO_URL: 'https://media.discordapp.net/attachments/1566040841150140477/1568589689072517201/image0.jpg?ex=6af1073c&is=6aefb5bc&hm=4692bb10fee71279921452cb9a8610182cd0231d2d71c0a0f330ed97c8421cd5&=&format=webp',
    DB_FILE: process.env.DB_FILE || './afk-db.enc',
    RECONNECT: { enabled: true, maxRetries: 5, delayMs: 5000 },
};