const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const routes = require("./routes");
const { notFound, errorHandler } = require("./middleware/error.middleware");

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL || "*" }));
app.use(express.json());
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
