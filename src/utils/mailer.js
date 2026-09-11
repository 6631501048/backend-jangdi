const nodemailer = require("nodemailer");

/**
 * FR-NOTIF-01: อีเมลเป็นช่องทางแจ้งเตือนหลักตาม Objective 1.2.2 ของ proposal
 * ใช้ SMTP ธรรมดา — ตั้งค่าผ่าน .env (EMAIL_HOST/EMAIL_PORT/EMAIL_USER/EMAIL_PASS/EMAIL_FROM)
 * ถ้ายังไม่ตั้งค่า SMTP จะไม่ throw error แต่ log เตือนแล้วข้ามการส่งจริง
 * (กันไม่ให้ dev/test ที่ยังไม่มี SMTP credentials ใช้งาน backend ไม่ได้เลย)
 */
let transporter = null;
let warnedOnce = false;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: Number(process.env.EMAIL_PORT) === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  return transporter;
}

/**
 * @param {{ to: string, subject: string, html: string }} params
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function sendEmail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    if (!warnedOnce) {
      console.warn(
        "[mailer] ยังไม่ได้ตั้งค่า SMTP (EMAIL_HOST/EMAIL_USER/EMAIL_PASS ใน .env) — จะข้ามการส่งอีเมลจริงไปก่อน แต่ระบบยังทำงานต่อได้ปกติ"
      );
      warnedOnce = true;
    }
    return { sent: false, reason: "SMTP not configured" };
  }

  try {
    await t.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to,
      subject,
      html,
    });
    return { sent: true };
  } catch (err) {
    console.error(`[mailer] ส่งอีเมลถึง ${to} ล้มเหลว: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendEmail };