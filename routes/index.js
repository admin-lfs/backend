const express = require("express");
const authRoutes = require("./auth");
const userRoutes = require("./user");
const groupsRoutes = require("./groups");
const messagesRoutes = require("./messages");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/groups", groupsRoutes);
router.use("/messages", messagesRoutes);

module.exports = router;
