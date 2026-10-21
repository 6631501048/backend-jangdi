const asyncHandler = require("express-async-handler");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { detectProofImage } = require("../utils/proofImage");
const { Job, JobWaiting, Payment, JobLog } = require("../models");
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
  const hasDurationStart = durationStart != null && durationStart !== "";
  const hasDurationEnd = durationEnd != null && durationEnd !== "";
  if (hasDurationStart !== hasDurationEnd) {
    return res.status(400).json({ message: "กรุณาระบุเวลาเริ่มต้นและเวลาสิ้นสุดให้ครบ หรือเว้นว่างทั้งคู่" });
  }
  if (hasDurationStart) {
    const startTime = new Date(durationStart).getTime();
    const endTime = new Date(durationEnd).getTime();
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      return res.status(400).json({ message: "เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น" });
    }
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
  if (status === "assigned") query.status = { $in: ["assigned", "in_progress", "awaiting_confirmation"] };
  else if (status) query.status = status;

  const jobs = await Job.find(query).sort({ createdAt: -1 });
  res.json(jobs);
});

/** GET /api/jobs/:id/timeline — real audit timestamps, limited to the job participants. */
const getJobTimeline = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบงานนี้" });
  const userId = String(req.user._id);
  if (!req.user.isAdmin && userId !== String(job.hirer) && userId !== String(job.selectedWorker)) {
    return res.status(403).json({ message: "ไม่มีสิทธิ์ดูประวัติสถานะงานนี้" });
  }
  const logs = await JobLog.find({ job: job._id }).sort({ createdAt: 1 });
  res.json(logs.map((log) => ({
    status: log.newStatus,
    at: log.createdAt,
  })));
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
  if (req.body?.expiredNoApplicants === true) {
    if (job.status !== "waiting" || new Date(job.scheduledAt).getTime() >= Date.now()) {
      return res.status(400).json({ message: "ยกเลิกได้เมื่องานเลยเวลานัดแล้วเท่านั้น" });
    }
    const applicantCount = await JobWaiting.countDocuments({ job: job._id, status: "waiting" });
    if (applicantCount > 0) {
      return res.status(400).json({ message: "งานนี้ยังมีผู้สมัคร ไม่สามารถยกเลิกด้วยเหตุหมดเวลาได้" });
    }
  }
  // MVP: allow direct cancellation only before assigning a Worker.
  // Cancelling an active job with held demo payment requires the later dispute/refund flow.
  if (!["pending_review", "waiting"].includes(job.status)) {
    return res.status(409).json({ message: "งานนี้เลือก Worker แล้วหรือปิดงานไปแล้ว กรุณาติดต่อผู้ดูแลเพื่อดำเนินการยกเลิก" });
  }

  const previousStatus = job.status;
  const cancelled = await Job.findOneAndUpdate(
    { _id: job._id, hirer: req.user._id, status: previousStatus },
    { $set: { status: "cancelled", cancelledAt: new Date(), cancelReason: req.body?.reason?.trim() || null } },
    { new: true, runValidators: true }
  );
  if (!cancelled) return res.status(409).json({ message: "สถานะงานเปลี่ยนไปแล้ว กรุณาโหลดหน้าใหม่" });

  await logJobStatusChange({
    jobId: cancelled._id,
    previousStatus,
    newStatus: "cancelled",
    changedBy: req.user._id,
    note: cancelled.cancelReason,
  });

  // TODO (FR-JOB-07 / FR-PAY-06,07): ถ้ามีเงินพักใน Escrow (Payment.status === "held")
  // ให้สร้าง refund request ที่นี่ ต่อเมื่อ implement payment.controller.js

  res.json({ message: "ยกเลิกประกาศงานสำเร็จ", job: cancelled });
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
  // Atomic selection so a cancellation or another selection cannot race with this action.
  const assignedJob = await Job.findOneAndUpdate(
    { _id: job._id, hirer: req.user._id, status: "waiting" },
    { $set: { status: "assigned", selectedWorker: workerId } },
    { new: true, runValidators: true }
  );
  if (!assignedJob) return res.status(409).json({ message: "งานนี้ถูกเลือก Worker หรือยกเลิกไปแล้ว กรุณาโหลดหน้าใหม่" });

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

  res.json({ message: "เลือกผู้รับจ้างสำเร็จ", job: assignedJob });
});

/**
 * GET /api/jobs/my-as-worker?status=waiting|in-progress|completed|cancelled
 * FR-BROWSE-07, FR-TRACK-01/06: งาน/ใบสมัครของ worker ปัจจุบัน จัดกลุ่มตามแท็บ
 */
const getMyWorkerJobs = asyncHandler(async (req, res) => {
  const { status = "waiting" } = req.query;

  // Keep the waiting list free of cancelled / closed posts. Cancelled jobs
  // remain visible in their own tab for Workers who applied before selection.
  if (status === "waiting" || status === "cancelled") {
    const applications = await JobWaiting.find({ worker: req.user._id })
      .populate({ path: "job", populate: { path: "hirer", select: "fullName avatarUrl" } })
      .sort({ createdAt: -1 });

    if (status === "waiting") {
      return res.json(applications
        .filter((a) => a.status === "waiting" && a.job?.status === "waiting")
        .map((a) => ({
          id: a.job._id, status: "waiting", backendStatus: "waiting",
          title: a.job.title, hirerName: a.job.hirer?.fullName || null,
          price: a.job.price, category: a.job.category, scheduledAt: a.job.scheduledAt,
        })));
    }

    // Cancelled after assignment OR after application are both legitimate
    // cancelled jobs for that Worker. One job appears only once.
    const cancelledJobs = await Job.find({ selectedWorker: req.user._id, status: "cancelled" })
      .populate("hirer", "fullName avatarUrl");
    const byId = new Map();
    for (const j of cancelledJobs) byId.set(String(j._id), j);
    for (const a of applications) {
      if (a.job?.status === "cancelled") byId.set(String(a.job._id), a.job);
    }
    return res.json(Array.from(byId.values())
      .sort((a, b) => new Date(b.cancelledAt || b.updatedAt) - new Date(a.cancelledAt || a.updatedAt))
      .map((j) => ({
        id: j._id, status: "cancelled", backendStatus: "cancelled",
        title: j.title, hirerName: j.hirer?.fullName || null,
        price: j.price, category: j.category, scheduledAt: j.scheduledAt,
      })));
  }

  const statusMap = {
    "in-progress": ["assigned", "in_progress", "awaiting_confirmation"],
    completed: ["completed"],
  };
  const jobStatuses = statusMap[status];
  if (!jobStatuses) return res.status(400).json({ message: "status ไม่ถูกต้อง" });

  const jobs = await Job.find({ selectedWorker: req.user._id, status: { $in: jobStatuses } })
    .populate("hirer", "fullName avatarUrl")
    .sort({ updatedAt: -1 });

  res.json(jobs.map((j) => ({
    id: j._id,
    status,
    backendStatus: j.status,
    title: j.title,
    hirerName: j.hirer?.fullName || null,
    price: j.price,
    category: j.category,
    scheduledAt: j.scheduledAt,
  })));
});

/* ---------- Completion proof + durable Hirer confirmation (PR 1) ---------- */
const PROOF_DIR = path.join(__dirname, "..", "..", "uploads", "job-proofs");
fs.mkdirSync(PROOF_DIR, { recursive: true });

// Keep an untrusted upload in memory until ownership, state and the image signature
// have been checked. Nothing is written to disk for invalid / unauthorized requests.
const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("รองรับเฉพาะภาพ JPG, PNG หรือ WebP"));
    }
    cb(null, true);
  },
});

const uploadProof = (req, res, next) => proofUpload.single("proof")(req, res, (err) => {
  if (!err) return next();
  return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
    message: err.code === "LIMIT_FILE_SIZE" ? "ภาพต้องมีขนาดไม่เกิน 5 MB" : err.message,
  });
});

/** PATCH /api/jobs/:id/status — assigned -> in_progress -> awaiting_confirmation */
const updateJobStatus = [
  uploadProof,
  asyncHandler(async (req, res) => {
    const { next } = req.body;
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ message: "ไม่พบงานนี้" });
    if (String(job.selectedWorker) !== String(req.user._id)) {
      return res.status(403).json({ message: "คุณไม่ใช่ผู้รับจ้างของงานนี้" });
    }
    const allowedTransitions = { assigned: "in_progress", in_progress: "awaiting_confirmation" };
    if (allowedTransitions[job.status] !== next) {
      return res.status(409).json({ message: `ไม่สามารถเปลี่ยนจาก ${job.status} ไปเป็น ${next} ได้` });
    }
    if (next === "in_progress" && req.file) {
      return res.status(400).json({ message: "ยังไม่ต้องแนบรูปก่อนเริ่มทำงาน" });
    }

    const fields = { status: next };
    let savedImagePath = null;
    if (next === "awaiting_confirmation") {
      if (!req.file) return res.status(400).json({ message: "กรุณาแนบภาพหลักฐานก่อนส่งงาน" });
      const kind = detectProofImage(req.file.buffer);
      if (!kind || kind.mime !== req.file.mimetype) {
        return res.status(400).json({ message: "ชนิดไฟล์ภาพไม่ถูกต้อง (รองรับ JPG, PNG, WebP เท่านั้น)" });
      }
      const filename = `${job._id}-${randomUUID()}${kind.ext}`;
      savedImagePath = path.join(PROOF_DIR, filename);
      await fs.promises.writeFile(savedImagePath, req.file.buffer, { flag: "wx" });
      fields.completionProofUrl = `/uploads/job-proofs/${filename}`;
      fields.proofSubmittedAt = new Date();
    }

    let updated;
    try {
      // Atomic compare-and-set: concurrent submissions cannot overwrite the evidence.
      updated = await Job.findOneAndUpdate(
        { _id: job._id, selectedWorker: req.user._id, status: job.status },
        { $set: fields },
        { new: true, runValidators: true }
      );
    } catch (err) {
      if (savedImagePath) await fs.promises.unlink(savedImagePath).catch(() => {});
      throw err;
    }
    if (!updated) {
      if (savedImagePath) await fs.promises.unlink(savedImagePath).catch(() => {});
      return res.status(409).json({ message: "สถานะงานเปลี่ยนไปแล้ว กรุณาโหลดหน้าใหม่" });
    }

    await logJobStatusChange({ jobId: updated._id, previousStatus: job.status, newStatus: next, changedBy: req.user._id });
    await notifyUser(req.app.get("io"), {
      userId: updated.hirer,
      type: "job_status_change",
      title: next === "awaiting_confirmation" ? "มีงานรอตรวจสอบหลักฐาน" : "Worker เริ่มทำงานแล้ว",
      message: next === "awaiting_confirmation" ? `Worker ส่งหลักฐานงาน "${updated.title}" แล้ว กรุณาตรวจสอบและยืนยัน` : updated.title,
      relatedEntityType: "Job",
      relatedEntityId: updated._id,
    });

    res.json({ message: next === "awaiting_confirmation" ? "ส่งหลักฐานแล้ว รอ Hirer ยืนยัน" : "เริ่มงานสำเร็จ", job: updated });
  }),
];

/** GET /api/jobs/:id/completion-proof — only the Hirer, selected Worker or Admin. */
const getCompletionProof = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบงานนี้" });
  const userId = String(req.user._id);
  if (!req.user.isAdmin && userId !== String(job.hirer) && userId !== String(job.selectedWorker)) {
    return res.status(403).json({ message: "ไม่มีสิทธิ์ดูหลักฐานของงานนี้" });
  }

  // Resolve only stored paths belonging to our private proof directory. Never accept
  // filename/path input from the request (prevents path traversal).
  const match = /^\/uploads\/job-proofs\/([a-zA-Z0-9_.-]+)$/.exec(job.completionProofUrl || "");
  if (!match || match[1] === "." || match[1] === "..") {
    return res.status(404).json({ message: "ยังไม่มีหลักฐานของงานนี้" });
  }
  let content;
  try {
    content = await fs.promises.readFile(path.join(PROOF_DIR, match[1]));
  } catch (err) {
    if (err.code === "ENOENT") return res.status(404).json({ message: "ไม่พบไฟล์หลักฐาน" });
    throw err;
  }
  const image = detectProofImage(content);
  if (!image) return res.status(415).json({ message: "หลักฐานไม่ใช่ไฟล์ภาพที่รองรับ" });
  res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  res.type(image.mime).send(content);
});

/** POST /api/jobs/:id/confirm-completion — Hirer is the ONLY person who can close a job. */
const confirmCompletion = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบงานนี้" });
  if (String(job.hirer) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของงานนี้" });
  }
  if (job.status === "completed" || job.completionConfirmedAt) {
    return res.status(409).json({ message: "งานนี้ได้รับการยืนยันแล้ว" });
  }
  if (job.status !== "awaiting_confirmation") {
    return res.status(409).json({ message: "ยังไม่มีงานที่รอให้คุณยืนยัน" });
  }
  if (!job.completionProofUrl) {
    return res.status(400).json({ message: "ยังไม่มีรูปหลักฐาน ไม่สามารถยืนยันงานได้" });
  }

  const confirmedAt = new Date();
  // One winner, even when two requests arrive simultaneously or after a refresh.
  const updated = await Job.findOneAndUpdate(
    {
      _id: job._id, hirer: req.user._id, status: "awaiting_confirmation",
      completionConfirmedAt: null, completionProofUrl: { $type: "string", $ne: "" },
    },
    { $set: { status: "completed", completionConfirmedAt: confirmedAt, completionConfirmedBy: req.user._id } },
    { new: true, runValidators: true }
  );
  if (!updated) return res.status(409).json({ message: "งานนี้ถูกยืนยันหรือเปลี่ยนสถานะไปแล้ว" });

  await logJobStatusChange({ jobId: updated._id, previousStatus: "awaiting_confirmation", newStatus: "completed", changedBy: req.user._id });

  // PR 1 retains the pre-existing DEMO payment workflow; NO real transfer occurs.
  // Guard the update so it cannot release the simulation twice.
  const payment = await Payment.findOneAndUpdate(
    { job: updated._id, status: "held" },
    { $set: { status: "released", releasedAt: confirmedAt } },
    { new: true, runValidators: true }
  );
  if (payment) {
    await notifyUser(req.app.get("io"), {
      userId: updated.selectedWorker,
      type: "payment_update",
      title: "บันทึกการจ่ายเงินจำลองแล้ว",
      message: `ระบบได้บันทึกสถานะจ่ายเงินจำลองสำหรับงาน "${updated.title}" (ยังไม่มีการโอนเงินจริง)`,
      relatedEntityType: "Payment",
      relatedEntityId: payment._id,
    });
  }
  await notifyUser(req.app.get("io"), {
    userId: updated.selectedWorker,
    type: "job_status_change",
    title: "งานได้รับการยืนยันแล้ว",
    message: `Hirer ยืนยันงาน "${updated.title}" สำเร็จ`,
    relatedEntityType: "Job",
    relatedEntityId: updated._id,
  });

  res.json({ message: "ยืนยันเสร็จงานสำเร็จ (การจ่ายเงินเป็นระบบจำลอง)", job: updated, payment });
});

module.exports = {
  createJob, getMyJobs, getJobById, getJobTimeline, cancelJob,
  getFeed, applyToJob, getApplicants, selectWorker, getMyWorkerJobs, updateJobStatus, confirmCompletion, getCompletionProof,
};
