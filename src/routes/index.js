const router = require("express").Router();

router.use("/auth", require("./auth.routes"));
router.use("/users", require("./user.routes"));
router.use("/jobs", require("./job.routes"));
router.use("/service-posts", require("./servicePost.routes"));
router.use("/payments", require("./payment.routes"));
router.use("/sos", require("./sos.routes"));
router.use("/admin", require("./admin.routes"));

module.exports = router;
