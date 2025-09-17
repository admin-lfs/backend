const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const supabase = require("../config/supabase");

// Get events for a group
router.get("/:groupId/events", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { page = 1, limit = 20, from_date, to_date } = req.query;
    const offset = (page - 1) * limit;

    // Check access to group
    const { data: userGroup, error: userGroupError } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("group_id", groupId)
      .eq("is_active", true)
      .single();

    if (userGroupError || !userGroup) {
      return res.status(403).json({
        success: false,
        message: "Access denied to this group",
      });
    }

    let query = supabase
      .from("events")
      .select(
        `
        *,
        created_by_user:users!events_created_by_fkey(full_name)
      `
      )
      .eq("group_id", groupId)
      .eq("is_active", true);

    // Only show future events by default
    if (!from_date) {
      query = query.gte("event_date", new Date().toISOString().split("T")[0]);
    } else {
      query = query.gte("event_date", from_date);
    }

    if (to_date) {
      query = query.lte("event_date", to_date);
    }

    const { data: events, error } = await query
      .range(offset, offset + limit - 1)
      .order("event_date", { ascending: true });

    if (error) {
      console.error("Error fetching events:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching events",
      });
    }

    res.json({
      success: true,
      events: events || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        hasMore: events.length === parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching events:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Create new event
router.post("/:groupId/events", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { event_title, event_description, event_date } = req.body;

    // Check if user is a teacher in this group
    const { data: userGroup, error: userGroupError } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", req.user.id)
      .eq("group_id", groupId)
      .eq("member_type", "teacher")
      .eq("is_active", true)
      .single();

    if (userGroupError || !userGroup) {
      return res.status(403).json({
        success: false,
        message: "Only teachers can create events",
      });
    }

    // Validate description length
    if (event_description.length > 250) {
      return res.status(400).json({
        success: false,
        message: "Event description cannot exceed 250 characters",
      });
    }

    const { data: event, error } = await supabase
      .from("events")
      .insert({
        group_id: groupId,
        org_id: req.user.org_id,
        event_title: event_title,
        event_description: event_description,
        event_date: event_date,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) {
      console.error("Error creating event:", error);
      return res.status(500).json({
        success: false,
        message: "Error creating event",
      });
    }

    res.json({
      success: true,
      event: event,
    });
  } catch (error) {
    console.error("Error creating event:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Get all events for an organization (for homepage)
router.get("/org/:orgId", authenticateToken, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { page = 1, limit = 20, from_date } = req.query;
    const offset = (page - 1) * limit;

    // Check if user belongs to this org
    if (req.user.org_id !== parseInt(orgId)) {
      return res.status(403).json({
        success: false,
        message: "Access denied to this organization",
      });
    }

    let query = supabase
      .from("events")
      .select(
        `
        *,
        groups!inner(name),
        created_by_user:users!events_created_by_fkey(full_name)
      `
      )
      .eq("org_id", orgId)
      .eq("is_active", true);

    // Only show future events
    if (!from_date) {
      query = query.gte("event_date", new Date().toISOString().split("T")[0]);
    } else {
      query = query.gte("event_date", from_date);
    }

    const { data: events, error } = await query
      .range(offset, offset + limit - 1)
      .order("event_date", { ascending: true });

    if (error) {
      console.error("Error fetching org events:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching organization events",
      });
    }

    res.json({
      success: true,
      events: events || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        hasMore: events.length === parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching org events:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

module.exports = router;
