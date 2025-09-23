const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");

// Helper function to check if user is member of group
async function isUserMemberOfGroup(userId, groupId, orgId) {
  try {
    const { data, error } = await supabase
      .from("user_groups")
      .select("id")
      .eq("user_id", userId)
      .eq("group_id", groupId)
      .eq("is_active", true)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("Error checking group membership:", error);
      return false;
    }

    return !!data;
  } catch (error) {
    console.error("Error in isUserMemberOfGroup:", error);
    return false;
  }
}

// Get user's groups (with parent-child validation)
router.post("/", authenticateToken, async (req, res) => {
  try {
    console.log("Groups API - User role:", req.user.role);
    console.log("Groups API - User ID:", req.user.id);
    console.log("Groups API - Request body:", req.body);

    let targetUserId = req.user.id;
    let targetOrgId = req.user.org_id;

    // Handle parent requests
    if (req.user.role === "parent") {
      const { childId } = req.body;
      console.log("Groups API - Child ID:", childId);

      if (!childId) {
        return res.status(400).json({
          success: false,
          message: "Child ID is required for parent users",
        });
      }

      // Validate parent-child relationship
      const { data: childData, error: childError } = await supabase
        .from("parent_child_relationships")
        .select(
          `
          child_id,
          users!parent_child_relationships_child_id_fkey(id, org_id)
        `
        )
        .eq("parent_id", req.user.id)
        .eq("child_id", childId)
        .eq("is_active", true)
        .single();

      if (childError || !childData) {
        return res.status(403).json({
          success: false,
          message: "Child not found or access denied",
        });
      }

      targetUserId = childId;
      targetOrgId = childData.users.org_id;
    }

    console.log("Groups API - Fetching groups for user:", targetUserId);

    // Fetch groups for the target user
    const { data: userGroups, error } = await supabase
      .from("user_groups")
      .select(
        `
        group_id,
        groups!inner(
          id,
          name,
          description,
          academic_year,
          is_default,
          created_by,
          created_at,
          updated_at,
          archived
        )
      `
      )
      .eq("user_id", targetUserId)
      .eq("is_active", true)
      .eq("groups.archived", false)
      .eq("groups.org_id", targetOrgId);

    if (error) {
      console.error("Database error:", error);
      throw error;
    }

    // Transform the data
    const groups = userGroups.map((ug) => ({
      id: ug.groups.id,
      name: ug.groups.name,
      description: ug.groups.description,
      academic_year: ug.groups.academic_year,
      is_default: ug.groups.is_default,
      created_by: ug.groups.created_by,
      created_at: ug.groups.created_at,
      updated_at: ug.groups.updated_at,
    }));

    res.json({
      success: true,
      groups,
    });
  } catch (error) {
    console.error("Error fetching groups:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch groups",
    });
  }
});

// SPECIFIC ROUTES FIRST - Get all groups with member counts (for student tab)
router.get("/available-for-selection", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "faculty") {
      return res.status(403).json({
        success: false,
        message: "Only faculty can access this",
      });
    }

    const { data: groups, error } = await supabase
      .from("groups")
      .select(
        `
        id,
        name,
        description,
        user_groups!inner(user_id)
      `
      )
      .eq("org_id", req.user.org_id)
      .eq("archived", false)
      .eq("user_groups.member_type", "student");

    if (error) throw error;

    // Count members for each group
    const groupsWithCounts = groups.reduce((acc, group) => {
      const existingGroup = acc.find((g) => g.id === group.id);
      if (existingGroup) {
        existingGroup.member_count++;
      } else {
        acc.push({
          id: group.id,
          name: group.name,
          description: group.description,
          member_count: 1,
        });
      }
      return acc;
    }, []);

    res.json({
      success: true,
      groups: groupsWithCounts,
    });
  } catch (error) {
    console.error("Error fetching groups for selection:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch groups",
    });
  }
});

// Get all available teachers
router.get("/available-teachers", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "faculty") {
      return res.status(403).json({
        success: false,
        message: "Only faculty can access this",
      });
    }

    const { search } = req.query;

    let query = supabase
      .from("users")
      .select("id, full_name")
      .eq("org_id", req.user.org_id)
      .eq("role", "faculty")
      .eq("is_active", true);

    if (search) {
      query = query.ilike("full_name", `%${search}%`);
    }

    const { data: teachers, error } = await query.order("full_name");

    if (error) throw error;

    res.json({
      success: true,
      teachers: teachers || [],
    });
  } catch (error) {
    console.error("Error fetching teachers:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch teachers",
    });
  }
});

// Create new group with members
router.post("/create-with-members", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "faculty") {
      return res.status(403).json({
        success: false,
        message: "Only faculty can create groups",
      });
    }

    const {
      name,
      description,
      academic_year,
      selectedStudents,
      selectedTeachers,
    } = req.body;

    // Validation
    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Group name is required",
      });
    }

    if (name.length > 50) {
      return res.status(400).json({
        success: false,
        message: "Group name cannot exceed 50 characters",
      });
    }

    if (description && description.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Description cannot exceed 100 characters",
      });
    }

    // Check minimum members (creator + at least 1 more)
    const totalMembers =
      (selectedStudents?.length || 0) + (selectedTeachers?.length || 0);
    if (totalMembers === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one member is required",
      });
    }

    // Create group
    const { data: newGroup, error: groupError } = await supabase
      .from("groups")
      .insert({
        name: name.trim(),
        description: description?.trim() || null,
        academic_year: academic_year?.trim() || null,
        org_id: req.user.org_id,
        created_by: req.user.id,
        is_default: false,
      })
      .select()
      .single();

    if (groupError) throw groupError;

    // Add creator to group
    const membersToAdd = [
      {
        group_id: newGroup.id,
        user_id: req.user.id,
        member_type: "teacher",
        added_by: req.user.id,
        is_active: true,
      },
    ];

    // Add selected students
    if (selectedStudents?.length > 0) {
      selectedStudents.forEach((studentId) => {
        membersToAdd.push({
          group_id: newGroup.id,
          user_id: studentId,
          member_type: "student",
          added_by: req.user.id,
          is_active: true,
        });
      });
    }

    // Add selected teachers (but exclude the creator to avoid duplicates)
    if (selectedTeachers?.length > 0) {
      selectedTeachers.forEach((teacherId) => {
        // Skip if this teacher is the creator (already added above)
        if (teacherId !== req.user.id) {
          membersToAdd.push({
            group_id: newGroup.id,
            user_id: teacherId,
            member_type: "teacher",
            added_by: req.user.id,
            is_active: true,
          });
        }
      });
    }

    // Insert all members
    const { error: membersError } = await supabase
      .from("user_groups")
      .insert(membersToAdd);

    if (membersError) throw membersError;

    res.json({
      success: true,
      message: "Group created successfully",
      group: newGroup,
    });
  } catch (error) {
    console.error("Error creating group:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create group",
    });
  }
});

// Get students from specific group
router.get("/:groupId/students", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "faculty") {
      return res.status(403).json({
        success: false,
        message: "Only faculty can access this",
      });
    }

    const { groupId } = req.params;
    const { currentGroupId } = req.query;

    console.log("=== STUDENTS ROUTE ===");
    console.log("Source groupId (students from):", groupId);
    console.log("Target currentGroupId (students going to):", currentGroupId);

    const { data: students, error } = await supabase
      .from("user_groups")
      .select(
        `
        user_id,
        users!user_groups_user_id_fkey(
          id,
          full_name,
          register_number
        )
      `
      )
      .eq("group_id", groupId)
      .eq("member_type", "student")
      .eq("is_active", true);

    if (error) throw error;

    // Get current group members to check who's already in the target group
    const { data: currentMembers, error: membersError } = await supabase
      .from("user_groups")
      .select("user_id")
      .eq("group_id", currentGroupId)
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

    console.log(
      "Current member IDs in target group:",
      Array.from(currentMemberIds)
    );

    const formattedStudents = students.map((item) => {
      const isInGroup = currentMemberIds.has(item.users.id);
      console.log(`Student ${item.users.full_name}: isInGroup = ${isInGroup}`);

      return {
        id: item.users.id,
        full_name: item.users.full_name,
        register_number: item.users.register_number,
        isInGroup, // This is the key field that tells frontend if student is already in group
      };
    });

    console.log("Formatted students with isInGroup:", formattedStudents);

    res.json({
      success: true,
      students: formattedStudents,
    });
  } catch (error) {
    console.error("Error in get students:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch students",
    });
  }
});

// Create group (simple version)
router.post("/create", authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== "faculty") {
      return res.status(403).json({
        success: false,
        message: "Only faculty can create groups",
      });
    }

    const { name, description, academic_year } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Group name is required",
      });
    }

    if (name.length > 50) {
      return res.status(400).json({
        success: false,
        message: "Group name cannot exceed 50 characters",
      });
    }

    if (description && description.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Description cannot exceed 100 characters",
      });
    }

    const { data: group, error } = await supabase
      .from("groups")
      .insert({
        name: name.trim(),
        description: description?.trim() || null,
        academic_year: academic_year?.trim() || null,
        org_id: req.user.org_id,
        created_by: req.user.id,
        is_default: false,
      })
      .select()
      .single();

    if (error) throw error;

    // Add creator as a member
    await supabase.from("user_groups").insert({
      group_id: group.id,
      user_id: req.user.id,
      member_type: "teacher",
      added_by: req.user.id,
      is_active: true,
    });

    res.json({
      success: true,
      group,
    });
  } catch (error) {
    console.error("Error creating group:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create group",
    });
  }
});

// GENERIC ROUTES COME LAST - Get single group (with parent-child validation)
router.get(
  "/:groupId",
  authenticateToken,
  parentChildValidator,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { childId } = req.query;

      console.log("Get single group - Group ID:", groupId);
      console.log("Get single group - User role:", req.user.role);
      console.log("Get single group - User org ID:", req.user.org_id);

      let targetUserId = req.user.id;
      let targetOrgId = req.user.org_id;

      // Handle parent requests
      if (req.user.role === "parent") {
        if (!childId) {
          return res.status(400).json({
            success: false,
            message: "Child ID is required for parent users",
          });
        }

        // The parentChildValidator middleware has already validated the relationship
        // and set req.validatedChild
        if (!req.validatedChild) {
          return res.status(403).json({
            success: false,
            message: "Child not found or access denied",
          });
        }

        targetUserId = childId;
        targetOrgId = req.validatedChild.org_id;
      }

      console.log("fetchSingleGroup - Group ID:", groupId);
      console.log("fetchSingleGroup - User ID:", targetUserId);
      console.log("fetchSingleGroup - Org ID:", targetOrgId);

      // Check if the user is a member of the group
      const isMember = await isUserMemberOfGroup(
        targetUserId,
        groupId,
        targetOrgId
      );

      if (!isMember) {
        return res.status(403).json({
          success: false,
          message: "You are not a member of this group",
        });
      }

      // Fetch the group details
      const { data: group, error: groupError } = await supabase
        .from("groups")
        .select("*")
        .eq("id", groupId)
        .eq("org_id", targetOrgId)
        .eq("archived", false)
        .single();

      if (groupError) {
        console.error("Group not found or doesn't belong to org:", groupError);
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      res.json({
        success: true,
        group,
      });
    } catch (error) {
      console.error("Error fetching single group:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch group",
      });
    }
  }
);

module.exports = router;
