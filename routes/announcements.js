const express = require("express");
const supabase = require("../config/supabase");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// Middleware to ensure only admins can access
router.use(authenticateToken);
router.use((req, res, next) => {
  if (req.user.role !== "admin") {
    return res
      .status(403)
      .json({ error: "Access denied. Only admins can perform this action." });
  }
  next();
});

// Get announcements for organization with pagination
router.get("/", async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Get today's date for filtering
    const today = new Date().toISOString().split("T")[0];

    // Get total count
    const { count, error: countError } = await supabase
      .from("announcements")
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("is_active", true)
      .gte("created_at", today);

    if (countError) {
      console.error("Count error:", countError);
      return res
        .status(500)
        .json({ error: "Failed to fetch announcements count" });
    }

    // Get announcements with pagination
    const { data: announcements, error } = await supabase
      .from("announcements")
      .select("*")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .gte("created_at", today)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error("Announcements fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch announcements" });
    }

    const totalPages = Math.ceil(count / limit);

    res.json({
      success: true,
      announcements: announcements || [],
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: count,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error("Get announcements error:", error);
    res.status(500).json({ error: "Failed to fetch announcements" });
  }
});

// Create new announcement
router.post("/", async (req, res) => {
  try {
    const { title, description, priority = "normal" } = req.body;
    const orgId = req.user.org_id;

    // Validation
    if (!title || !description) {
      return res
        .status(400)
        .json({ error: "Title and description are required" });
    }

    if (title.length > 255) {
      return res
        .status(400)
        .json({ error: "Title must be 255 characters or less" });
    }

    const validPriorities = ["low", "normal", "high", "urgent"];
    if (!validPriorities.includes(priority)) {
      return res
        .status(400)
        .json({
          error: "Invalid priority. Must be one of: low, normal, high, urgent",
        });
    }

    // Create announcement
    const { data: announcement, error } = await supabase
      .from("announcements")
      .insert([
        {
          org_id: orgId,
          title: title.trim(),
          description: description.trim(),
          priority,
          is_active: true,
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("Create announcement error:", error);
      return res.status(500).json({ error: "Failed to create announcement" });
    }

    res.status(201).json({
      success: true,
      message: "Announcement created successfully",
      announcement,
    });
  } catch (error) {
    console.error("Create announcement error:", error);
    res.status(500).json({ error: "Failed to create announcement" });
  }
});

// Update announcement
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, priority } = req.body;
    const orgId = req.user.org_id;

    // Validation
    if (title && title.length > 255) {
      return res
        .status(400)
        .json({ error: "Title must be 255 characters or less" });
    }

    if (priority) {
      const validPriorities = ["low", "normal", "high", "urgent"];
      if (!validPriorities.includes(priority)) {
        return res
          .status(400)
          .json({
            error:
              "Invalid priority. Must be one of: low, normal, high, urgent",
          });
      }
    }

    // Check if announcement exists and belongs to organization
    const { data: existingAnnouncement, error: fetchError } = await supabase
      .from("announcements")
      .select("*")
      .eq("id", id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !existingAnnouncement) {
      return res.status(404).json({ error: "Announcement not found" });
    }

    // Update announcement
    const updateData = {};
    if (title !== undefined) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (priority !== undefined) updateData.priority = priority;
    updateData.updated_at = new Date().toISOString();

    const { data: announcement, error } = await supabase
      .from("announcements")
      .update(updateData)
      .eq("id", id)
      .eq("org_id", orgId)
      .select()
      .single();

    if (error) {
      console.error("Update announcement error:", error);
      return res.status(500).json({ error: "Failed to update announcement" });
    }

    res.json({
      success: true,
      message: "Announcement updated successfully",
      announcement,
    });
  } catch (error) {
    console.error("Update announcement error:", error);
    res.status(500).json({ error: "Failed to update announcement" });
  }
});

// Delete announcement (soft delete by setting is_active to false)
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.org_id;

    // Check if announcement exists and belongs to organization
    const { data: existingAnnouncement, error: fetchError } = await supabase
      .from("announcements")
      .select("*")
      .eq("id", id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !existingAnnouncement) {
      return res.status(404).json({ error: "Announcement not found" });
    }

    // Soft delete announcement
    const { error } = await supabase
      .from("announcements")
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("org_id", orgId);

    if (error) {
      console.error("Delete announcement error:", error);
      return res.status(500).json({ error: "Failed to delete announcement" });
    }

    res.json({
      success: true,
      message: "Announcement deleted successfully",
    });
  } catch (error) {
    console.error("Delete announcement error:", error);
    res.status(500).json({ error: "Failed to delete announcement" });
  }
});

module.exports = router;
