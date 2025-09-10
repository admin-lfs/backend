const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");

router.post(
  "/sync",
  authenticateToken,
  parentChildValidator,
  async (req, res) => {
    try {
      const { lastSyncTime, limit = 10, offset = 0 } = req.body;
      const { orgId } = req.validatedChild;

      let query = supabase
        .from("announcements")
        .select("id, title, description, priority, created_at, updated_at")
        .eq("org_id", orgId)
        .eq("is_active", true);

      if (lastSyncTime) {
        // Incremental sync - only new/updated announcements
        query = query
          .gt("updated_at", lastSyncTime)
          .order("updated_at", { ascending: false });
      } else {
        // Full sync - all announcements
        query = query.order("created_at", { ascending: false });
      }

      // Apply pagination
      query = query.range(offset, offset + limit - 1);

      const { data: announcements, error } = await query;

      if (error) {
        console.error("Database error:", error);
        return res.status(500).json({ error: "Failed to fetch announcements" });
      }

      res.json({
        announcements,
        hasMore: announcements.length === limit,
        syncTime: new Date().toISOString(),
        isFirstSync: !lastSyncTime,
      });
    } catch (error) {
      console.error("Sync announcements error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
