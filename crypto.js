import crypto from 'crypto';
import fs from 'fs';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(keyStr) {
    if (/^[0-9a-fA-F]{64}$/.test(keyStr)) return Buffer.from(keyStr, 'hex');
    return crypto.createHash('sha256').update(keyStr, 'utf8').digest();
}

export function encrypt(plaintext, keyStr) {
    const key = getKey(keyStr);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(b64, keyStr) {
    const key = getKey(keyStr);
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function saveEncrypted(file, dataObj, keyStr) {
    fs.writeFileSync(file, encrypt(JSON.stringify(dataObj), keyStr), 'utf8');
}

export function loadEncrypted(file, keyStr, fallback = { users: [] }) {
    if (!fs.existsSync(file)) return fallback;
    try {
        return JSON.parse(decrypt(fs.readFileSync(file, 'utf8'), keyStr));
    } catch (e) {
        console.error('[-] Şifre çözme hatası:', e.message);
        return fallback;
    }
}
