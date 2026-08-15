/** FR-AUTH-01 / FR-AUTH-02: ตรวจสอบว่าเป็นอีเมล Lamduan เท่านั้น */
function isLamduanEmail(email) {
  const domain = process.env.ALLOWED_EMAIL_DOMAIN || "lamduan.mfu.ac.th";
  const re = new RegExp(`^[^\\s@]+@${domain.replace(".", "\\.")}$`, "i");
  return re.test(email || "");
}

module.exports = { isLamduanEmail };
