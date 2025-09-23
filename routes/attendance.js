const express = require("express");
const supabase = require("../config/supabase");
const { authenticateToken } = require("../middleware/auth");
const parentChildValidator = require("../middleware/parentChildValidator");
const ExcelJS = require("exceljs");

const router = express.Router();

// Get attendance for a specific date
router.get(
  "/:groupId/:date",
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
      const { groupId, date } = req.params;
      const userRole = req.user.role;
      const userId = req.user.id;

      console.log("🔍 GET /attendance - Full request details:", {
        groupId,
        date,
        userRole,
        userId,
        query: req.query,
        body: req.body,
        headers: req.headers,
      });

      let targetUserId = userId;

      // If user is a parent, use validated child
      if (userRole === "parent") {
        console.log(" Parent user - validatedChild:", req.validatedChild);
        if (!req.validatedChild || !req.validatedChild.childId) {
          console.log("❌ Parent validation failed - no validatedChild");
          return res.status(400).json({
            success: false,
            message: "Parent-child validation failed",
          });
        }
        targetUserId = req.validatedChild.childId;
        console.log(
          "✅ Parent validation successful, targetUserId:",
          targetUserId
        );
      }

      console.log(" Final targetUserId:", targetUserId);

      // Check if user has access to this group
      console.log(
        " Checking group access for user:",
        targetUserId,
        "in group:",
        groupId
      );
      const { data: userGroup, error: userGroupError } = await supabase
        .from("user_groups")
        .select("id, member_type")
        .eq("user_id", targetUserId)
        .eq("group_id", groupId)
        .eq("is_active", true)
        .single();

      console.log("📊 Group access query result:", {
        userGroup,
        userGroupError,
      });

      if (userGroupError || !userGroup) {
        console.log("❌ Group access denied:", userGroupError);
        return res.status(403).json({
          success: false,
          message: "Access denied to this group",
        });
      }

      console.log("✅ Group access confirmed:", userGroup);

      // For students and parents, only show their own attendance
      if (userRole === "student" || userRole === "parent") {
        console.log(
          "👤 Fetching individual attendance for user:",
          targetUserId
        );

        const { data: attendance, error: attendanceError } = await supabase
          .from("attendance")
          .select("*")
          .eq("group_id", groupId)
          .eq("user_id", targetUserId)
          .eq("attendance_date", date)
          .single();

        console.log("📊 Individual attendance query result:", {
          attendance,
          attendanceError,
        });

        const { data: user, error: userError } = await supabase
          .from("users")
          .select("id, full_name, register_number")
          .eq("id", targetUserId)
          .single();

        console.log(" User query result:", { user, userError });

        if (userError) {
          console.log("❌ Error fetching user:", userError);
          return res.status(500).json({
            success: false,
            message: "Error fetching user information",
          });
        }

        const attendanceData = [
          {
            user_id: user.id,
            name: user.full_name,
            register_number: user.register_number,
            status: attendance?.status || null,
            is_marked: !!attendance,
          },
        ];

        console.log("✅ Individual attendance data prepared:", attendanceData);

        return res.json({
          success: true,
          data: {
            date,
            attendance: attendanceData,
            is_attendance_marked: !!attendance,
            user_role: userRole,
          },
        });
      }

      // For teachers, show all students' attendance
      if (userRole === "faculty") {
        console.log(" Faculty user - checking teacher access to group");

        // First check if teacher has access to this group
        const { data: teacherGroup, error: teacherGroupError } = await supabase
          .from("user_groups")
          .select("id, member_type")
          .eq("user_id", userId)
          .eq("group_id", groupId)
          .eq("member_type", "teacher")
          .eq("is_active", true)
          .single();

        console.log(" Teacher group access query result:", {
          teacherGroup,
          teacherGroupError,
        });

        if (teacherGroupError || !teacherGroup) {
          console.log("❌ Teacher access denied:", teacherGroupError);
          return res.status(403).json({
            success: false,
            message: "Only teachers can view group attendance",
          });
        }

        console.log("✅ Teacher access confirmed, fetching all students");

        // Get group members (students only)
        const { data: members, error: membersError } = await supabase
          .from("user_groups")
          .select(
            `
            users!user_groups_user_id_fkey(
              id,
              full_name,
              register_number
            )
          `
          )
          .eq("group_id", groupId)
          .eq("is_active", true)
          .eq("member_type", "student")
          .order("users(register_number)", { ascending: true, nullsLast: true })
          .order("users(full_name)", { ascending: true });

        console.log(" Members query result:", { members, membersError });

        if (membersError) {
          console.log("❌ Error fetching members:", membersError);
          return res.status(500).json({
            success: false,
            message: "Error fetching group members",
          });
        }

        // Get existing attendance
        const { data: attendance, error: attendanceError } = await supabase
          .from("attendance")
          .select("*")
          .eq("group_id", groupId)
          .eq("attendance_date", date);

        console.log("📊 Attendance query result:", {
          attendance,
          attendanceError,
        });

        if (attendanceError) {
          console.log("❌ Error fetching attendance:", attendanceError);
          return res.status(500).json({
            success: false,
            message: "Error fetching attendance",
          });
        }

        // Create attendance map
        const attendanceMap = {};
        attendance?.forEach((record) => {
          attendanceMap[record.user_id] = record.status;
        });

        // Format response
        const attendanceData = members.map((member) => ({
          user_id: member.users.id,
          name: member.users.full_name,
          register_number: member.users.register_number,
          status: attendanceMap[member.users.id] || null,
          is_marked: !!attendanceMap[member.users.id],
        }));

        console.log("✅ Faculty attendance data prepared:", attendanceData);

        return res.json({
          success: true,
          data: {
            date,
            attendance: attendanceData,
            is_attendance_marked: attendance && attendance.length > 0,
            user_role: userRole,
          },
        });
      }

      console.log("❌ Invalid user role:", userRole);
      return res.status(403).json({
        success: false,
        message: "Invalid user role",
      });
    } catch (error) {
      console.error("❌ Error in get attendance:", error);
      console.error("❌ Error stack:", error.stack);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Mark attendance (teachers only)
router.post("/:groupId/:date", authenticateToken, async (req, res) => {
  try {
    const { groupId, date } = req.params;
    const { attendance_records } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (userRole !== "faculty") {
      return res.status(403).json({
        success: false,
        message: "Only teachers can mark attendance",
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
        message: "Only teachers can mark attendance",
      });
    }

    if (!attendance_records || !Array.isArray(attendance_records)) {
      return res.status(400).json({
        success: false,
        message: "Invalid attendance records",
      });
    }

    // Get register numbers for users
    const userIds = attendance_records.map((record) => record.user_id);
    const { data: users, error: usersError } = await supabase
      .from("users")
      .select("id, register_number")
      .in("id", userIds);

    if (usersError) {
      return res.status(500).json({
        success: false,
        message: "Error fetching user data",
      });
    }

    const registerNumberMap = {};
    users?.forEach((user) => {
      registerNumberMap[user.id] = user.register_number;
    });

    // Prepare upsert data
    const upsertData = attendance_records.map((record) => ({
      group_id: groupId,
      user_id: record.user_id,
      register_number: registerNumberMap[record.user_id] || null,
      attendance_date: date,
      status: record.status,
      marked_by: userId,
    }));

    // Upsert attendance records
    const { data, error } = await supabase
      .from("attendance")
      .upsert(upsertData, {
        onConflict: "group_id,user_id,attendance_date",
      })
      .select();

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Error marking attendance",
      });
    }

    res.json({
      success: true,
      message: "Attendance marked successfully",
      data,
    });
  } catch (error) {
    console.error("❌ Error marking attendance:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// Add this export route after the existing routes
router.get(
  "/:groupId/export/:startDate/:endDate",
  authenticateToken,
  async (req, res) => {
    try {
      const { groupId, startDate, endDate } = req.params;
      const userId = req.user.id;
      const userRole = req.user.role;

      // Only teachers can export attendance
      if (userRole !== "faculty") {
        return res.status(403).json({
          success: false,
          message: "Only teachers can export attendance",
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
          message: "Only teachers can export attendance",
        });
      }

      // Get group information
      const { data: group, error: groupError } = await supabase
        .from("groups")
        .select("name")
        .eq("id", groupId)
        .single();

      if (groupError || !group) {
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      // Get all students in the group
      const { data: members, error: membersError } = await supabase
        .from("user_groups")
        .select(
          `
        users!user_groups_user_id_fkey(
          id,
          full_name,
          register_number
        )
      `
        )
        .eq("group_id", groupId)
        .eq("is_active", true)
        .eq("member_type", "student")
        .order("users(register_number)", { ascending: true, nullsLast: true })
        .order("users(full_name)", { ascending: true });

      if (membersError) {
        return res.status(500).json({
          success: false,
          message: "Error fetching group members",
        });
      }

      // Get attendance records for the date range
      const { data: attendance, error: attendanceError } = await supabase
        .from("attendance")
        .select("*")
        .eq("group_id", groupId)
        .gte("attendance_date", startDate)
        .lte("attendance_date", endDate)
        .order("attendance_date", { ascending: true });

      if (attendanceError) {
        return res.status(500).json({
          success: false,
          message: "Error fetching attendance records",
        });
      }

      // Create Excel workbook
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Attendance Report");

      // Set up columns
      worksheet.columns = [
        { header: "Group Name", key: "groupName", width: 20 },
        { header: "Student Name", key: "studentName", width: 25 },
        { header: "Register Number", key: "registerNumber", width: 15 },
        { header: "Date", key: "date", width: 12 },
        { header: "Status", key: "status", width: 10 },
      ];

      // Style the header row
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE6E6FA" },
      };

      // Group attendance by date
      const attendanceByDate = {};
      attendance?.forEach((record) => {
        if (!attendanceByDate[record.attendance_date]) {
          attendanceByDate[record.attendance_date] = {};
        }
        attendanceByDate[record.attendance_date][record.user_id] =
          record.status;
      });

      // Generate date range
      const start = new Date(startDate);
      const end = new Date(endDate);
      const dates = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(d.toISOString().split("T")[0]);
      }

      // Add data rows
      members?.forEach((member) => {
        dates.forEach((date) => {
          const status =
            attendanceByDate[date]?.[member.users.id] || "Not Marked";
          const statusText =
            status === "present"
              ? "Present"
              : status === "absent"
              ? "Absent"
              : "Not Marked";

          worksheet.addRow({
            groupName: group.name,
            studentName: member.users.full_name,
            registerNumber: member.users.register_number || "N/A",
            date: new Date(date).toLocaleDateString(),
            status: statusText,
          });
        });
      });

      // Auto-fit columns
      worksheet.columns.forEach((column) => {
        column.width = Math.max(column.width || 10, 15);
      });

      // Set response headers
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="attendance_${group.name}_${startDate}_to_${endDate}.xlsx"`
      );

      // Write Excel file to response
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      console.error("Error exporting attendance:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

module.exports = router;
