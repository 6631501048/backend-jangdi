/** FR-AUTH-01 / FR-AUTH-02: ตรวจสอบว่าเป็นอีเมล Lamduan เท่านั้น */
function isLamduanEmail(email) {
  const domain = process.env.ALLOWED_EMAIL_DOMAIN || "lamduan.mfu.ac.th";
  if (typeof email !== 'string') return false;
  const parts = email.split('@');
  return parts.length === 2 && /^[^\s@]+$/.test(parts[0]) && parts[1].toLowerCase() === domain.toLowerCase();
}

module.exports = { isLamduanEmail };
