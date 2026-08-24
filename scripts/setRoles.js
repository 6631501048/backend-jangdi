/**
 * สคริปต์ตั้งค่า isAdmin / isTester ให้บัญชีที่มีอยู่แล้วใน DB โดยอ้างอิงจาก studentId
 * วิธีใช้: node scripts/setRoles.js
 *
 * แก้ไขรายชื่อ studentId ในลิสต์ ADMIN_STUDENT_IDS / TESTER_STUDENT_IDS ด้านล่างได้ตามต้องการ
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { User } = require("../src/models");

const ADMIN_STUDENT_IDS = ["6631501025", "6631501002", "6631501048"];
const TESTER_STUDENT_IDS = ["6631500001"];

async function setFlag(studentIds, field, label) {
  for (const studentId of studentIds) {
    const user = await User.findOneAndUpdate(
      { studentId },
      { [field]: true },
      { new: true }
    );

    if (!user) {
      console.error(`✗ ไม่พบ user studentId=${studentId}`);
    } else {
      console.log(`✓ ตั้งให้ ${user.email} (studentId=${studentId}) เป็น ${label} แล้ว`);
    }
  }
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("ไม่พบ MONGO_URI ใน .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  await setFlag(ADMIN_STUDENT_IDS, "isAdmin", "Admin");
  await setFlag(TESTER_STUDENT_IDS, "isTester", "Tester");

  await mongoose.disconnect();
  console.log("เสร็จสิ้น");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});