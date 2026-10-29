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
  post.closeReason = "manual";
  await post.save();
  res.json({ message: "ปิดประกาศบริการสำเร็จ", post });
});

/**
 * POST /api/service-posts/:id/requests — FR-SERV-04, FR-SERV-06
 * body: { orderDetails }
 */
const sendServiceRequest = asyncHandler(async (req, res) => {
  const { orderDetails, orderData } = req.body;
  if (typeof orderDetails !== "string" || !orderDetails.trim() || orderDetails.trim().length > 2000) {
    return res.status(400).json({ message: "กรุณากรอกรายละเอียดคำขอ (ไม่เกิน 2000 ตัวอักษร)" });
  }
  if (orderData != null && (typeof orderData !== "object" || Array.isArray(orderData))) {
    return res.status(400).json({ message: "ข้อมูลคำขอไม่ถูกต้อง" });
  }
  const fields = ["from", "to", "estimatedDelivery", "requirements"];
  if (orderData && fields.some((field) => orderData[field] != null && (typeof orderData[field] !== "string" || orderData[field].length > 500))) {
    return res.status(400).json({ message: "ข้อมูลสถานที่/เวลา/รายละเอียดต้องเป็นข้อความไม่เกิน 500 ตัวอักษร" });
  }
  if (orderData?.itemBudget != null && (orderData.itemBudget === "" || !Number.isFinite(Number(orderData.itemBudget)) || Number(orderData.itemBudget) < 0)) {
    return res.status(400).json({ message: "งบประมาณสินค้าต้องเป็นจำนวนเงินที่ไม่ติดลบ" });
  }
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
    orderDetails: orderDetails.trim(),
    orderData: orderData ? {
      from: (orderData.from || "").trim(),
      to: (orderData.to || "").trim(),
      estimatedDelivery: (orderData.estimatedDelivery || "").trim(),
      requirements: (orderData.requirements || "").trim(),
      itemBudget: orderData.itemBudget == null ? null : Number(orderData.itemBudget),
    } : undefined,
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
    .populate("servicePost", "title description fee status availabilityEnd maxSimultaneousOrders currentOrderCount")
    .populate("hirer", "fullName avatarUrl")
    .sort({ createdAt: -1 });
  res.json(requests);
});

/** GET /api/service-posts/requests/:id — เจ้าของประกาศเท่านั้น */
const getIncomingRequestById = asyncHandler(async (req, res) => {
  if (!require("mongoose").isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Request ID ไม่ถูกต้อง" });
  }
  const request = await ServiceRequest.findById(req.params.id)
    .populate("servicePost", "worker title description fee status availabilityEnd maxSimultaneousOrders currentOrderCount")
    .populate("hirer", "fullName avatarUrl")
    .populate("resultingJob", "_id status price");
  if (!request || !request.servicePost) return res.status(404).json({ message: "ไม่พบคำขอนี้" });
  if (String(request.servicePost.worker) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศบริการนี้" });
  }
  res.json(request);
});

/**
 * PATCH /api/service-posts/requests/:id — FR-SERV-05, FR-SERV-07, FR-PAY-01
 * body: { action: "accept" | "decline" }
 * accept -> creates an assigned Job with a pending DEMO payment; Hirer confirms payment in My Jobs.
 */
const respondToServiceRequest = asyncHandler(async (req, res) => {
  const { action } = req.body;
  if (!["accept", "decline"].includes(action)) {
    return res.status(400).json({ message: "action ต้องเป็น accept หรือ decline" });
  }

  const request = await ServiceRequest.findById(req.params.id).populate("servicePost");
  if (!request || !request.servicePost) return res.status(404).json({ message: "ไม่พบคำขอนี้หรือประกาศถูกลบ" });
  if (String(request.servicePost.worker) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศบริการนี้" });
  }
  if (request.status !== "pending") {
    return res.status(409).json({ message: `คำขอนี้ถูกตอบรับ/ปฏิเสธไปแล้ว (สถานะ: ${request.status})` });
  }
  if (action === "accept" && (request.servicePost.status !== "active" || request.servicePost.availabilityEnd < new Date() ||
      request.servicePost.currentOrderCount >= request.servicePost.maxSimultaneousOrders)) {
    return res.status(409).json({ message: "ประกาศปิดรับหรือเต็มแล้ว ไม่สามารถยอมรับคำขอเพิ่ม" });
  }

  // Claim the request only once. Two simultaneous accept/decline calls cannot both succeed.
  const newStatus = action === "accept" ? "accepted" : "declined";
  const claimed = await ServiceRequest.findOneAndUpdate(
    { _id: request._id, status: "pending" },
    { $set: { status: newStatus, respondedAt: new Date() } },
    { new: true, runValidators: true }
  );
  if (!claimed) return res.status(409).json({ message: "คำขอนี้ได้รับการตอบรับไปแล้ว" });

  if (action === "accept") {
    const post = request.servicePost;
    const now = new Date();
    // Atomic capacity reservation, including expiry and close. Avoid two Workers/orders overbooking.
    let reserved;
    try {
      reserved = await ServicePost.findOneAndUpdate(
        { _id: post._id, status: "active", availabilityEnd: { $gte: now },
          $expr: { $lt: ["$currentOrderCount", "$maxSimultaneousOrders"] } },
        { $inc: { currentOrderCount: 1 } },
        { new: true, runValidators: true }
      );
    } catch (err) {
      await ServiceRequest.updateOne({ _id: request._id, status: "accepted" },
        { $set: { status: "pending", respondedAt: null } }).catch(() => {});
      throw err;
    }
    if (!reserved) {
      await ServiceRequest.updateOne({ _id: request._id, status: "accepted" },
        { $set: { status: "pending", respondedAt: null } });
      return res.status(409).json({ message: "ประกาศบริการปิดรับหรือเต็มแล้ว" });
    }

    const { Payment } = require("../models");
    let job = null;
    try {
      // The Job keeps the service-request reference and actual delivery details.
      job = await Job.create({
        hirer: request.hirer,
        category: post.category,
        title: post.title,
        description: request.orderDetails || post.description,
        fromText: request.orderData?.from || post.title,
        toText: request.orderData?.to || "",
        notes: request.orderData?.requirements || "",
        price: post.fee, // Demo payment tracks worker fee only. Item budget is a separate estimate.
        scheduledAt: new Date(),
        location: post.location,
        contentFilterPassed: true,
        status: "assigned",
        selectedWorker: post.worker,
        originServiceRequest: request._id,
      });
      const configPercent = Number(process.env.ESCROW_FEE_PERCENT_MIN);
      const feePercent = configPercent >= 5 && configPercent <= 10 ? configPercent : 5;
      const feeAmount = Math.round(Number(post.fee) * feePercent) / 100;
      await Payment.create({
        job: job._id, hirer: request.hirer, worker: post.worker,
        amount: post.fee, platformFeePercent: feePercent,
        platformFeeAmount: feeAmount, netAmountToWorker: post.fee,
        status: "pending", paymentMode: "demo",
      });
      await ServiceRequest.updateOne({ _id: request._id, status: "accepted" },
        { $set: { resultingJob: job._id } });
      if (reserved.currentOrderCount >= reserved.maxSimultaneousOrders) {
        await ServicePost.updateOne({ _id: post._id, status: "active" }, { $set: { status: "closed", closeReason: "capacity" } });
      }
      await logJobStatusChange({
        jobId: job._id, previousStatus: null, newStatus: "assigned",
        changedBy: req.user._id, note: `แปลงมาจาก Service Request ${request._id}`,
      });
    } catch (err) {
      // Best-effort rollback for partial failures; an Atlas multi-document transaction
      // would be needed for guarantees across an unexpected process crash.
      if (job) {
        await Payment.deleteOne({ job: job._id }).catch(() => {});
        await Job.deleteOne({ _id: job._id }).catch(() => {});
      }
      await ServicePost.updateOne({ _id: post._id }, { $inc: { currentOrderCount: -1 }, $set: { status: "active", closeReason: null } }).catch(() => {});
      await ServiceRequest.updateOne({ _id: request._id, status: "accepted" },
        { $set: { status: "pending", respondedAt: null, resultingJob: null } }).catch(() => {});
      throw err;
    }
  }

  await notifyUser(req.app.get("io"), {
    userId: request.hirer,
    type: "application_update",
    title: action === "accept" ? "คำขอบริการของคุณได้รับการยอมรับ" : "คำขอบริการของคุณถูกปฏิเสธ",
    message: request.servicePost.title,
    relatedEntityType: "ServiceRequest",
    relatedEntityId: request._id,
  });

  const updated = await ServiceRequest.findById(request._id);
  res.json({ message: `${action === "accept" ? "ยอมรับ" : "ปฏิเสธ"}คำขอสำเร็จ`, request: updated });
});

module.exports = {
  getServicePosts, getServicePostById, createServicePost, getMyServicePosts, closeServicePost,
  sendServiceRequest, getMyIncomingRequests, getIncomingRequestById, respondToServiceRequest,
};