const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const supabase = require("../config/supabase");

// Get all members of a group
router.get("/:groupId/members", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { page = 1, limit = 20, search = "", member_type } = req.query;
    const offset = (page - 1) * limit;

    // Check if user has access to this group
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
        hasMore: members.length === parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching group members:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Add members to group
router.post("/:groupId/members", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { user_ids, member_type } = req.body;

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
        message: "Only teachers can add members to groups",
      });
    }

    const membersToAdd = user_ids.map((userId) => ({
      group_id: groupId,
      user_id: userId,
      member_type: member_type,
      is_active: true,
    }));

    const { data: newMembers, error } = await supabase
      .from("user_groups")
      .upsert(membersToAdd, { onConflict: "group_id,user_id" })
      .select();

    if (error) {
      console.error("Error adding group members:", error);
      return res.status(500).json({
        success: false,
        message: "Error adding group members",
      });
    }

    res.json({
      success: true,
      message: `Added ${newMembers.length} members to group`,
      members: newMembers,
    });
  } catch (error) {
    console.error("Error adding group members:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Remove member from group
router.delete(
  "/:groupId/members/:userId",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId, userId } = req.params;

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
          message: "Only teachers can remove members from groups",
        });
      }

      const { error } = await supabase
        .from("user_groups")
        .update({ is_active: false })
        .eq("group_id", groupId)
        .eq("user_id", userId);

      if (error) {
        console.error("Error removing group member:", error);
        return res.status(500).json({
          success: false,
          message: "Error removing group member",
        });
      }

      res.json({
        success: true,
        message: "Member removed from group",
      });
    } catch (error) {
      console.error("Error removing group member:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Get available students (from other groups)
router.get(
  "/:groupId/available-students",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { page = 1, limit = 20, search = "" } = req.query;
      const offset = (page - 1) * limit;

      // Get current user's org_id
      const userOrgId = req.user.org_id;

      let query = supabase
        .from("users")
        .select("id, full_name, role")
        .eq("org_id", userOrgId)
        .eq("role", "student")
        .eq("is_active", true);

      if (search) {
        query = query.ilike("full_name", `%${search}%`);
      }

      const { data: allStudents, error } = await query
        .range(offset, offset + limit - 1)
        .order("full_name");

      if (error) {
        console.error("Error fetching available students:", error);
        return res.status(500).json({
          success: false,
          message: "Error fetching available students",
        });
      }

      // Get current group members to mark existing ones
      const { data: currentMembers } = await supabase
        .from("user_groups")
        .select("user_id")
        .eq("group_id", groupId)
        .eq("is_active", true);

      const currentMemberIds = new Set(
        currentMembers?.map((m) => m.user_id) || []
      );

      const studentsWithStatus = allStudents.map((student) => ({
        ...student,
        isInGroup: currentMemberIds.has(student.id),
      }));

      res.json({
        success: true,
        students: studentsWithStatus,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: allStudents.length === parseInt(limit),
        },
      });
    } catch (error) {
      console.error("Error fetching available students:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Get available teachers
router.get(
  "/:groupId/available-teachers",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { page = 1, limit = 20, search = "" } = req.query;
      const offset = (page - 1) * limit;

      const userOrgId = req.user.org_id;

      let query = supabase
        .from("users")
        .select("id, full_name, role")
        .eq("org_id", userOrgId)
        .eq("role", "faculty")
        .eq("is_active", true);

      if (search) {
        query = query.ilike("full_name", `%${search}%`);
      }

      const { data: allTeachers, error } = await query
        .range(offset, offset + limit - 1)
        .order("full_name");

      if (error) {
        console.error("Error fetching available teachers:", error);
        return res.status(500).json({
          success: false,
          message: "Error fetching available teachers",
        });
      }

      // Get current group members
      const { data: currentMembers } = await supabase
        .from("user_groups")
        .select("user_id")
        .eq("group_id", groupId)
        .eq("is_active", true);

      const currentMemberIds = new Set(
        currentMembers?.map((m) => m.user_id) || []
      );

      const teachersWithStatus = allTeachers.map((teacher) => ({
        ...teacher,
        isInGroup: currentMemberIds.has(teacher.id),
      }));

      res.json({
        success: true,
        teachers: teachersWithStatus,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: allTeachers.length === parseInt(limit),
        },
      });
    } catch (error) {
      console.error("Error fetching available teachers:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

module.exports = router;
