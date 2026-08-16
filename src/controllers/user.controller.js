const asyncHandler = require("express-async-handler");
const { User } = require("../models");

/** GET /api/users/:id — FR-PROF-01 */
const getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("-password");
  if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });
  res.json(user);
});

/**
 * PATCH /api/users/:id — FR-PROF-01, FR-PROF-02
 * เจ้าของบัญชีเท่านั้นที่แก้ไขได้ (หรือ Admin)
 * body: { fullName, phone, lineId, facebook, instagram, avatarUrl,
 *         contactAddress: { name, address, phone },
 *         lat, lng } // FR-PROF-02 + ตำแหน่งสำหรับ matching (FR-MATCH-01)
 */
const updateProfile = asyncHandler(async (req, res) => {
  if (String(req.params.id) !== String(req.user._id) && !req.user.isAdmin) {
    return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขโปรไฟล์นี้" });
  }

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });

  const { fullName, phone, lineId, facebook, instagram, avatarUrl, contactAddress, lat, lng } = req.body;

  if (fullName !== undefined) user.fullName = fullName;
  if (phone !== undefined) user.phone = phone;
  if (lineId !== undefined) user.lineId = lineId;
  if (facebook !== undefined) user.facebook = facebook;
  if (instagram !== undefined) user.instagram = instagram;
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
  if (contactAddress !== undefined) user.contactAddress = contactAddress; // FR-PROF-02

  // FR-MATCH-01: บันทึกตำแหน่งปัจจุบันเพื่อใช้คำนวณระยะทางตอนแจ้งเตือนงานใกล้เคียง
  if (lat != null && lng != null) {
    user.lastKnownLocation = { type: "Point", coordinates: [Number(lng), Number(lat)] };
  }

  // FR-AUTH-05: กรอกข้อมูลจำเป็น (ชื่อ + เบอร์โทร) ครบแล้วถือว่าโปรไฟล์สมบูรณ์
  if (user.fullName && user.phone) {
    user.isProfileComplete = true;
  }

  await user.save();

  const sanitized = user.toObject();
  delete sanitized.password;
  res.json({ message: "บันทึกโปรไฟล์สำเร็จ", user: sanitized });
});

module.exports = { getProfile, updateProfile };