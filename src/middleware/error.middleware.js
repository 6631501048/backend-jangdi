/** Middleware จัดการ error กลาง — ให้ controller โยน error แล้วมาจบที่นี่ */
function notFound(req, res, next) {
  res.status(404).json({ message: `ไม่พบ endpoint: ${req.originalUrl}` });
}

function errorHandler(err, req, res, next) {
  const statusCode = res.statusCode !== 200 ? res.statusCode : err.statusCode || 500;
  res.status(statusCode).json({
    message: err.message || "เกิดข้อผิดพลาดที่ไม่คาดคิด",
    stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
  });
}

module.exports = { notFound, errorHandler };
