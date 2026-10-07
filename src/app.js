const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
const routes = require("./routes");
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

// ถ้า deploy หลัง reverse proxy ให้ตั้ง TRUST_PROXY=1 (จำนวน proxy) เพื่อให้ req.ip เป็น IP ของผู้ใช้จริง
// ใช้กับ rate limit (middleware/rateLimit.middleware.js) — ถ้าไม่ตั้ง จะใช้ IP ของ proxy ร่วมกันทุกคน
if (process.env.TRUST_PROXY) {
  const n = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isNaN(n) ? process.env.TRUST_PROXY : n);
}

app.use(cors({ origin: process.env.CLIENT_URL || "*" }));
app.use(express.json());
app.use(morgan("dev"));

// เปิดให้เข้าถึงไฟล์ที่อัปโหลด (เช่นรูปโปรไฟล์จาก FR-PROF-01) ผ่าน URL ตรงๆ
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;