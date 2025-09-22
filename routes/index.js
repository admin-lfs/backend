const express = require("express");
const authRoutes = require("./auth");
const userRoutes = require("./user");
const groupsRoutes = require("./groups");
const messagesRoutes = require("./messages");
const groupMembersRoutes = require("./groupMembers");
const examsRoutes = require("./exams");
const gradesRoutes = require("./grades");
const eventsRoutes = require("./events");
const attendanceRoutes = require("./attendance");
const announcementsRoutes = require("./announcements");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/groups", groupsRoutes);
router.use("/messages", messagesRoutes);
router.use("/groups", groupMembersRoutes);
router.use("/groups", examsRoutes);
router.use("/groups", gradesRoutes);
router.use("/groups", eventsRoutes);
router.use("/events", eventsRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/announcements", announcementsRoutes);

module.exports = router;
