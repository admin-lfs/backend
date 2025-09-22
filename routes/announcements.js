const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const supabase = require("../config/supabase");

// Get announcements for a user's organization
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { limit = 25, offset = 0, lastUpdated } = req.query;
    const userRole = req.user.role;
    const userOrgId = req.user.org_id;
    const userId = req.user.id;

    console.log("Announcements API - User role:", userRole);
    console.log("Announcements API - User org ID:", userOrgId);
    console.log("Announcements API - Last updated:", lastUpdated);

    let targetOrgId = userOrgId;

    // If user is a parent, get child's org_id
    if (userRole === "parent") {
      const { childId } = req.query;

      if (!childId) {
        return res.status(400).json({
          error: "Child ID is required for parents",
        });
      }

      // Validate child access
      return parentChildValidator(req, res, async () => {
        try {
          targetOrgId = req.validatedChild.orgId;
          await fetchAnnouncements(
            targetOrgId,
            limit,
            offset,
            lastUpdated,
            res
          );
        } catch (error) {
          console.error("Error fetching announcements for child:", error);
          res.status(500).json({ error: "Internal server error" });
        }
      });
    }

    // For faculty and students, use their own org_id
    await fetchAnnouncements(targetOrgId, limit, offset, lastUpdated, res);
  } catch (error) {
    console.error("Announcements API error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper function to fetch announcements
async function fetchAnnouncements(orgId, limit, offset, lastUpdated, res) {
  try {
    console.log("fetchAnnouncements - Org ID:", orgId);
    console.log("fetchAnnouncements - Last updated:", lastUpdated);

    let query = supabase
      .from("announcements")
      .select("*")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("updated_at", { ascending: false });

    // If lastUpdated is provided, only get announcements newer than that
    if (lastUpdated) {
      query = query.gt("updated_at", lastUpdated);
    }

    // Apply limit and offset
    query = query.range(
      parseInt(offset),
      parseInt(offset) + parseInt(limit) - 1
    );

    const { data: announcements, error: announcementsError } = await query;

    if (announcementsError) {
      console.error("Announcements query error:", announcementsError);
      return res.status(500).json({ error: "Failed to fetch announcements" });
    }

    console.log(
      "fetchAnnouncements - Found announcements:",
      announcements?.length || 0
    );

    res.json({
      success: true,
      announcements: announcements || [],
    });
  } catch (error) {
    console.error("Error in fetchAnnouncements:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = router;
