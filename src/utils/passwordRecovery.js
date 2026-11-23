const crypto = require('crypto');
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validPassword = value => typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 72;
const hashResetToken = token => crypto.createHash('sha256').update(token).digest('hex');
module.exports = { normalizeEmail, validPassword, hashResetToken };
