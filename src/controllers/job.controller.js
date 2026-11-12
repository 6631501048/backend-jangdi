const asyncHandler = require("express-async-handler");
const multer = require("multer");
const path = require("path");
const mongoose = require("mongoose");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { detectProofImage } = require("../utils/proofImage");
const { readCompletionProof } = require("../services/jobProof.service");
const { Job, JobWaiting, Payment, JobLog, ServiceRequest, ServicePost } = require("../models");
const { checkContent } = require("../utils/contentFilter");
const { logJobStatusChange } = require("../services/jobLog.service");
const { createNotification, deliverNotification, notifyUser } = require("../services/notification.service");
const { withTransaction } = require("../services/transaction.service");

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

// ฟิลด์ที่คนนอกเห็นได้ (ตรงกับที่หน้า browse ใช้จริง)
// ไม่รวม: location, selectedWorker, rejectionReason, cancelReason, approvedBy/At,
// completionProof*, originServiceRequest
const PUBLIC_JOB_FIELDS = [
  "_id", "category", "title", "description", "locationText", "fromText", "toText",
  "deliveryFee", "notes", "price", "scheduledAt", "durationStart", "durationEnd",
  "status", "createdAt", "hirer",
];
const pickPublicJob = (job) => {
  const plain = typeof job.toJSON === "function" ? job.toJSON() : job;
  return Object.fromEntries(PUBLIC_JOB_FIELDS.filter((key) => key in plain).map((key) => [key, plain[key]]));
};

const getJobById = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  const job = await Job.findById(req.params.id).populate("hirer", "fullName avatarUrl credibilityScore");
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });

  const userId = String(req.user._id);
  const hirerId = String(job.hirer?._id ?? job.hirer);
  const isParticipant = req.user.isAdmin || userId === hirerId ||
    (job.selectedWorker && userId === String(job.selectedWorker));
  if (isParticipant) return res.json(job);

  let visible = job.status === "waiting";
  if (!visible) visible = Boolean(await JobWaiting.exists({ job: job._id, worker: req.user._id }));
  if (!visible) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  res.json(pickPublicJob(job));
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
  // Exclude legacy/inconsistent records that still say "waiting" even though
  // completion has already been confirmed. Null also matches older documents
  // where the optional completion field was never stored.
  const query = { status: "waiting", completionConfirmedAt: null };
  if (category && category !== "all") query.category = category;
  if (search) {
    query.$or = [
      { title: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
  }

  const jobs = await Job.find(query)
    .select(PUBLIC_JOB_FIELDS.join(" "))
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

  // Keep assignment, waiting-list update, payment creation and audit log together.
  // Without this transaction an exception after assignment could leave no payment
  // and the Hirer would be unable to reach the Demo payment step.
  let assignedJob;
  try {
    await withTransaction(async (session) => {
      assignedJob = await Job.findOneAndUpdate(
        { _id: job._id, hirer: req.user._id, status: "waiting" },
        { $set: { status: "assigned", selectedWorker: workerId } },
        { new: true, runValidators: true, session }
      );
      if (!assignedJob) {
        const conflict = new Error("งานถูกเลือก Worker หรือยกเลิกไปแล้ว");
        conflict.code = "WORKER_SELECTION_CONFLICT";
        throw conflict;
      }
      const selected = await JobWaiting.updateOne(
        { job: job._id, worker: workerId, status: "waiting" },
        { $set: { status: "selected" } }, { session }
      );
      if (selected.matchedCount !== 1) {
        const conflict = new Error("ผู้สมัครไม่อยู่ในคิวงานแล้ว");
        conflict.code = "WORKER_SELECTION_CONFLICT";
        throw conflict;
      }
      await JobWaiting.updateMany(
        { job: job._id, worker: { $ne: workerId }, status: "waiting" },
        { $set: { status: "not_selected" } }, { session }
      );
      const amount = Number(job.price) + Number(job.deliveryFee || 0);
      const paymentTerms = require('../services/paymentTerms.service');
      const feeBreakdown = paymentTerms.calculateCombinedFees(amount);
      await Payment.create([{
        job: job._id, hirer: job.hirer, worker: workerId, amount,
        platformFeePercent: feeBreakdown.appPercent,
        platformFeeAmount: feeBreakdown.platformFeeAmount,
        platformFeeFixedAmount: feeBreakdown.appFixed,
        netAmountToWorker: amount,
        status: "pending", paymentMode: "slip_demo",
        gatewayFeeAmount: feeBreakdown.gatewayFeeAmount,
        mockGatewayFeeAmount: feeBreakdown.gatewayFeeAmount,
        mockGatewayFeePercent: feeBreakdown.gatewayPercent,
        mockGatewayFeeFixedAmount: feeBreakdown.gatewayFixed,
      }], { session });
      await logJobStatusChange({
        jobId: job._id, previousStatus: "waiting", newStatus: "assigned",
        changedBy: req.user._id, note: `เลือกผู้รับจ้าง ${workerId}`, session,
      });
    });
  } catch (err) {
    if (err.code === "WORKER_SELECTION_CONFLICT" || err.code === 11000 || err.hasErrorLabel?.("TransientTransactionError")) {
      return res.status(409).json({ message: "ไม่สามารถเลือก Worker ได้ กรุณาโหลดงานใหม่" });
    }
    throw err;
  }

  const io = req.app.get("io");
  try {
    await notifyUser(io, {
      userId: workerId,
      type: "application_update",
      title: "คุณได้รับเลือกให้ทำงานนี้ (รอชำระ Demo)",
      message: `งาน \"${job.title}\" รอ Hirer กดยืนยัน Mock Payment ก่อนเริ่มงาน`,
      relatedEntityType: "Job", relatedEntityId: job._id,
    });
  } catch (err) { console.error("Selection notification failed:", err); }

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

    // Refund completion is authoritative for Workers even if an older job record
    // still has an active/disputed status. Show it only in the cancelled tab.
    const refundedPayments = await Payment.find({ worker: req.user._id, status: "refunded" }).select("job").lean();
    const refundedJobIds = refundedPayments.map((payment) => payment.job);
    // Cancelled after assignment OR after application are both legitimate
    // cancelled jobs for that Worker. One job appears only once.
    const cancelledJobs = await Job.find({ selectedWorker: req.user._id, $or: [{ status: "cancelled" }, { _id: { $in: refundedJobIds } }] })
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
    disputed: ["disputed"],
    completed: ["completed"],
  };
  const jobStatuses = statusMap[status];
  if (!jobStatuses) return res.status(400).json({ message: "status ไม่ถูกต้อง" });

  const refundedPayments = await Payment.find({ worker: req.user._id, status: "refunded" }).select("job").lean();
  const refundedJobIds = refundedPayments.map((payment) => payment.job);
  const jobs = await Job.find({ selectedWorker: req.user._id, status: { $in: jobStatuses }, _id: { $nin: refundedJobIds } })
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
const PROOF_DIR = path.resolve(process.env.JOB_PROOF_DIR || path.join(__dirname, "..", "..", "uploads", "job-proofs"));
fs.mkdirSync(PROOF_DIR, { recursive: true });

// Validate before committing image bytes and the job state in the same transaction.
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
    if (!job) return res.status(404).json({ message: "Job not found." });
    if (String(job.selectedWorker) !== String(req.user._id)) {
      return res.status(403).json({ message: "You are not the selected Worker for this job." });
    }
    const allowedTransitions = { assigned: "in_progress", in_progress: "awaiting_confirmation" };
    if (allowedTransitions[job.status] !== next) {
      return res.status(409).json({ message: `Cannot change status from ${job.status} to ${next}.` });
    }
    if (next === "in_progress") {
      // No Worker can start until the Hirer has explicitly completed mock payment.
      const paid = await Payment.exists({ job: job._id, worker: req.user._id, status: "held",
        $or: [{ paymentMode: { $in: ["demo", "stripe_test", "slip_demo"] } }, { paymentMode: { $exists: false } }] });
      if (!paid) return res.status(409).json({ message: "รอ Hirer กดยืนยันการชำระเงินจำลองก่อนเริ่มงาน" });
    }
    if (next === "in_progress" && req.file) {
      return res.status(400).json({ message: "Do not attach a photo before starting the job." });
    }

    const fields = { status: next };
    if (next === "awaiting_confirmation") {
      if (!req.file) return res.status(400).json({ message: "Attach a completion photo before submitting the job." });
      const kind = detectProofImage(req.file.buffer);
      if (!kind || kind.mime !== req.file.mimetype) {
        return res.status(400).json({ message: "The image content does not match a supported JPG, PNG, or WebP file." });
      }
      const filename = `${job._id}-${randomUUID()}${kind.ext}`;
      fields.completionProofUrl = `/uploads/job-proofs/${filename}`;
      fields.completionProofStorage = "mongodb";
      fields.completionProofData = req.file.buffer;
      fields.proofSubmittedAt = new Date();
    }

    let updated;
    let notification;
    try {
      await withTransaction(async (session) => {
        updated = await Job.findOneAndUpdate(
          { _id: job._id, selectedWorker: req.user._id, status: job.status },
          { $set: fields },
          { new: true, runValidators: true, session }
        );
        if (!updated) {
          const conflict = new Error("Job status changed before the update completed.");
          conflict.code = "JOB_STATUS_CONFLICT";
          throw conflict;
        }
        await logJobStatusChange({
          jobId: updated._id, previousStatus: job.status, newStatus: next, changedBy: req.user._id, session,
        });
        notification = await createNotification({
          userId: updated.hirer,
          type: "job_status_change",
          title: next === "awaiting_confirmation" ? "Completion proof submitted" : "Worker started the job",
          message: next === "awaiting_confirmation"
            ? `Worker submitted proof for "${updated.title}". Please review and confirm.`
            : updated.title,
          relatedEntityType: "Job",
          relatedEntityId: updated._id,
        }, session);
      });
    } catch (err) {
      if (err.code === "JOB_STATUS_CONFLICT") {
        return res.status(409).json({ message: "Job status changed. Refresh and try again." });
      }
      throw err;
    }

    await deliverNotification(req.app.get("io"), notification);

    res.json({
      message: next === "awaiting_confirmation" ? "Proof submitted; waiting for Hirer confirmation." : "Job started.",
      job: updated,
    });
  }),
];

/** PATCH /api/jobs/:id/completion-proof — Worker can replace evidence until Hirer confirms. */
const replaceCompletionProof = [
  uploadProof,
  asyncHandler(async (req, res) => {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ message: "Job not found." });
    if (String(job.selectedWorker) !== String(req.user._id)) {
      return res.status(403).json({ message: "Only the selected Worker can replace this proof." });
    }
    if (job.status !== "awaiting_confirmation" || job.completionConfirmedAt) {
      return res.status(409).json({ message: "Proof can only be replaced before Hirer confirms completion." });
    }
    if (!req.file) return res.status(400).json({ message: "กรุณาเลือกรูปหลักฐานก่อนยืนยัน" });
    const kind = detectProofImage(req.file.buffer);
    if (!kind || kind.mime !== req.file.mimetype) {
      return res.status(400).json({ message: "ไฟล์ต้องเป็นรูป JPG, PNG หรือ WebP ที่ถูกต้อง" });
    }
    // Image bytes and their new version commit together in the existing database.
    // The CAS also races safely with Hirer confirmation.
    const newFilename = `${job._id}-${randomUUID()}${kind.ext}`;
    const newProofUrl = `/uploads/job-proofs/${newFilename}`;
    let updated;
    let notification;
    try {
      await withTransaction(async (session) => {
        updated = await Job.findOneAndUpdate(
          {
            _id: job._id, selectedWorker: req.user._id,
            status: "awaiting_confirmation", completionConfirmedAt: null,
            completionProofUrl: job.completionProofUrl,
          },
          { $set: { completionProofUrl: newProofUrl, completionProofStorage: "mongodb", completionProofData: req.file.buffer, proofSubmittedAt: new Date() } },
          { new: true, runValidators: true, session }
        );
        if (!updated) {
          const conflict = new Error("Proof update conflicts with job confirmation");
          conflict.code = "JOB_PROOF_CONFLICT";
          throw conflict;
        }
        await logJobStatusChange({
          jobId: updated._id, previousStatus: "awaiting_confirmation",
          newStatus: "awaiting_confirmation", changedBy: req.user._id,
          note: "Worker replaced completion proof", session,
        });
        notification = await createNotification({
          userId: updated.hirer,
          type: "job_status_change",
          title: "Completion proof updated",
          message: `Worker updated the photo for "${updated.title}". Please review the latest proof.`,
          relatedEntityType: "Job", relatedEntityId: updated._id,
        }, session);
      });
    } catch (err) {
      if (err.code === "JOB_PROOF_CONFLICT") {
        return res.status(409).json({ message: "Job has changed or Hirer confirmed it. Refresh and try again." });
      }
      throw err;
    }
    // Delete the replaced local file ONLY after the database commit. Preserve
    // older/non-local proof paths rather than following arbitrary file URLs.
    const matchOld = /^\/uploads\/job-proofs\/([a-zA-Z0-9_.-]+)$/.exec(job.completionProofUrl || "");
    if (matchOld && matchOld[1] !== "." && matchOld[1] !== ".." && matchOld[1] !== newFilename) {
      await fs.promises.unlink(path.join(PROOF_DIR, matchOld[1])).catch(() => {});
    }
    await deliverNotification(req.app.get("io"), notification);
    res.json({ message: "เปลี่ยนรูปหลักฐานเรียบร้อยแล้ว กำลังรอ Hirer ยืนยัน", job: updated });
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

  let content;
  try {
    content = await readCompletionProof(job);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
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
  if (!job) return res.status(404).json({ message: "Job not found." });
  if (String(job.hirer) !== String(req.user._id)) {
    return res.status(403).json({ message: "You are not the Hirer who owns this job." });
  }
  if (job.status === "completed" || job.completionConfirmedAt) {
    return res.status(409).json({ message: "This job has already been confirmed." });
  }
  if (job.status !== "awaiting_confirmation") {
    return res.status(409).json({ message: "This job is not waiting for confirmation." });
  }
  if (!job.completionProofUrl) {
    return res.status(400).json({ message: "No completion photo is attached to this job." });
  }

  let proofBytes;
  try {
    proofBytes = await readCompletionProof(job);
  } catch (err) {
    if (err.statusCode) {
      return res.status(409).json({ message: err.message });
    }
    throw err;
  }
  if (!detectProofImage(proofBytes)) {
    return res.status(409).json({ message: "Completion photo cannot be read as a supported image. Ask the Worker to submit the photo again." });
  }

  const confirmedAt = new Date();
  let updated;
  let payment;
  let notifications = [];
  try {
    await withTransaction(async (session) => {
      notifications = [];
      updated = await Job.findOneAndUpdate(
        {
          _id: job._id,
          hirer: req.user._id,
          status: "awaiting_confirmation",
          completionConfirmedAt: null,
          completionProofUrl: job.completionProofUrl,
        },
        { $set: { status: "completed", completionConfirmedAt: confirmedAt, completionConfirmedBy: req.user._id } },
        { new: true, runValidators: true, session }
      );
      if (!updated) {
        const conflict = new Error("Job was already confirmed or changed.");
        conflict.code = "JOB_CONFIRMATION_CONFLICT";
        throw conflict;
      }

      payment = await Payment.findOneAndUpdate(
        { job: updated._id, hirer: updated.hirer, worker: updated.selectedWorker, status: "held" },
        { $set: { status: "payout_pending", jobCompletedAt: confirmedAt, releasedAt: null, paidAt: null } },
        { new: true, runValidators: true, session }
      );
      if (!payment) {
        const missingPayment = new Error("The demo payment is not in held state.");
        missingPayment.code = "PAYMENT_NOT_HELD";
        throw missingPayment;
      }

      // Service Post quotas are concurrent, not lifetime totals. When a service-origin
      // job completes, release its slot; only reopen auto-capacity closures (never manual ones).
      if (updated.originServiceRequest) {
        const origin = await ServiceRequest.findById(updated.originServiceRequest).session(session);
        if (origin?.servicePost) {
          const servicePost = await ServicePost.findById(origin.servicePost).session(session);
          if (servicePost && servicePost.currentOrderCount > 0) {
            const reopen = servicePost.status === "closed" && servicePost.closeReason === "capacity" &&
              servicePost.availabilityEnd > new Date();
            const change = { $inc: { currentOrderCount: -1 } };
            if (reopen) change.$set = { status: "active", closeReason: null };
            await ServicePost.updateOne({ _id: servicePost._id, currentOrderCount: { $gt: 0 } }, change, { session });
          }
        }
      }

      await logJobStatusChange({
        jobId: updated._id,
        previousStatus: "awaiting_confirmation",
        newStatus: "completed",
        changedBy: req.user._id,
        session,
      });

      // Store delivery intents with the state change. Socket delivery runs after commit
      // and pending records are retried independently without confirming the job again.
      notifications.push(await createNotification({
        userId: updated.selectedWorker,
        type: "payment_update",
        title: "งานผ่านการตรวจรับแล้ว รอผู้ดูแลจ่ายค่าจ้าง",
        message: `งาน "${updated.title}" เสร็จแล้ว ค่าจ้างอยู่ระหว่างรอผู้ดูแลบันทึกจ่ายพร้อมสลิป (โหมดทดสอบ ไม่มีการโอนเงินจริง)`,
        relatedEntityType: "Job",
        relatedEntityId: updated._id,
      }, session));
      notifications.push(await createNotification({
        userId: updated.selectedWorker,
        type: "job_status_change",
        title: "Job confirmed as completed",
        message: `The Hirer confirmed "${updated.title}" as completed.`,
        relatedEntityType: "Job",
        relatedEntityId: updated._id,
      }, session));
    });
  } catch (err) {
    if (err.code === "JOB_CONFIRMATION_CONFLICT") {
      return res.status(409).json({ message: "This job was confirmed or changed by another request." });
    }
    if (err.code === "PAYMENT_NOT_HELD") {
      return res.status(409).json({ message: "The job payment is not held. The job was not changed." });
    }
    throw err;
  }

  const io = req.app.get("io");
  await Promise.all(notifications.map((notification) => deliverNotification(io, notification)));

  res.json({
    message: "ตรวจรับงานแล้ว รอ admin บันทึกจ่ายค่าจ้างพร้อมสลิป (โหมดทดสอบ ไม่มีการโอนเงินจริง)",
    job: updated,
    payment,
  });
});

module.exports = {
  createJob, getMyJobs, getJobById, getJobTimeline, cancelJob,
  getFeed, applyToJob, getApplicants, selectWorker, getMyWorkerJobs, updateJobStatus, confirmCompletion, getCompletionProof, replaceCompletionProof,
};
