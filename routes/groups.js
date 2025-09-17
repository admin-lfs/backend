const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const supabase = require("../config/supabase");

// Get groups for a user
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { childId } = req.body;
    const userRole = req.user.role;
    const userOrgId = req.user.org_id;
    const userId = req.user.id;

    console.log("Groups API - Request body:", req.body);
    console.log("Groups API - User role:", userRole);
    console.log("Groups API - User ID:", userId);
    console.log("Groups API - Child ID:", childId);

    let targetUserId = userId;

    // If user is a parent, validate child access using middleware
    if (userRole === "parent") {
      if (!childId) {
        // Return empty groups for parents who haven't selected a child
        console.log(
          "Groups API - Parent without child ID, returning empty groups"
        );
        return res.json({
          success: true,
          groups: [],
          message: "Please select a child to view groups",
        });
      }

      // Use the parent-child validator middleware
      return parentChildValidator(req, res, async () => {
        try {
          targetUserId = req.validatedChild.childId;
          console.log("Groups API - Validated child ID:", targetUserId);
          await fetchAndReturnGroups(targetUserId, res);
        } catch (error) {
          console.error("Error fetching groups for child:", error);
          res.status(500).json({ error: "Internal server error" });
        }
      });
    }

    // For faculty and students, use their own user ID
    console.log("Groups API - Fetching groups for user:", targetUserId);
    await fetchAndReturnGroups(targetUserId, res);
  } catch (error) {
    console.error("Groups API error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper function to fetch and return groups
async function fetchAndReturnGroups(targetUserId, res) {
  try {
    // Get groups for the target user
    const { data: groups, error: groupsError } = await supabase
      .from("user_groups")
      .select(
        `
        group_id,
        groups!inner(
          id,
          name,
          description,
          updated_at
        )
      `
      )
      .eq("user_id", targetUserId)
      .eq("is_active", true)
      .eq("groups.archived", false);

    if (groupsError) {
      console.error("Groups query error:", groupsError);
      return res.status(500).json({ error: "Failed to fetch groups" });
    }

    // Transform the data to match expected format
    const formattedGroups = groups.map((item) => ({
      id: item.groups.id,
      name: item.groups.name,
      description: item.groups.description,
      updated_at: item.groups.updated_at,
    }));

    res.json({
      success: true,
      groups: formattedGroups,
    });
  } catch (error) {
    console.error("Error in fetchAndReturnGroups:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// Get a single group by ID
router.get("/:groupId", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const userRole = req.user.role;
    const userOrgId = req.user.org_id;
    const userId = req.user.id;

    console.log("Get single group - Group ID:", groupId);
    console.log("Get single group - User role:", userRole);
    console.log("Get single group - User org ID:", userOrgId);

    let targetUserId = userId;
    let targetOrgId = userOrgId;

    // If user is a parent, get child's org_id
    if (userRole === "parent") {
      // Get selected child from request (we'll pass it from frontend)
      const { childId } = req.query;

      if (!childId) {
        return res
          .status(400)
          .json({ error: "Child ID is required for parents" });
      }

      // Validate child access
      return parentChildValidator(req, res, async () => {
        try {
          targetUserId = req.validatedChild.childId;
          targetOrgId = req.validatedChild.orgId;

          await fetchSingleGroup(groupId, targetUserId, targetOrgId, res);
        } catch (error) {
          console.error("Error fetching group for child:", error);
          res.status(500).json({ error: "Internal server error" });
        }
      });
    }

    // For faculty and students, use their own org_id
    await fetchSingleGroup(groupId, targetUserId, targetOrgId, res);
  } catch (error) {
    console.error("Get single group error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper function to fetch single group
async function fetchSingleGroup(groupId, userId, orgId, res) {
  try {
    console.log("fetchSingleGroup - Group ID:", groupId);
    console.log("fetchSingleGroup - User ID:", userId);
    console.log("fetchSingleGroup - Org ID:", orgId);

    // First check if group exists and belongs to the org
    const { data: group, error: groupError } = await supabase
      .from("groups")
      .select("id, name, description, updated_at, org_id")
      .eq("id", groupId)
      .eq("org_id", orgId)
      .eq("archived", false)
      .single();

    if (groupError || !group) {
      console.log("Group not found or doesn't belong to org:", groupError);
      return res.status(404).json({ error: "Group not found" });
    }

    // Check if user has access to this group
    const { data: userGroup, error: userGroupError } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", userId)
      .eq("group_id", groupId)
      .eq("is_active", true)
      .single();

    if (userGroupError || !userGroup) {
      console.log("User doesn't have access to group:", userGroupError);
      return res.status(403).json({ error: "Access denied to this group" });
    }

    console.log("Group found and user has access:", group);

    res.json({
      success: true,
      group: {
        id: group.id,
        name: group.name,
        description: group.description,
        updated_at: group.updated_at,
      },
    });
  } catch (error) {
    console.error("Error in fetchSingleGroup:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// Create a new group (faculty only)
router.post("/create", authenticateToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    const userRole = req.user.role;
    const userOrgId = req.user.org_id;

    if (userRole !== "faculty") {
      return res.status(403).json({ error: "Only faculty can create groups" });
    }

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: "Group name is required" });
    }

    // Create the group
    const { data: group, error: groupError } = await supabase
      .from("groups")
      .insert({
        name: name.trim(),
        description: description?.trim() || null,
        org_id: userOrgId,
      })
      .select()
      .single();

    if (groupError) {
      console.error("Group creation error:", groupError);
      return res.status(500).json({ error: "Failed to create group" });
    }

    res.json({
      success: true,
      group: {
        id: group.id,
        name: group.name,
        description: group.description,
        updated_at: group.updated_at,
      },
    });
  } catch (error) {
    console.error("Group creation API error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
