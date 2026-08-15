const jwt = require("jsonwebtoken");
const { User } = require("../models");

/**
 * ตรวจสอบ JWT และแนบ req.user
 * ใช้ป้องกันทุก route ที่ต้อง login (FR-AUTH, NFR-SEC-04)
 */
async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.split(" ")[1] : null;
    if (!token) {
      return res.status(401).json({ message: "ไม่พบ token กรุณาเข้าสู่ระบบ" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: "ไม่พบบัญชีผู้ใช้นี้" });
    }
    if (user.accountStatus === "suspended") {
      return res.status(403).json({ message: "บัญชีนี้ถูกระงับการใช้งาน" });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "token ไม่ถูกต้องหรือหมดอายุ" });
  }
}

/** จำกัดเฉพาะ Admin (NFR-SEC-04) */
function adminOnly(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ message: "เฉพาะผู้ดูแลระบบเท่านั้น" });
  }
  next();
}

/** ตรวจว่า currentRole ของผู้ใช้ตรงกับที่ route ต้องการ (เช่น ต้องเป็น hirer ถึงจะโพสต์งานได้) */
function requireRole(role) {
  return (req, res, next) => {
    if (req.user.currentRole !== role) {
      return res.status(403).json({ message: `ต้องสลับไปที่บทบาท ${role} ก่อน` });
    }
    next();
  };
}

module.exports = { protect, adminOnly, requireRole };
