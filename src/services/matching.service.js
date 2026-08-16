const { User } = require("../models");
const { notifyUser } = require("./notification.service");

/**
 * FR-MATCH-01 / FR-MATCH-02 / NFR-PERF-01:
 * แจ้งเตือน Worker ทุกคนที่อยู่ในรัศมี WORKER_MATCH_RADIUS_METERS จากตำแหน่งงาน
 * ต้องทำงานให้เสร็จภายใน 1 นาทีหลังงานได้รับการอนุมัติ — ฟังก์ชันนี้ไม่ block request
 * (เรียกแบบ fire-and-forget จาก controller ได้)
 *
 * @param {import("socket.io").Server} io
 * @param {import("mongoose").Document} job
 */
async function notifyNearbyWorkers(io, job) {
  const radiusMeters = Number(process.env.WORKER_MATCH_RADIUS_METERS) || 2000;

  // ใช้ MongoDB geospatial query ($nearSphere) ตรงตาม NFR-SCALE-02
  // เงื่อนไข: ต้องมี lastKnownLocation ตั้งไว้แล้ว (user ที่เพิ่งสมัครไม่มีพิกัด จะถูกข้ามไปเอง)
  const nearbyWorkers = await User.find({
    _id: { $ne: job.hirer },
    lastKnownLocation: {
      $nearSphere: {
        $geometry: { type: "Point", coordinates: job.location.coordinates },
        $maxDistance: radiusMeters,
      },
    },
  }).select("_id");

  await Promise.all(
    nearbyWorkers.map((worker) =>
      notifyUser(io, {
        userId: worker._id,
        type: "new_nearby_job",
        title: "มีงานใหม่ใกล้คุณ",
        message: `${job.title} — ${job.category} (${job.price} บาท)`,
        relatedEntityType: "Job",
        relatedEntityId: job._id,
      })
    )
  );

  return nearbyWorkers.length;
}

module.exports = { notifyNearbyWorkers };