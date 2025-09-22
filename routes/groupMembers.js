const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const supabase = require("../config/supabase");

// Get all members of a group
router.get(
  "/:groupId/members",
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
      const { page = 1, limit = 20, search = "", member_type } = req.query;
      const offset = (page - 1) * limit;

      let targetUserId = req.user.id;

      // If user is a parent, use validated child
      if (req.user.role === "parent") {
        targetUserId = req.validatedChild.childId;
      }

      // Check if user has access to this group
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id")
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

      let query = supabase
        .from("user_groups")
        .select(
          `
        *,
        users!user_groups_user_id_fkey(id, full_name, role)
      `
        )
        .eq("group_id", groupId)
        .eq("is_active", true);

      if (member_type) {
        query = query.eq("member_type", member_type);
      }

      if (search) {
        query = query.ilike("users.full_name", `%${search}%`);
      }

      const { data: members, error } = await query
        .range(offset, offset + limit - 1)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error fetching group members:", error);
        return res.status(500).json({
          success: false,
          message: "Error fetching group members",
        });
      }

      res.json({
        success: true,
        members: members || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: members?.length || 0,
        },
      });
    } catch (error) {
      console.error("Error in get group members:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Add member to group (teachers only)
router.post("/:groupId/members", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { user_id, member_type } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Only teachers can add members
    if (userRole !== "faculty") {
      return res.status(403).json({
        success: false,
        message: "Only teachers can add members",
      });
    }

    // Check if user is a teacher in this group
    const { data: userGroup, error: userGroupError } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", userId)
      .eq("group_id", groupId)
      .eq("member_type", "teacher")
      .eq("is_active", true)
      .single();

    if (userGroupError || !userGroup) {
      return res.status(403).json({
        success: false,
        message: "Only teachers can add members",
      });
    }

    // Check if user is already a member
    const { data: existingMember, error: existingError } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", user_id)
      .eq("group_id", groupId)
      .eq("is_active", true)
      .single();

    if (existingMember) {
      return res.status(400).json({
        success: false,
        message: "User is already a member of this group",
      });
    }

    // Add user to group
    const { data, error } = await supabase
      .from("user_groups")
      .insert({
        group_id: groupId,
        user_id: user_id,
        member_type: member_type || "student",
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error("Error adding member:", error);
      return res.status(500).json({
        success: false,
        message: "Error adding member",
      });
    }

    res.json({
      success: true,
      message: "Member added successfully",
      member: data,
    });
  } catch (error) {
    console.error("Error in add member:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Remove member from group (teachers only)
router.delete(
  "/:groupId/members/:userId",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId, userId: memberId } = req.params;
      const userRole = req.user.role;

      // Only teachers can remove members
      if (userRole !== "faculty") {
        return res.status(403).json({
          success: false,
          message: "Only teachers can remove members",
        });
      }

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
          message: "Only teachers can remove members",
        });
      }

      // Remove user from group
      const { error } = await supabase
        .from("user_groups")
        .update({ is_active: false })
        .eq("group_id", groupId)
        .eq("user_id", memberId);

      if (error) {
        console.error("Error removing member:", error);
        return res.status(500).json({
          success: false,
          message: "Error removing member",
        });
      }

      res.json({
        success: true,
        message: "Member removed successfully",
      });
    } catch (error) {
      console.error("Error in remove member:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Get available students for adding to group
router.get(
  "/:groupId/available-students",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { search = "", page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      const userRole = req.user.role;

      // Only teachers can view available students
      if (userRole !== "faculty") {
        return res.status(403).json({
          success: false,
          message: "Only teachers can view available students",
        });
      }

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
          message: "Only teachers can view available students",
        });
      }

      // Get group's org_id
      const { data: group, error: groupError } = await supabase
        .from("groups")
        .select("org_id")
        .eq("id", groupId)
        .single();

      if (groupError || !group) {
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      // Get students not in this group
      let query = supabase
        .from("users")
        .select("id, full_name, email")
        .eq("role", "student")
        .eq("org_id", group.org_id)
        .not(
          "id",
          "in",
          `(SELECT user_id FROM user_groups WHERE group_id = '${groupId}' AND is_active = true)`
        );

      if (search) {
        query = query.ilike("full_name", `%${search}%`);
      }

      const { data: students, error } = await query
        .range(offset, offset + limit - 1)
        .order("full_name", { ascending: true });

      if (error) {
        console.error("Error fetching available students:", error);
        return res.status(500).json({
          success: false,
          message: "Error fetching available students",
        });
      }

      res.json({
        success: true,
        students: students || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: students?.length || 0,
        },
      });
    } catch (error) {
      console.error("Error in get available students:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Get available teachers for adding to group
router.get(
  "/:groupId/available-teachers",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { search = "", page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      const userRole = req.user.role;

      // Only teachers can view available teachers
      if (userRole !== "faculty") {
        return res.status(403).json({
          success: false,
          message: "Only teachers can view available teachers",
        });
      }

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
          message: "Only teachers can view available teachers",
        });
      }

      // Get group's org_id
      const { data: group, error: groupError } = await supabase
        .from("groups")
        .select("org_id")
        .eq("id", groupId)
        .single();

      if (groupError || !group) {
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      // Get teachers not in this group
      let query = supabase
        .from("users")
        .select("id, full_name, email")
        .eq("role", "faculty")
        .eq("org_id", group.org_id)
        .not(
          "id",
          "in",
          `(SELECT user_id FROM user_groups WHERE group_id = '${groupId}' AND is_active = true)`
        );

      if (search) {
        query = query.ilike("full_name", `%${search}%`);
      }

      const { data: teachers, error } = await query
        .range(offset, offset + limit - 1)
        .order("full_name", { ascending: true });

      if (error) {
        console.error("Error fetching available teachers:", error);
        return res.status(500).json({
          success: false,
          message: "Error fetching available teachers",
        });
      }

      res.json({
        success: true,
        teachers: teachers || [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: teachers?.length || 0,
        },
      });
    } catch (error) {
      console.error("Error in get available teachers:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

module.exports = router;
