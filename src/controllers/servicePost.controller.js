const asyncHandler = require("express-async-handler");
const { ServicePost, ServiceRequest, Job } = require("../models");
const { logJobStatusChange } = require("../services/jobLog.service");
const { notifyUser } = require("../services/notification.service");

/**
 * GET /api/service-posts?category=...
 * FR-BROWSE-01/02, FR-SERV-04: ดู Service Post ที่ยังใช้งานอยู่ (สำหรับ Hirer เรียกดู)
 */
const getServicePosts = asyncHandler(async (req, res) => {
  const { category } = req.query;
  const query = { status: "active", availabilityEnd: { $gte: new Date() } };
  if (category && category !== "all") query.category = category;

  const posts = await ServicePost.find(query)
    .populate("worker", "fullName avatarUrl credibilityScore")
    .sort({ createdAt: -1 });
  res.json(posts);
});

/** GET /api/service-posts/:id */
const getServicePostById = asyncHandler(async (req, res) => {
  const post = await ServicePost.findById(req.params.id).populate("worker", "fullName avatarUrl credibilityScore");
  if (!post) return res.status(404).json({ message: "ไม่พบประกาศบริการนี้" });
  res.json(post);
});

/**
 * POST /api/service-posts — FR-SERV-01
 * body: { category, title, description, fee, maxSimultaneousOrders, availabilityStart, availabilityEnd,
 *         serviceRadiusMeters, lat, lng }
 */
const createServicePost = asyncHandler(async (req, res) => {
  const {
    category, title, description, fee, maxSimultaneousOrders,
    availabilityStart, availabilityEnd, serviceRadiusMeters, lat, lng,
  } = req.body;

  if (!category || !title || !description || fee == null || !maxSimultaneousOrders || !availabilityStart || !availabilityEnd || lat == null || lng == null) {
    return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบ" });
  }

  const post = await ServicePost.create({
    worker: req.user._id,
    category,
    title,
    description,
    fee,
    maxSimultaneousOrders,
    availabilityStart,
    availabilityEnd,
    serviceRadiusMeters: serviceRadiusMeters || 2000,
    location: { type: "Point", coordinates: [Number(lng), Number(lat)] },
  });

  res.status(201).json({ message: "สร้างประกาศบริการสำเร็จ", post });
});

/** GET /api/service-posts/my — ประกาศบริการของ worker ปัจจุบัน */
const getMyServicePosts = asyncHandler(async (req, res) => {
  const posts = await ServicePost.find({ worker: req.user._id }).sort({ createdAt: -1 });
  res.json(posts);
});

/** POST /api/service-posts/:id/close — FR-SERV-03 */
const closeServicePost = asyncHandler(async (req, res) => {
  const post = await ServicePost.findById(req.params.id);
  if (!post) return res.status(404).json({ message: "ไม่พบประกาศบริการนี้" });
  if (String(post.worker) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศนี้" });
  }
  post.status = "closed";
  await post.save();
  res.json({ message: "ปิดประกาศบริการสำเร็จ", post });
});

/**
 * POST /api/service-posts/:id/requests — FR-SERV-04, FR-SERV-06
 * body: { orderDetails }
 */
const sendServiceRequest = asyncHandler(async (req, res) => {
  const { orderDetails } = req.body;
  const post = await ServicePost.findById(req.params.id);
  if (!post) return res.status(404).json({ message: "ไม่พบประกาศบริการนี้" });

  if (String(post.worker) === String(req.user._id)) {
    return res.status(400).json({ message: "ไม่สามารถส่งคำขอไปยังประกาศของตัวเองได้" });
  }
  if (post.status !== "active" || post.availabilityEnd < new Date()) {
    return res.status(400).json({ message: "ประกาศบริการนี้ปิดรับคำขอแล้ว" }); // FR-SERV-02/03
  }
  if (post.currentOrderCount >= post.maxSimultaneousOrders) {
    return res.status(400).json({ message: "ประกาศบริการนี้เต็มจำนวนออร์เดอร์แล้ว" }); // FR-SERV-06
  }

  const request = await ServiceRequest.create({
    servicePost: post._id,
    hirer: req.user._id,
    orderDetails: orderDetails || "",
  });

  await notifyUser(req.app.get("io"), {
    userId: post.worker,
    type: "application_update",
    title: "มีคำขอบริการใหม่",
    message: post.title,
    relatedEntityType: "ServiceRequest",
    relatedEntityId: request._id,
  });

  res.status(201).json({ message: "ส่งคำขอบริการสำเร็จ รอผู้รับจ้างตอบรับ", request });
});

/** GET /api/service-posts/requests/my-as-worker — คำขอที่เข้ามายัง Service Post ของ worker ปัจจุบัน */
const getMyIncomingRequests = asyncHandler(async (req, res) => {
  const myPosts = await ServicePost.find({ worker: req.user._id }).select("_id");
  const requests = await ServiceRequest.find({ servicePost: { $in: myPosts.map((p) => p._id) } })
    .populate("servicePost", "title fee")
    .populate("hirer", "fullName avatarUrl")
    .sort({ createdAt: -1 });
  res.json(requests);
});

/**
 * PATCH /api/service-posts/requests/:id — FR-SERV-05, FR-SERV-07, FR-PAY-01
 * body: { action: "accept" | "decline" }
 * accept -> แปลงเป็น Job จริง + เปิด Payment (held ทันที เหมือน selectWorker — ดูหมายเหตุใน job.controller.js)
 */
const respondToServiceRequest = asyncHandler(async (req, res) => {
  const { action } = req.body;
  if (!["accept", "decline"].includes(action)) {
    return res.status(400).json({ message: "action ต้องเป็น accept หรือ decline" });
  }

  const request = await ServiceRequest.findById(req.params.id).populate("servicePost");
  if (!request) return res.status(404).json({ message: "ไม่พบคำขอนี้" });
  if (String(request.servicePost.worker) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศบริการนี้" });
  }
  if (request.status !== "pending") {
    return res.status(400).json({ message: `คำขอนี้ถูกตอบรับ/ปฏิเสธไปแล้ว (สถานะ: ${request.status})` });
  }

  request.status = action === "accept" ? "accepted" : "declined";
  request.respondedAt = new Date();

  if (action === "accept") {
    const post = request.servicePost;

    // FR-SERV-07: แปลง Service Request เป็น Job จริง เชื่อมโยงกับ Service Post ต้นทาง
    const { Payment } = require("../models");
    const job = await Job.create({
      hirer: request.hirer,
      category: post.category,
      title: post.title,
      description: request.orderDetails || post.description,
      price: post.fee,
      scheduledAt: new Date(),
      location: post.location,
      contentFilterPassed: true,
      status: "assigned",
      selectedWorker: post.worker,
      originServiceRequest: request._id,
    });
    request.resultingJob = job._id;

    await logJobStatusChange({
      jobId: job._id,
      previousStatus: null,
      newStatus: "assigned",
      changedBy: req.user._id,
      note: `แปลงมาจาก Service Request ${request._id}`,
    });

    // FR-PAY-01: เปิด Payment เข้าสถานะ held ทันที (เหตุผลเดียวกับ selectWorker ใน job.controller.js)
    const feePercent = Number(process.env.ESCROW_FEE_PERCENT_MIN) || 5;
    const feeAmount = Math.round((post.fee * feePercent) / 100);
    await Payment.create({
      job: job._id,
      hirer: request.hirer,
      worker: post.worker,
      amount: post.fee,
      platformFeePercent: feePercent,
      platformFeeAmount: feeAmount,
      netAmountToWorker: post.fee - feeAmount,
      status: "held",
      heldAt: new Date(),
    });

    post.currentOrderCount += 1;
    if (post.currentOrderCount >= post.maxSimultaneousOrders) post.status = "closed"; // FR-SERV-06
    await post.save();
  }

  await request.save();

  await notifyUser(req.app.get("io"), {
    userId: request.hirer,
    type: "application_update",
    title: action === "accept" ? "คำขอบริการของคุณได้รับการยอมรับ" : "คำขอบริการของคุณถูกปฏิเสธ",
    message: request.servicePost.title,
    relatedEntityType: "ServiceRequest",
    relatedEntityId: request._id,
  });

  res.json({ message: `${action === "accept" ? "ยอมรับ" : "ปฏิเสธ"}คำขอสำเร็จ`, request });
});

module.exports = {
  getServicePosts, getServicePostById, createServicePost, getMyServicePosts, closeServicePost,
  sendServiceRequest, getMyIncomingRequests, respondToServiceRequest,
};