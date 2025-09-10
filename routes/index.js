const express = require("express");
const router = express.Router();

const authRoutes = require("./auth");
const userRoutes = require("./user");
const announcementRoutes = require("./announcements");

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/announcements", announcementRoutes);

module.exports = router;
