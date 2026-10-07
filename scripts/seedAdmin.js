/**
 * สคริปต์สร้าง/อัปเดตบัญชี Admin 1 บัญชี (idempotent — รันซ้ำได้ ไม่สร้างซ้ำ)
 * วิธีใช้:  node scripts/seedAdmin.js
 *
 * ค่าเริ่มต้น: admin@lamduan.mfu.ac.th / admin1234
 * เปลี่ยนได้โดยไม่ต้องแก้โค้ด เช่น  ADMIN_PASSWORD=รหัสใหม่ node scripts/seedAdmin.js
 *
 * หมายเหตุ: รหัสผ่านค่าเริ่มต้นเดาง่าย ใช้ตอน dev/ทดสอบเท่านั้น
 *           ก่อน deploy จริงให้รันด้วย ADMIN_PASSWORD ที่คาดเดายากแทน
 */
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { User } = require("../src/models");

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@lamduan.mfu.ac.th").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("ไม่พบ MONGO_URI ใน .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10);

  // หมายเหตุ: ไม่ใช้ findOneAndUpdate + upsert + setDefaultsOnInsert เพราะ Mongoose จะเติม
  // lastKnownLocation: { coordinates: [] } ให้อัตโนมัติ แล้ว 2dsphere index พัง (Can't extract geo keys)
  // ใช้ create/save แบบเดียวกับ register แทน
  let user = await User.findOne({ email: ADMIN_EMAIL });

  if (!user) {
    user = await User.create({
      email: ADMIN_EMAIL,
      studentId: ADMIN_EMAIL.split("@")[0],
      fullName: "Admin",
      password: hashed,
      isAdmin: true,
      isEmailVerified: true, // ไม่ต้องรอลิงก์ยืนยันอีเมล
      isProfileComplete: true, // ไม่ให้ถูกเด้งไปหน้า register หลังล็อกอิน
    });
    console.log("สร้างบัญชีใหม่แล้ว");
  } else {
    // บัญชีมีอยู่แล้ว: ตั้งทับเฉพาะ field ที่จำเป็น (รวมรหัสผ่าน) ไม่แตะข้อมูลอื่น
    user.password = hashed;
    user.isAdmin = true;
    user.isEmailVerified = true;
    user.isProfileComplete = true;
    user.accountStatus = "active";
    await user.save();
    console.log("อัปเดตบัญชีเดิมแล้ว");
  }

  console.log(`พร้อมใช้งาน: ${user.email} (isAdmin=${user.isAdmin})`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("สร้างบัญชี Admin ไม่สำเร็จ:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});