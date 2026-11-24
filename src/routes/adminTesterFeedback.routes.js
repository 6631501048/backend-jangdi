const router=require('express').Router();
const {protect,adminOnly}=require('../middleware/auth.middleware');
const {listFeedback,markRead}=require('../controllers/testerFeedback.controller');
router.use(protect,adminOnly);
router.get('/',listFeedback);
router.patch('/:id/read',markRead);
module.exports=router;
