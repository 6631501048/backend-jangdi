require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const connectDB = require("./src/config/db");
const app = require("./src/app");

const PORT = process.env.PORT || 4000;

connectDB();

const server = http.createServer(app);

// FR-NOTIF-01 / §5.4: real-time notification channel (WebSocket)
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || "*" },
});

io.on("connection", (socket) => {
  // Client ควร emit "register" พร้อม userId หลัง login เพื่อ join ห้องส่วนตัว
  socket.on("register", (userId) => {
    if (userId) socket.join(`user:${userId}`);
  });
});

// แชร์ instance ของ io ให้ controller อื่นเรียกใช้ผ่าน req.app.get("io")
app.set("io", io);

server.listen(PORT, () => {
  console.log(`JangDi API listening on port ${PORT}`);
});
