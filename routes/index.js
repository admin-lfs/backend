const express = require("express");
const router = express.Router();

const authRoutes = require("./auth");
const userRoutes = require("./user");
const groupsRoutes = require("./groups");

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/groups", groupsRoutes);

module.exports = router;
