const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const supabase = require("../config/supabase");

// Get events for a group
router.get(
  "/:groupId/events",
  authenticateToken,
  async (req, res, next) => {
    // Only apply parentChildValidator for parent users
    if (req.user.role === "parent") {
      return parentChildValidator(req, res, next);
    }
    next();
  },
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const userRole = req.user.role;
      const userId = req.user.id;

      let targetUserId = userId;

      // If user is a parent, use validated child
      if (userRole === "parent") {
        targetUserId = req.validatedChild.childId;
      }

      // Check if user has access to this group
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id, member_type")
        .eq("user_id", targetUserId)
        .eq("group_id", groupId)
        .eq("is_active", true)
        .single();

      if (userGroupError || !userGroup) {
        return res.status(403).json({
          success: false,
          message: "Access denied to this group",
        });
      }

      // Get events for the group
      const { data: events, error: eventsError } = await supabase
        .from("events")
        .select(
          `
        id,
        event_title,
        event_description,
        event_date,
        created_by,
        created_at,
        updated_at,
        is_deleted
      `
        )
        .eq("group_id", groupId)
        .eq("is_active", true)
        .eq("is_deleted", false) // Exclude deleted events
        .order("event_date", { ascending: false });

      if (eventsError) {
        console.error("Error fetching events:", eventsError);
        return res.status(500).json({
          success: false,
          message: "Error fetching events",
        });
      }

      console.log("🔍 Group events fetched:", events?.length || 0);
      console.log("🔍 Sample event created_by:", events?.[0]?.created_by);

      // Get creator names separately
      const eventIds = events?.map((event) => event.created_by) || [];
      console.log("🔍 Event creator IDs:", eventIds);

      const { data: creators, error: creatorsError } = await supabase
        .from("users")
        .select("id, full_name")
        .in("id", eventIds);

      console.log("🔍 Creators query result:", { creators, creatorsError });

      // Map creator names to events
      const eventsWithCreators =
        events?.map((event) => {
          const creator = creators?.find(
            (creator) => creator.id === event.created_by
          );
          console.log(`🔍 Event ${event.id} creator:`, creator);
          return {
            ...event,
            created_by_name: creator?.full_name || "Unknown",
          };
        }) || [];

      console.log("🔍 Final events with creators:", eventsWithCreators);

      res.json({
        success: true,
        events: eventsWithCreators,
      });
    } catch (error) {
      console.error("Error in get events:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

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
        groups!inner(name)
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

    // Get creator names separately to avoid foreign key issues
    const eventIds = events?.map((event) => event.created_by) || [];
    const { data: creators, error: creatorsError } = await supabase
      .from("users")
      .select("id, full_name")
      .in("id", eventIds);

    // Map creator names to events
    const eventsWithCreators =
      events?.map((event) => ({
        ...event,
        created_by_name:
          creators?.find((creator) => creator.id === event.created_by)
            ?.full_name || "Unknown",
      })) || [];

    res.json({
      success: true,
      events: eventsWithCreators,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        hasMore: events?.length === parseInt(limit),
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

// Get all events for a user (from all their groups)
router.get("/user", authenticateToken, async (req, res) => {
  try {
    const { limit = 25, offset = 0, lastUpdated } = req.query;
    const userRole = req.user.role;
    const userOrgId = req.user.org_id;
    const userId = req.user.id;

    console.log("User Events API - User role:", userRole);
    console.log("User Events API - User org ID:", userOrgId);

    let targetUserId = userId;

    // If user is a parent, get child's details
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
          targetUserId = req.validatedChild.childId;
          await fetchUserEvents(
            targetUserId,
            limit,
            offset,
            lastUpdated,
            res,
            userOrgId
          );
        } catch (error) {
          console.error("Error fetching events for child:", error);
          res.status(500).json({ error: "Internal server error" });
        }
      });
    }

    // For faculty and students, use their own user ID
    await fetchUserEvents(
      targetUserId,
      limit,
      offset,
      lastUpdated,
      res,
      userOrgId
    );
  } catch (error) {
    console.error("User Events API error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper function to fetch user events
async function fetchUserEvents(userId, limit, offset, lastUpdated, res, orgId) {
  try {
    console.log("fetchUserEvents - User ID:", userId);

    // Get user's groups first
    const { data: userGroups, error: groupsError } = await supabase
      .from("user_groups")
      .select("group_id")
      .eq("user_id", userId)
      .eq("is_active", true);

    if (groupsError) {
      console.error("User groups query error:", groupsError);
      return res.status(500).json({ error: "Failed to fetch user groups" });
    }

    if (!userGroups || userGroups.length === 0) {
      return res.json({
        success: true,
        events: [],
      });
    }

    const groupIds = userGroups.map((ug) => ug.group_id);

    // Get events from user's groups (only future events)
    const today = new Date().toISOString().split("T")[0];

    let query = supabase
      .from("events")
      .select(
        `
        id,
        group_id,
        org_id,
        event_title,
        event_description,
        event_date,
        created_by,
        created_at,
        updated_at,
        is_active,
        is_deleted
      `
      )
      .in("group_id", groupIds)
      .eq("org_id", orgId) // Use the passed orgId parameter
      .eq("is_active", true)
      .gte("event_date", today)
      .order("event_date", { ascending: true })
      .order("created_at", { ascending: false });

    // If lastUpdated is provided, only get events newer than that
    if (lastUpdated) {
      query = query.gte("updated_at", lastUpdated);
    }

    // Apply pagination
    if (limit) {
      query = query.limit(parseInt(limit));
    }
    if (offset) {
      query = query.range(
        parseInt(offset),
        parseInt(offset) + parseInt(limit) - 1
      );
    }

    const { data: events, error: eventsError } = await query;

    if (eventsError) {
      console.error("Events query error:", eventsError);
      return res.status(500).json({ error: "Failed to fetch events" });
    }

    // Fetch creator names separately for each event
    const eventCreatorIds = [
      ...new Set(events.map((event) => event.created_by)),
    ];

    const { data: creators, error: creatorsError } = await supabase
      .from("users")
      .select("id, full_name")
      .in("id", eventCreatorIds);

    if (creatorsError) {
      console.error("Error fetching event creators:", creatorsError);
      // Continue without creator names if there's an error
    }

    // Map creator names to events
    const eventsWithCreatorNames = events.map((event) => ({
      ...event,
      created_by_name:
        creators?.find((c) => c.id === event.created_by)?.full_name ||
        "Unknown",
    }));

    res.json({
      success: true,
      events: eventsWithCreatorNames,
    });
  } catch (error) {
    console.error("Error in fetchUserEvents:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

module.exports = router;
