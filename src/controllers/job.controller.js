const asyncHandler = require("express-async-handler");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Job, JobWaiting, Payment } = require("../models");
const { checkContent } = require("../utils/contentFilter");
const { logJobStatusChange } = require("../services/jobLog.service");
const { notifyUser } = require("../services/notification.service");

/**
 * POST /api/jobs
 * FR-JOB-01: สร้างประกาศงาน
 * FR-JOB-03/04: กรองเนื้อหาอัตโนมัติก่อนเข้าคิว Admin — ถ้าไม่ผ่านให้ reject ทันทีไม่ส่งต่อ Admin
 * body: { category, title, description, price, scheduledAt, durationStart, durationEnd, locationText, lat, lng,
 *         fromText, toText, deliveryFee, notes }
 */
const createJob = asyncHandler(async (req, res) => {
  const {
    category, title, description, price, scheduledAt, durationStart, durationEnd, locationText, lat, lng,
    fromText, toText, deliveryFee, notes,
  } = req.body;

  if (
    !category || !title || !description || price == null || !scheduledAt ||
    lat == null || lng == null
  ) {
    return res.status(400).json({
      message: "กรุณากรอกข้อมูลให้ครบ (category, title, description, price, scheduledAt, lat, lng)",
    });
  }
  // durationStart/durationEnd ไม่บังคับกรอก (null ได้) — เช็คลำดับเวลาเฉพาะตอนที่ส่งมาทั้งคู่
  if (durationStart && durationEnd && new Date(durationEnd) <= new Date(durationStart)) {
    return res.status(400).json({ message: "เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น" });
  }

  // FR-JOB-03: รันตัวกรองเนื้อหาอัตโนมัติกับ title + description
  const filterResult = checkContent(`${title} ${description}`);

  const job = await Job.create({
    hirer: req.user._id,
    category,
    title,
    description,
    price,
    scheduledAt,
    durationStart,
    durationEnd,
    locationText,
    fromText,
    toText,
    deliveryFee: deliveryFee || 0,
    notes,
    location: { type: "Point", coordinates: [Number(lng), Number(lat)] },
    contentFilterPassed: filterResult.passed,
    status: filterResult.passed ? "pending_review" : "rejected", // FR-JOB-04/05
    rejectionReason: filterResult.passed ? null : filterResult.reason,
  });

  await logJobStatusChange({
    jobId: job._id,
    previousStatus: null,
    newStatus: job.status,
    changedBy: req.user._id,
    note: filterResult.passed ? "ผ่านตัวกรองอัตโนมัติ รอ Admin อนุมัติ" : filterResult.reason,
  });

  if (!filterResult.passed) {
    // FR-JOB-04: แจ้งผู้ว่าจ้างทันทีว่าไม่ผ่าน ไม่ส่งต่อ Admin
    return res.status(400).json({
      message: "ประกาศงานไม่ผ่านการตรวจสอบเนื้อหาอัตโนมัติ",
      reason: filterResult.reason,
      job,
    });
  }

  // FR-JOB-05: ผ่านตัวกรองแล้ว เข้าคิวรอ Admin อนุมัติ
  res.status(201).json({
    message: "ส่งประกาศงานสำเร็จ กำลังรอผู้ดูแลระบบตรวจสอบ",
    job,
  });
});

/**
 * GET /api/jobs/my?status=waiting
 * FR-JOB-08: ดูงานที่ตนเองประกาศ กรองตามสถานะได้
 */
const getMyJobs = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const query = { hirer: req.user._id };
  if (status) query.status = status;

  const jobs = await Job.find(query).sort({ createdAt: -1 });
  res.json(jobs);
});

/** GET /api/jobs/:id — FR-BROWSE-03 (ดูรายละเอียดงาน) */
const getJobById = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id).populate("hirer", "fullName avatarUrl credibilityScore");
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  res.json(job);
});

/**
 * POST /api/jobs/:id/cancel
 * FR-JOB-07: ยกเลิกประกาศงาน (เจ้าของงานเท่านั้น)
 */
const cancelJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  if (String(job.hirer) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศงานนี้" });
  }
  if (["completed", "cancelled"].includes(job.status)) {
    return res.status(400).json({ message: `ไม่สามารถยกเลิกงานที่มีสถานะ ${job.status} ได้` });
  }

  const previousStatus = job.status;
  job.status = "cancelled";
  job.cancelledAt = new Date();
  job.cancelReason = req.body?.reason || null;
  await job.save();

  await logJobStatusChange({
    jobId: job._id,
    previousStatus,
    newStatus: "cancelled",
    changedBy: req.user._id,
    note: job.cancelReason,
  });

  // TODO (FR-JOB-07 / FR-PAY-06,07): ถ้ามีเงินพักใน Escrow (Payment.status === "held")
  // ให้สร้าง refund request ที่นี่ ต่อเมื่อ implement payment.controller.js

  res.json({ message: "ยกเลิกประกาศงานสำเร็จ", job });
});

/**
 * GET /api/jobs?type=all|hirer&category=...&search=...
 * FR-BROWSE-01/02: ฟีดประกาศงานที่เปิดรับสมัคร (status=waiting) กรองตามหมวดหมู่/คำค้นได้
 * หมายเหตุ: type=worker (Service Post) จะรวมเข้ามาทีหลังตอน implement FR-SERV เต็มระบบ
 */
const getFeed = asyncHandler(async (req, res) => {
  const { category, search } = req.query;
  const query = { status: "waiting" };
  if (category && category !== "all") query.category = category;
  if (search) {
    query.$or = [
      { title: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
  }

  const jobs = await Job.find(query)
    .populate("hirer", "fullName avatarUrl credibilityScore")
    .sort({ createdAt: -1 });
  res.json(jobs);
});

/**
 * POST /api/jobs/:id/apply
 * FR-BROWSE-04: สมัครงาน เพิ่มเข้าคิว JOB_WAITING
 * FR-BROWSE-05: สมัครได้หลายงานพร้อมกัน (unique index job+worker กัน apply ซ้ำงานเดิม)
 * FR-BROWSE-06: ห้ามสมัครงานของตัวเอง หรืองานที่ไม่ได้อยู่ในสถานะเปิดรับสมัคร
 */
const applyToJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });

  if (String(job.hirer) === String(req.user._id)) {
    return res.status(400).json({ message: "ไม่สามารถสมัครงานของตัวเองได้" });
  }
  if (job.status !== "waiting") {
    return res.status(400).json({ message: "งานนี้ไม่ได้เปิดรับสมัครอยู่ (อาจถูกเลือกผู้รับจ้างแล้วหรือยกเลิกไปแล้ว)" });
  }

  try {
    const distanceMeters = req.user.lastKnownLocation?.coordinates
      ? require("../utils/geo").distanceMeters(req.user.lastKnownLocation.coordinates, job.location.coordinates)
      : null;

    const application = await JobWaiting.create({
      job: job._id,
      worker: req.user._id,
      distanceMeters,
    });

    await notifyUser(req.app.get("io"), {
      userId: job.hirer,
      type: "application_update",
      title: "มีผู้สมัครงานใหม่",
      message: `${req.user.fullName || "ผู้ใช้"} สมัครงาน "${job.title}"`,
      relatedEntityType: "Job",
      relatedEntityId: job._id,
    });

    res.status(201).json({ message: "สมัครงานสำเร็จ กรุณารอผู้ว่าจ้างเลือก", application });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "คุณสมัครงานนี้ไปแล้ว" });
    }
    throw err;
  }
});

/**
 * GET /api/jobs/:id/applicants — FR-MATCH-03
 * ดูรายชื่อผู้สมัครทั้งหมดของงาน (เจ้าของงานเท่านั้น)
 */
const getApplicants = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  if (String(job.hirer) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศงานนี้" });
  }

  const applicants = await JobWaiting.find({ job: job._id, status: "waiting" })
    .populate("worker", "fullName avatarUrl credibilityScore reviewCount")
    .sort({ distanceMeters: 1, createdAt: 1 });

  res.json(applicants);
});

/**
 * POST /api/jobs/:id/select-worker — FR-MATCH-04/05/06, FR-PAY-01
 * body: { workerId }
 * เลือกผู้รับจ้างจากคิวผู้สมัคร -> มอบหมายงาน -> สร้าง Payment (Escrow) สถานะ pending -> แจ้งเตือนทุกฝ่าย
 */
const selectWorker = asyncHandler(async (req, res) => {
  const { workerId } = req.body;
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  if (String(job.hirer) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศงานนี้" });
  }
  if (job.status !== "waiting") {
    return res.status(400).json({ message: `งานนี้มีสถานะ ${job.status} ไม่สามารถเลือกผู้รับจ้างได้` });
  }

  const chosen = await JobWaiting.findOne({ job: job._id, worker: workerId, status: "waiting" });
  if (!chosen) return res.status(404).json({ message: "ไม่พบผู้สมัครคนนี้ในคิวของงานนี้" });

  const previousStatus = job.status;
  job.status = "assigned";
  job.selectedWorker = workerId;
  await job.save();

  // FR-MATCH-05: ทำเครื่องหมายผู้สมัครรายอื่นทั้งหมดเป็น "ไม่ได้รับเลือก"
  await JobWaiting.updateMany({ job: job._id, worker: { $ne: workerId } }, { status: "not_selected" });
  chosen.status = "selected";
  await chosen.save();

  await logJobStatusChange({
    jobId: job._id,
    previousStatus,
    newStatus: "assigned",
    changedBy: req.user._id,
    note: `เลือกผู้รับจ้าง ${workerId}`,
  });

  // FR-PAY-01/02: เปิด Payment record ให้ตรงเข้าสถานะ "held" ทันที
  // หมายเหตุ: ระบบยังไม่มี endpoint อัปโหลดสลิปเงินเข้า Escrow แยกต่างหาก (FR-PAY-04 ยังเป็น TODO)
  // จึงถือว่าเงินเข้า Escrow แล้วทันทีที่เลือกผู้รับจ้าง เพื่อให้ flow ฝั่ง worker ทดสอบได้ครบวงจรก่อน
  const totalAmount = job.price + (job.deliveryFee || 0);
  const feePercent = Number(process.env.ESCROW_FEE_PERCENT_MIN) || 5;
  const feeAmount = Math.round((totalAmount * feePercent) / 100);
  await Payment.create({
    job: job._id,
    hirer: job.hirer,
    worker: workerId,
    amount: totalAmount,
    platformFeePercent: feePercent,
    platformFeeAmount: feeAmount,
    netAmountToWorker: totalAmount - feeAmount,
    status: "held",
    heldAt: new Date(),
  });

  const io = req.app.get("io");
  await notifyUser(io, {
    userId: workerId,
    type: "application_update",
    title: "คุณได้รับเลือกให้ทำงานนี้",
    message: job.title,
    relatedEntityType: "Job",
    relatedEntityId: job._id,
  });

  res.json({ message: "เลือกผู้รับจ้างสำเร็จ", job });
});

/**
 * GET /api/jobs/my-as-worker?status=waiting|in-progress|completed|cancelled
 * FR-BROWSE-07, FR-TRACK-01/06: งาน/ใบสมัครของ worker ปัจจุบัน จัดกลุ่มตามแท็บ
 */
const getMyWorkerJobs = asyncHandler(async (req, res) => {
  const { status = "waiting" } = req.query;

  if (status === "waiting") {
    // ใบสมัครที่ยังรออยู่ในคิว ยังไม่ถูกเลือก (FR-BROWSE-07)
    const applications = await JobWaiting.find({ worker: req.user._id, status: "waiting" })
      .populate("job")
      .sort({ createdAt: -1 });

    const result = applications
      .filter((a) => a.job) // กันกรณีงานถูกลบไปแล้ว
      .map((a) => ({
        id: a.job._id,
        status: "waiting",
        title: a.job.title,
        hirerName: null,
        price: a.job.price,
        category: a.job.category,
      }));
    return res.json(result);
  }

  const statusMap = { "in-progress": ["assigned", "in_progress"], completed: ["completed"], cancelled: ["cancelled"] };
  const jobStatuses = statusMap[status];
  if (!jobStatuses) return res.status(400).json({ message: "status ไม่ถูกต้อง" });

  const jobs = await Job.find({ selectedWorker: req.user._id, status: { $in: jobStatuses } })
    .populate("hirer", "fullName avatarUrl")
    .sort({ updatedAt: -1 });

  const result = jobs.map((j) => ({
    id: j._id,
    status,
    title: j.title,
    hirerName: j.hirer?.fullName || null,
    price: j.price,
    category: j.category,
  }));
  res.json(result);
});

/* ---------- อัปโหลดรูปหลักฐานงานเสร็จ (FR-TRACK-03) ---------- */
const PROOF_DIR = path.join(__dirname, "..", "..", "uploads", "job-proofs");
fs.mkdirSync(PROOF_DIR, { recursive: true });
const proofUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PROOF_DIR),
    filename: (req, file, cb) => cb(null, `${req.params.id}-${Date.now()}${path.extname(file.originalname) || ".jpg"}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/**
 * PATCH /api/jobs/:id/status — FR-TRACK-01/03/05 (multipart/form-data ถ้าแนบรูป)
 * body: { next: "in_progress" | "completed" }, field รูป: "proof" (บังคับถ้า next=completed)
 */
const updateJobStatus = [
  proofUpload.single("proof"),
  asyncHandler(async (req, res) => {
    const { next } = req.body;
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ message: "ไม่พบงานนี้" });
    if (String(job.selectedWorker) !== String(req.user._id)) {
      return res.status(403).json({ message: "คุณไม่ใช่ผู้รับจ้างของงานนี้" });
    }

    const allowedTransitions = { assigned: "in_progress", in_progress: "completed" };
    if (allowedTransitions[job.status] !== next) {
      return res.status(400).json({ message: `ไม่สามารถเปลี่ยนจาก ${job.status} ไปเป็น ${next} ได้` });
    }

    if (next === "completed") {
      if (!req.file) return res.status(400).json({ message: "ต้องแนบรูปภาพหลักฐานก่อนทำเครื่องหมายว่างานเสร็จ" }); // FR-TRACK-03
      job.completionProofUrl = `/uploads/job-proofs/${req.file.filename}`;
    }

    const previousStatus = job.status;
    job.status = next;
    await job.save();

    await logJobStatusChange({ jobId: job._id, previousStatus, newStatus: next, changedBy: req.user._id }); // FR-TRACK-05

    const io = req.app.get("io");
    await notifyUser(io, {
      userId: job.hirer,
      type: "job_status_change",
      title: "งานมีการอัปเดตสถานะ",
      message: `${job.title} — ${next === "completed" ? "เสร็จสิ้นแล้ว รอคุณยืนยัน" : "เริ่มดำเนินการแล้ว"}`,
      relatedEntityType: "Job",
      relatedEntityId: job._id,
    }); // FR-TRACK-02

    res.json({ message: "อัปเดตสถานะสำเร็จ", job });
  }),
];

/**
 * POST /api/jobs/:id/confirm-completion — FR-TRACK-04, FR-PAY-05
 * Hirer ยืนยันงานเสร็จ -> ปล่อยเงิน Escrow ให้ worker (ต้องมีสลิปโอนออกแนบมา — ทำแบบง่ายด้วย outboundSlipUrl ก่อน)
 */
const confirmCompletion = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบงานนี้" });
  if (String(job.hirer) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของงานนี้" });
  }
  if (job.status !== "completed") {
    return res.status(400).json({ message: "งานนี้ยังไม่ถูกทำเครื่องหมายว่าเสร็จโดยผู้รับจ้าง" });
  }

  const payment = await Payment.findOne({ job: job._id });
  if (payment && payment.status === "held") {
    payment.status = "released";
    payment.releasedAt = new Date();
    await payment.save();

    await notifyUser(req.app.get("io"), {
      userId: job.selectedWorker,
      type: "payment_update",
      title: "ได้รับเงินแล้ว",
      message: `เงินจากงาน "${job.title}" ถูกโอนเข้าบัญชีของคุณแล้ว`,
      relatedEntityType: "Payment",
      relatedEntityId: payment._id,
    });
  }

  res.json({ message: "ยืนยันงานเสร็จสำเร็จ", job, payment });
});

module.exports = {
  createJob, getMyJobs, getJobById, cancelJob,
  getFeed, applyToJob, getApplicants, selectWorker, getMyWorkerJobs, updateJobStatus, confirmCompletion,
};