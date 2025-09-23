const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const supabase = require("../config/supabase");

console.log("=== GROUP MEMBERS ROUTES LOADED ===");

// Add this middleware to log all requests to this router
router.use((req, res, next) => {
  console.log("=== GROUP MEMBERS REQUEST ===");
  console.log("Method:", req.method);
  console.log("URL:", req.url);
  console.log("Path:", req.path);
  console.log("Params:", req.params);
  console.log("Query:", req.query);
  next();
});

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
        users!user_groups_user_id_fkey(id, full_name, role, register_number)
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
    const { user_id, member_type, userIds } = req.body;
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

    // Handle multiple users if userIds is provided
    if (userIds && Array.isArray(userIds)) {
      const membersToAdd = userIds.map((userId) => ({
        group_id: groupId,
        user_id: userId,
        member_type: member_type,
        is_active: true,
      }));

      const { data, error } = await supabase
        .from("user_groups")
        .insert(membersToAdd)
        .select();

      if (error) {
        console.error("Error adding members:", error);
        return res.status(500).json({
          success: false,
          message: "Error adding members",
        });
      }

      return res.json({
        success: true,
        message: "Members added successfully",
        members: data,
      });
    }

    // Handle single user (existing logic)
    const { user_id: singleUserId, member_type: singleMemberType } = req.body;

    // Check if user is already a member
    const { data: existingMember, error: existingError } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", singleUserId)
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
        user_id: singleUserId,
        member_type: singleMemberType || "student",
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

// Add this new route after the existing members route
router.post("/:groupId/add-members", authenticateToken, async (req, res) => {
  console.log("=== ADD MEMBERS ROUTE HIT ===");
  console.log("GroupId:", req.params.groupId);
  console.log("Body:", req.body);

  try {
    const { groupId } = req.params;
    const { userIds, memberType } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    console.log("Processing add members for group:", groupId);
    console.log("UserIds:", userIds);
    console.log("MemberType:", memberType);

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

    // Validate member type
    if (memberType !== "student" && memberType !== "teacher") {
      return res.status(400).json({
        success: false,
        message:
          "Invalid member type. Only 'student' or 'teacher' are allowed.",
      });
    }

    // Validate that users have the correct role for the member type
    // IMPORTANT: Only fetch users with the correct role, never parents
    let roleFilter = "";
    if (memberType === "student") {
      roleFilter = "student";
    } else if (memberType === "teacher") {
      roleFilter = "faculty";
    }

    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, role, full_name")
      .in("id", userIds)
      .eq("role", roleFilter) // Only get users with the correct role
      .eq("is_active", true);

    if (usersError) {
      console.error("Error fetching users:", usersError);
      return res.status(500).json({
        success: false,
        message: "Error validating users",
      });
    }

    // Check if all requested users were found with the correct role
    if (users.length !== userIds.length) {
      const foundUserIds = new Set(users.map((u) => u.id));
      const missingUserIds = userIds.filter((id) => !foundUserIds.has(id));

      return res.status(400).json({
        success: false,
        message: `Some users were not found or do not have the correct role (${roleFilter}). Users with IDs ${missingUserIds.join(
          ", "
        )} cannot be added as ${memberType}s.`,
        invalidUserIds: missingUserIds,
      });
    }

    // Check if any of the users already exist in the group (active or inactive)
    const { data: existingMembers, error: existingError } = await supabase
      .from("user_groups")
      .select("user_id, is_active")
      .eq("group_id", groupId)
      .in("user_id", userIds);

    if (existingError) {
      console.error("Error checking existing members:", existingError);
      return res.status(500).json({
        success: false,
        message: "Error checking existing members",
      });
    }

    const existingUserIds = new Set(
      existingMembers?.map((member) => member.user_id) || []
    );
    const activeUserIds = new Set(
      existingMembers
        ?.filter((member) => member.is_active)
        ?.map((member) => member.user_id) || []
    );

    // Separate users into categories
    const newUserIds = userIds.filter((userId) => !existingUserIds.has(userId));
    const inactiveUserIds = userIds.filter(
      (userId) => existingUserIds.has(userId) && !activeUserIds.has(userId)
    );
    const alreadyActiveUserIds = userIds.filter((userId) =>
      activeUserIds.has(userId)
    );

    console.log("New users:", newUserIds);
    console.log("Inactive users:", inactiveUserIds);
    console.log("Already active users:", alreadyActiveUserIds);

    // Reactivate inactive users
    if (inactiveUserIds.length > 0) {
      const { error: reactivateError } = await supabase
        .from("user_groups")
        .update({ is_active: true })
        .eq("group_id", groupId)
        .in("user_id", inactiveUserIds);

      if (reactivateError) {
        console.error("Error reactivating members:", reactivateError);
        return res.status(500).json({
          success: false,
          message: "Error reactivating members",
        });
      }
    }

    // Add new members
    let addedMembers = [];
    if (newUserIds.length > 0) {
      const membersToAdd = newUserIds.map((userId) => ({
        group_id: groupId,
        user_id: userId,
        member_type: memberType,
        is_active: true,
      }));

      const { data, error } = await supabase
        .from("user_groups")
        .insert(membersToAdd)
        .select();

      if (error) {
        console.error("Error adding members:", error);
        return res.status(500).json({
          success: false,
          message: "Error adding members",
        });
      }

      addedMembers = data || [];
    }

    const totalProcessed = newUserIds.length + inactiveUserIds.length;
    const skipped = alreadyActiveUserIds.length;

    res.json({
      success: true,
      message: `${totalProcessed} members processed successfully`,
      added: addedMembers,
      reactivated: inactiveUserIds.length,
      skipped: skipped,
      details: {
        new: newUserIds.length,
        reactivated: inactiveUserIds.length,
        alreadyActive: alreadyActiveUserIds.length,
      },
    });
  } catch (error) {
    console.error("Error in add members:", error);
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

      // First, get all students in this group
      const { data: existingMembers, error: membersError } = await supabase
        .from("user_groups")
        .select("user_id")
        .eq("group_id", groupId)
        .eq("is_active", true);

      if (membersError) {
        console.error("Error fetching existing members:", membersError);
        return res.status(500).json({
          success: false,
          message: "Error fetching existing members",
        });
      }

      const existingUserIds =
        existingMembers?.map((member) => member.user_id) || [];

      // Get students not in this group
      let query = supabase
        .from("users")
        .select("id, full_name, role, register_number")
        .eq("role", "student")
        .eq("org_id", group.org_id)
        .eq("is_active", true);

      // Exclude students already in the group - FIXED: Use proper parentheses
      if (existingUserIds.length > 0) {
        query = query.not("id", "in", `(${existingUserIds.join(",")})`);
      }

      if (search) {
        query = query.ilike("full_name", `%${search}%`);
      }

      const { data: students, error } = await query
        .range(offset, offset + limit - 1)
        .order("full_name");

      if (error) {
        console.error("Error fetching available students:", error);
        return res.status(500).json({
          success: false,
          message: "Error fetching available students",
        });
      }

      // Add isInGroup property to each student
      const studentsWithStatus = (students || []).map((student) => ({
        ...student,
        isInGroup: false,
      }));

      res.json({
        success: true,
        students: studentsWithStatus,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: students?.length || 0,
          hasMore: students?.length === parseInt(limit),
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

      // First, get all teachers in this group
      const { data: existingMembers, error: membersError } = await supabase
        .from("user_groups")
        .select("user_id")
        .eq("group_id", groupId)
        .eq("is_active", true)
        .eq("member_type", "teacher");

      if (membersError) {
        console.error("Error fetching existing members:", membersError);
        return res.status(500).json({
          success: false,
          message: "Error fetching existing members",
        });
      }

      const existingUserIds =
        existingMembers?.map((member) => member.user_id) || [];

      // Get teachers not in this group
      let query = supabase
        .from("users")
        .select("id, full_name, role, register_number") // Removed email, added role
        .eq("role", "faculty")
        .eq("org_id", group.org_id)
        .eq("is_active", true);

      // Exclude teachers already in the group
      if (existingUserIds.length > 0) {
        query = query.not("id", "in", `(${existingUserIds.join(",")})`);
      }

      if (search) {
        query = query.ilike("full_name", `%${search}%`);
      }

      const { data: teachers, error } = await query
        .range(offset, offset + limit - 1)
        .order("full_name");

      if (error) {
        console.error("Error fetching available teachers:", error);
        return res.status(500).json({
          success: false,
          message: "Error fetching available teachers",
        });
      }

      // Add isInGroup property to each teacher
      const teachersWithStatus = (teachers || []).map((teacher) => ({
        ...teacher,
        isInGroup: false,
      }));

      res.json({
        success: true,
        teachers: teachersWithStatus,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: teachers?.length || 0,
          hasMore: teachers?.length === parseInt(limit),
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

// Get all teachers (including those already in group)
router.get("/:groupId/all-teachers", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { search = "" } = req.query;
    const userRole = req.user.role;

    // Only teachers can view all teachers
    if (userRole !== "faculty") {
      return res.status(403).json({
        success: false,
        message: "Only faculty can view all teachers",
      });
    }

    // Get current group's org_id
    const { data: currentGroup, error: groupError } = await supabase
      .from("groups")
      .select("org_id")
      .eq("id", groupId)
      .single();

    if (groupError || !currentGroup) {
      return res.status(404).json({
        success: false,
        message: "Group not found",
      });
    }

    // Get all teachers in the org
    let query = supabase
      .from("users")
      .select(
        `
        id,
        full_name,
        register_number
      `
      )
      .eq("role", "faculty")
      .eq("org_id", currentGroup.org_id)
      .eq("is_active", true);

    if (search) {
      query = query.ilike("full_name", `%${search}%`);
    }

    const { data: teachers, error } = await query;

    if (error) {
      console.error("Error fetching all teachers:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch all teachers",
      });
    }

    // Get current group members to check who's already in the group
    const { data: currentMembers, error: membersError } = await supabase
      .from("user_groups")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("is_active", true);

    if (membersError) {
      console.error("Error fetching current members:", membersError);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch current members",
      });
    }

    const currentMemberIds = new Set(
      currentMembers?.map((member) => member.user_id) || []
    );

    // Format the response
    const formattedTeachers = teachers.map((teacher) => {
      const isInGroup = currentMemberIds.has(teacher.id);

      return {
        id: teacher.id,
        full_name: teacher.full_name,
        register_number: teacher.register_number,
        isInGroup,
      };
    });

    res.json({
      success: true,
      teachers: formattedTeachers,
    });
  } catch (error) {
    console.error("Error fetching all teachers:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch all teachers",
    });
  }
});

// Add debugging to the students route
router.get("/:groupId/students", authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { currentGroupId } = req.query;
    const userRole = req.user.role;

    console.log("=== STUDENTS ROUTE DEBUG ===");
    console.log("groupId (from params):", groupId);
    console.log("currentGroupId (from query):", currentGroupId);
    console.log("Query params:", req.query);

    if (userRole !== "faculty") {
      return res.status(403).json({
        success: false,
        message: "Only faculty can view group students",
      });
    }

    // Get students from the specified group
    const { data: students, error } = await supabase
      .from("user_groups")
      .select(
        `
        users!user_groups_user_id_fkey(id, full_name, register_number)
      `
      )
      .eq("group_id", groupId)
      .eq("member_type", "student")
      .eq("is_active", true);

    if (error) {
      console.error("Error fetching group students:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch group students",
      });
    }

    console.log("Students from group:", students?.length);

    // Get current group members to check who's already in the current group
    const { data: currentMembers, error: membersError } = await supabase
      .from("user_groups")
      .select("user_id")
      .eq("group_id", currentGroupId) // Use currentGroupId from query params
      .eq("is_active", true);

    if (membersError) {
      console.error("Error fetching current members:", membersError);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch current members",
      });
    }

    console.log("Current members:", currentMembers?.length);

    const currentMemberIds = new Set(
      currentMembers?.map((member) => member.user_id) || []
    );

    // Format the response
    const formattedStudents = students.map((item) => {
      const isInGroup = currentMemberIds.has(item.users.id);
      console.log(`Student ${item.users.full_name}: isInGroup = ${isInGroup}`);

      return {
        id: item.users.id,
        full_name: item.users.full_name,
        register_number: item.users.register_number,
        isInGroup,
      };
    });

    console.log("Formatted students:", formattedStudents);

    res.json({
      success: true,
      students: formattedStudents,
    });
  } catch (error) {
    console.error("Error fetching group students:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch group students",
    });
  }
});

// Get available groups for adding students
router.get(
  "/:groupId/available-groups",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const userRole = req.user.role;

      if (userRole !== "faculty") {
        return res.status(403).json({
          success: false,
          message: "Only faculty can view available groups",
        });
      }

      const { data: currentGroup, error: groupError } = await supabase
        .from("groups")
        .select("org_id")
        .eq("id", groupId)
        .single();

      if (groupError || !currentGroup) {
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      const { data: groups, error } = await supabase
        .from("groups")
        .select("id, name")
        .eq("org_id", currentGroup.org_id)
        .eq("is_default", false)
        .eq("archived", false)
        .neq("id", groupId);

      if (error) {
        console.error("Error fetching available groups:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to fetch available groups",
        });
      }

      res.json({
        success: true,
        groups: groups || [],
      });
    } catch (error) {
      console.error("Error fetching available groups:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch available groups",
      });
    }
  }
);

router.get(
  "/:groupId/test-add-members",
  authenticateToken,
  async (req, res) => {
    res.json({
      success: true,
      message: "Test route working",
      groupId: req.params.groupId,
    });
  }
);

module.exports = router;
