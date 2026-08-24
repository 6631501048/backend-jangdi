/**
 * FR-JOB-03 / FR-JOB-04: ตัวกรองเนื้อหาอัตโนมัติเบื้องต้น ก่อนส่งเข้าคิว Admin
 * NOTE: นี่คือ implementation แบบง่าย (keyword-based) สำหรับ demo/senior project
 * งานจริงควรต่อ moderation API หรือโมเดล NLP ที่แม่นยำกว่านี้
 */
const BANNED_KEYWORDS = [
  // คำหยาบ/ไม่เหมาะสมตัวอย่าง (เพิ่มเติมได้ตามต้องการ)
  "ควย", "เหี้ย", "สัส", "fuck", "shit",
  // เนื้อหาผิดกฎหมาย/ต้องห้ามตาม policy ของแพลตฟอร์ม
  "ยาเสพติด", "ใบขับขี่ปลอม", "บัตรปลอม", "พนันออนไลน์", "ปืน", "อาวุธ",
  "escort", "sex worker", "ขายบริการทางเพศ",
];

/**
 * ตรวจข้อความ (title + description) ว่าผ่านตัวกรองอัตโนมัติหรือไม่
 * @param {string} text
 * @returns {{ passed: boolean, reason: string|null }}
 */
function checkContent(text) {
  const normalized = (text || "").toLowerCase();
  const hit = BANNED_KEYWORDS.find((word) => normalized.includes(word.toLowerCase()));
  if (hit) {
    return { passed: false, reason: `เนื้อหามีคำที่ไม่ผ่านการตรวจสอบอัตโนมัติ ("${hit}")` };
  }
  if (normalized.trim().length < 10) {
    return { passed: false, reason: "รายละเอียดงานสั้นเกินไป กรุณาอธิบายเพิ่มเติม" };
  }
  return { passed: true, reason: null };
}

module.exports = { checkContent };