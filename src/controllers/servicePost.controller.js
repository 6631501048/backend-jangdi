const { closeUnselectedRequests, presentServiceRequestOutcome } = require('../services/serviceRequestOutcome.service');
const { getActiveServiceOrderCounts, presentServiceCapacity } = require('../services/serviceCapacity.service');
const { withTransaction } = require('../services/transaction.service');
const { withRequestPaymentStates } = require('../services/workflowStatus.service');
const asyncHandler = require("express-async-handler");
const { ServicePost, ServiceRequest, Job, Payment } = require("../models");
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
  if (!posts.length) return res.json([]);

  // A service listing can be reopened when its last order finishes to release
  // its concurrent-order slot. Do not put that old listing back in public
  // feeds once it has completed all accepted work and has no pending requests.
  const requests = await ServiceRequest.find({
    servicePost: { $in: posts.map((post) => post._id) },
    $or: [{ status: "pending" }, { resultingJob: { $ne: null } }],
  })
    .populate("resultingJob", "status")
    .select("servicePost status resultingJob");
  const requestStates = new Map();
  for (const request of await withRequestPaymentStates(requests)) {
    const key = String(request.servicePost);
    const state = requestStates.get(key) || { pending: false, inProgress: false, completed: false };
    if (request.status === "pending") state.pending = true;
    const jobStatus = request.resultingJob?.status;
    if (["assigned", "in_progress", "awaiting_confirmation", "disputed"].includes(jobStatus)) state.inProgress = true;
    if (["completed", "cancelled"].includes(jobStatus)) state.completed = true;
    requestStates.set(key, state);
  }
  const visiblePosts = posts.filter((post) => {
    const state = requestStates.get(String(post._id));
    return !state?.completed || state.pending || state.inProgress;
  });
  res.json(visiblePosts);
});

/** GET /api/service-posts/:id */
const getServicePostById = asyncHandler(async (req, res) => {
  // Keep unpublished, rejected, closed and expired listings private. Public
  // detail links must follow the same visibility rule as the service feed.
  const post = await ServicePost.findOne({
    _id: req.params.id,
    status: "active",
    availabilityEnd: { $gte: new Date() },
  }).populate("worker", "fullName avatarUrl credibilityScore");
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
    category, serviceType, title, locationLabel, description, fee, maxSimultaneousOrders,
    availabilityStart, availabilityEnd, serviceRadiusMeters, lat, lng,
  } = req.body;

  if (!category || !title || !description || fee == null || !maxSimultaneousOrders || !availabilityStart || !availabilityEnd || lat == null || lng == null) {
    return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบ" });
  }
  if (category === "delivery" && !["shopping", "pickup_delivery", "passenger"].includes(serviceType || "shopping")) {
    return res.status(400).json({ message: "Unknown delivery service type." });
  }
  if (category !== "delivery" && !String(locationLabel || "").trim()) {
    return res.status(400).json({ message: "Please provide a service location." });
  }
  if (!Number.isInteger(Number(maxSimultaneousOrders)) || Number(maxSimultaneousOrders) < 1 || Number(maxSimultaneousOrders) > 3) {
    return res.status(400).json({ message: "จำนวนออร์เดอร์พร้อมกันต้องอยู่ระหว่าง 1 ถึง 3" });
  }
  if (!Number.isFinite(Number(fee)) || Number(fee) < 0 || category === "delivery" && Number(fee) <= 0) {
    return res.status(400).json({ message: "ค่าจ้างต่อออร์เดอร์ฝากหิ้วต้องมากกว่า 0 บาท" });
  }

  const post = await ServicePost.create({
    worker: req.user._id,
    category,
    serviceType: category === "delivery" ? (serviceType || "shopping") : null,
    title,
    locationLabel: String(locationLabel || "").trim(),
    description,
    fee,
    maxSimultaneousOrders,
    availabilityStart,
    availabilityEnd,
    serviceRadiusMeters: category === "delivery" ? (serviceRadiusMeters || 2000) : 0,
    location: { type: "Point", coordinates: [Number(lng), Number(lat)] },
    status: "pending_review",
  });

  res.status(201).json({ message: "ส่งประกาศบริการแล้ว รอผู้ดูแลตรวจสอบ", post });
});

/** GET /api/service-posts/my — ประกาศบริการของ worker ปัจจุบัน */
const getMyServicePosts = asyncHandler(async (req, res) => {
  const posts = await ServicePost.find({ worker: req.user._id }).sort({ createdAt: -1 });
  const counts = await getActiveServiceOrderCounts(posts.map(post => post._id));
  res.json(posts.map(post => presentServiceCapacity(post, counts.get(String(post._id)))));
});

/** POST /api/service-posts/:id/close — FR-SERV-03 */
const closeServicePost = asyncHandler(async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500) {
    return res.status(400).json({ message: "กรุณาระบุเหตุผลอย่างน้อย 5 ตัวอักษรและไม่เกิน 500 ตัวอักษร" });
  }
  const post = await ServicePost.findById(req.params.id);
  if (!post) return res.status(404).json({ message: "ไม่พบประกาศบริการนี้" });
  if (String(post.worker) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศนี้" });
  }
  if (post.status !== "active" || Date.now() - new Date(post.createdAt).getTime() < 5 * 60 * 1000) {
    return res.status(409).json({ message: "ขอยกเลิกได้หลังประกาศเปิดรับบริการครบ 5 นาที" });
  }
  if (await ServiceRequest.exists({ servicePost: post._id })) {
    return res.status(409).json({ message: "มีคำขอรับบริการเข้ามาแล้ว จึงไม่สามารถยกเลิกประกาศได้" });
  }
  post.status = "closed";
  post.closeReason = "manual";
  post.closeNote = reason;
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
  const fields = ["itemName", "from", "to", "requirements", "pickupLocation"];
  if (orderData && fields.some((field) => orderData[field] != null && (typeof orderData[field] !== "string" || orderData[field].length > 500))) {
    return res.status(400).json({ message: "ข้อมูลสถานที่/เวลา/รายละเอียดต้องเป็นข้อความไม่เกิน 500 ตัวอักษร" });
  }
  if (orderData?.itemBudget != null && (orderData.itemBudget === "" || !Number.isFinite(Number(orderData.itemBudget)) || Number(orderData.itemBudget) < 0)) {
    return res.status(400).json({ message: "งบประมาณสินค้าต้องเป็นจำนวนเงินที่ไม่ติดลบ" });
  }
  if (orderData?.passengerCount != null && (!Number.isInteger(Number(orderData.passengerCount)) || Number(orderData.passengerCount) < 1)) {
    return res.status(400).json({ message: "Passenger count must be a positive whole number." });
  }
  if (orderData?.serviceType != null && !["shopping", "pickup_delivery", "passenger"].includes(orderData.serviceType)) {
    return res.status(400).json({ message: "Unknown delivery service type." });
  }
  const post = await ServicePost.findById(req.params.id);
  if (!post) return res.status(404).json({ message: "ไม่พบประกาศบริการนี้" });

  if (String(post.worker) === String(req.user._id)) {
    return res.status(400).json({ message: "ไม่สามารถส่งคำขอไปยังประกาศของตัวเองได้" });
  }
  if (post.status !== "active" || post.availabilityEnd < new Date()) {
    return res.status(400).json({ message: "ประกาศบริการนี้ปิดรับคำขอแล้ว" }); // FR-SERV-02/03
  }
  if (post.category === "delivery") {
    const serviceType = post.serviceType || orderData?.serviceType || "shopping";
    const missingDetails = !orderData?.to?.trim() || (serviceType === "passenger"
      ? !Number.isInteger(Number(orderData?.passengerCount)) || Number(orderData.passengerCount) < 1
      : !orderData?.itemName?.trim() || !orderData?.requirements?.trim()) ||
      (serviceType !== "shopping" && !orderData?.pickupLocation?.trim());
    if (missingDetails) return res.status(400).json({ message: "Please provide the required details and locations for this service type." });
  }
  if (post.currentOrderCount >= post.maxSimultaneousOrders) {
    return res.status(400).json({ message: "ประกาศบริการนี้เต็มจำนวนออร์เดอร์แล้ว" }); // FR-SERV-06
  }

  const existingPending = await ServiceRequest.findOne({ servicePost: post._id, hirer: req.user._id, status: "pending" }).select("_id");
  if (existingPending) {
    return res.status(409).json({ message: "คุณส่งคำขอบริการนี้แล้ว กำลังรอผู้รับจ้างตอบรับ" });
  }

  const request = await ServiceRequest.create({
    servicePost: post._id,
    hirer: req.user._id,
    orderDetails: orderDetails.trim(),
    orderData: orderData ? {
      serviceType: post.serviceType || orderData.serviceType || null,
      itemName: (orderData.itemName || "").trim(),
      pickupLocation: (orderData.pickupLocation || "").trim(),
      passengerCount: orderData.passengerCount == null ? null : Number(orderData.passengerCount),
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
    .populate("servicePost", "title description category serviceType fee status availabilityEnd maxSimultaneousOrders currentOrderCount closeReason")
    .populate("hirer", "fullName avatarUrl")
    .populate("resultingJob", "_id status")
    .sort({ createdAt: -1 });
  res.json(await withRequestPaymentStates(requests));
});

/** GET /api/service-posts/requests/my-as-hirer — Hirer's own requests and accepted jobs. */
const getMyOutgoingRequests = asyncHandler(async (req, res) => {
  const requests = await ServiceRequest.find({ hirer: req.user._id })
    .populate("servicePost", "title status closeReason availabilityEnd fee category")
    .populate("resultingJob", "_id status")
    .sort({ createdAt: -1 });
  res.json((await withRequestPaymentStates(requests)).map(presentServiceRequestOutcome));
});

/** GET /api/service-posts/requests/:id — เจ้าของประกาศเท่านั้น */
const getIncomingRequestById = asyncHandler(async (req, res) => {
  if (!require("mongoose").isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Request ID ไม่ถูกต้อง" });
  }
  const request = await ServiceRequest.findById(req.params.id)
    .populate("servicePost", "worker title description category serviceType fee status availabilityEnd maxSimultaneousOrders currentOrderCount closeReason")
    .populate("hirer", "fullName avatarUrl")
    .populate("resultingJob", "_id status price");
  if (!request || !request.servicePost) return res.status(404).json({ message: "ไม่พบคำขอนี้" });
  if (String(request.servicePost.worker) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศบริการนี้" });
  }
  const [result] = await withRequestPaymentStates([request]);
  const counts = await getActiveServiceOrderCounts([request.servicePost._id]);
  result.servicePost = presentServiceCapacity(result.servicePost, counts.get(String(request.servicePost._id)));
  res.json(result);
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
  const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
  if (action === 'decline') {
    const declined = await ServiceRequest.findOneAndUpdate({ _id: request._id, status: 'pending' },
      { $set: { status: 'declined', declineReason: 'worker_declined', respondedAt: new Date() } }, { new: true, runValidators: true });
    if (!declined) throw conflict('คำขอนี้ได้รับการตอบรับไปแล้ว');
  } else {
    await withTransaction(async session => {
      const claimed = await ServiceRequest.findOneAndUpdate({ _id: request._id, status: 'pending' },
        { $set: { status: 'accepted', respondedAt: new Date() } }, { new: true, runValidators: true, session });
      if (!claimed) throw conflict('คำขอนี้ได้รับการตอบรับไปแล้ว');

      // Writing this shared post serializes all accept attempts for the same listing.
      // Transaction retries recount work after another accept/complete/refund commits.
      const post = await ServicePost.findOneAndUpdate({
        _id: request.servicePost._id, worker: req.user._id, availabilityEnd: { $gte: new Date() },
        $or: [{ status: 'active' }, { status: 'closed', closeReason: 'capacity' }],
      }, { $inc: { currentOrderCount: 1 } }, { new: true, runValidators: true, session });
      if (!post) throw conflict('ประกาศปิดรับหรือหมดเวลาแล้ว ไม่สามารถรับงานเพิ่มได้');
      const limit = Number(post.maxSimultaneousOrders);
      if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw conflict('จำนวนงานสูงสุดของประกาศไม่ถูกต้อง');
      const counts = await getActiveServiceOrderCounts([post._id], session);
      const activeCount = counts.get(String(post._id)) || 0;
      if (activeCount >= limit) throw conflict(`โพสต์นี้รับงานพร้อมกันได้สูงสุด ${limit} งาน ขณะนี้มี ${activeCount} งานที่ยังไม่จบ`);

      const [job] = await Job.create([{
        hirer: request.hirer, category: post.category, title: post.title,
        description: request.orderDetails || post.description,
        fromText: request.orderData?.pickupLocation || request.orderData?.from || post.title,
        toText: request.orderData?.to || '', notes: request.orderData?.requirements || '',
        price: post.fee, scheduledAt: new Date(), location: post.location, contentFilterPassed: true,
        status: 'assigned', selectedWorker: post.worker, originServiceRequest: request._id,
      }], { session });
      const feeBreakdown = require('../services/paymentTerms.service').calculateCombinedFees(Number(post.fee), { deliveryService: post.category === 'delivery' });
      await Payment.create([{
        job: job._id, hirer: request.hirer, worker: post.worker, amount: post.fee,
        platformFeePercent: feeBreakdown.appPercent, platformFeeAmount: feeBreakdown.platformFeeAmount,
        platformFeeFixedAmount: feeBreakdown.appFixed, netAmountToWorker: post.fee, status: 'pending', paymentMode: 'slip_demo',
        gatewayFeeAmount: feeBreakdown.gatewayFeeAmount, mockGatewayFeeAmount: feeBreakdown.gatewayFeeAmount,
        mockGatewayFeePercent: feeBreakdown.gatewayPercent, mockGatewayFeeFixedAmount: feeBreakdown.gatewayFixed,
      }], { session });
      await ServiceRequest.updateOne({ _id: request._id, status: 'accepted' }, { $set: { resultingJob: job._id } }, { session });
      const nextCount = activeCount + 1;
      await ServicePost.updateOne({ _id: post._id }, { $set: {
        currentOrderCount: nextCount, status: nextCount >= limit ? 'closed' : 'active', closeReason: nextCount >= limit ? 'capacity' : null,
      } }, { session });
      if (nextCount >= limit) await closeUnselectedRequests(post._id, 'capacity', session);
      await logJobStatusChange({ jobId: job._id, previousStatus: null, newStatus: 'assigned', changedBy: req.user._id,
        note: `แปลงมาจาก Service Request ${request._id}`, session });
    });
  }

  const updated = await ServiceRequest.findById(request._id);
  const acceptedJobId = action === "accept" ? updated?.resultingJob : null;
  await notifyUser(req.app.get("io"), {
    userId: request.hirer,
    type: action === "accept" ? "payment_update" : "application_update",
    title: action === "accept" ? "ผู้รับจ้างรับคำขอแล้ว กรุณาชำระเงิน" : "คำขอบริการของคุณถูกปฏิเสธ",
    message: request.servicePost.title,
    relatedEntityType: acceptedJobId ? "Job" : "ServiceRequestResult",
    relatedEntityId: acceptedJobId || request._id,
  });

  res.json({ message: `${action === "accept" ? "ยอมรับ" : "ปฏิเสธ"}คำขอสำเร็จ`, request: updated });
});

module.exports = {
  getServicePosts, getServicePostById, createServicePost, getMyServicePosts, closeServicePost,
  sendServiceRequest, getMyIncomingRequests, getMyOutgoingRequests, getIncomingRequestById, respondToServiceRequest,
};
