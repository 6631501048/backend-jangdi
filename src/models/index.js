// รวม export ของทุก model เพื่อ import ได้สั้นลง เช่น const { User, Job } = require("../models");
module.exports = {
  User: require("./User"),
  Job: require("./Job"),
  JobWaiting: require("./JobWaiting"),
  ServicePost: require("./ServicePost"),
  ServiceRequest: require("./ServiceRequest"),
  Payment: require("./Payment"),
  Feedback: require("./Feedback"),
  Notification: require("./Notification"),
  Sos: require("./Sos"),
  Report: require("./Report"),
  JobLog: require("./JobLog"),
};
