const asyncHandler = require("express-async-handler");
const { Job, Feedback, User } = require("../models");

/**
 * POST /api/jobs/:id/review — FR-REV-01/02
 * body: { rating: 1-5, comment }
 * ทั้ง Hirer และ Worker รีวิวกันได้คนละทิศทางหลังงาน completed เท่านั้น คนละ 1 ครั้ง
 */
const submitReview = asyncHandler(async (req, res) => {
  const { rating, comment, tags } = req.body;
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "คะแนนต้องอยู่ระหว่าง 1-5" });
  }

  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบงานนี้" });
  if (job.status !== "completed") {
    return res.status(400).json({ message: "รีวิวได้เฉพาะงานที่เสร็จสิ้นแล้วเท่านั้น" });
  }

  const isHirer = String(job.hirer) === String(req.user._id);
  const isWorker = String(job.selectedWorker) === String(req.user._id);
  if (!isHirer && !isWorker) {
    return res.status(403).json({ message: "คุณไม่เกี่ยวข้องกับงานนี้" });
  }

  const direction = isHirer ? "hirer_to_worker" : "worker_to_hirer"; // FR-REV-01 / FR-REV-02
  const toUser = isHirer ? job.selectedWorker : job.hirer;

  let feedback;
  try {
    feedback = await Feedback.create({
      job: job._id,
      fromUser: req.user._id,
      toUser,
      direction,
      rating,
      tags: Array.isArray(tags) ? tags : [],
      comment: comment || "",
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "คุณรีวิวงานนี้ไปแล้ว" });
    }
    throw err;
  }

  // FR-REV-03: คำนวณคะแนนความน่าเชื่อถือใหม่จากค่าเฉลี่ยรีวิวสะสมทั้งหมด
  const stats = await Feedback.aggregate([
    { $match: { toUser: feedback.toUser } },
    { $group: { _id: "$toUser", avgRating: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  if (stats.length) {
    await User.findByIdAndUpdate(feedback.toUser, {
      credibilityScore: Math.round(stats[0].avgRating * 10) / 10,
      reviewCount: stats[0].count,
    });
  }

  res.status(201).json({ message: "ส่งรีวิวสำเร็จ", feedback });
});

module.exports = { submitReview };