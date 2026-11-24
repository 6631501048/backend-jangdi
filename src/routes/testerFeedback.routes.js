const router=require('express').Router();
const {protect}=require('../middleware/auth.middleware');
const {createRateLimiter}=require('../middleware/rateLimit.middleware');
const {createFeedback}=require('../controllers/testerFeedback.controller');
const limiter=createRateLimiter({windowMs:10*60*1000,max:10,keyFn:req=>String(req.user._id),message:'ส่งความคิดเห็นบ่อยเกินไป กรุณารอสักครู่'});
router.post('/',protect,limiter,createFeedback);
module.exports=router;
