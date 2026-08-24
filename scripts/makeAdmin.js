/**
 * สคริปต์ช่วยตั้งให้ user คนหนึ่งเป็น Admin (ใช้ตอน dev/ทดสอบเท่านั้น)
 * วิธีใช้: node scripts/makeAdmin.js your_email@lamduan.mfu.ac.th
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { User } = require("../src/models");

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("ใช้งาน: node scripts/makeAdmin.js your_email@lamduan.mfu.ac.th");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const user = await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    { isAdmin: true },
    { new: true }
  );

  if (!user) {
    console.error(`ไม่พบ user ที่อีเมล ${email}`);
  } else {
    console.log(`ตั้งให้ ${user.email} เป็น Admin แล้ว`);
  }

  await mongoose.disconnect();
}

main();