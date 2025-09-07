const express = require("express");
const supabase = require("../config/supabase");
const {
  generateOTP,
  storeOTP,
  verifyOTP,
  getRemainingAttempts,
} = require("../utils/otp");
const { generateToken } = require("../utils/jwt");
const { comparePassword } = require("../utils/password");
const { authenticateToken } = require("../middleware/auth");
const redis = require("../config/redis");

const router = express.Router();

// Phone number validation
const validatePhoneNumber = (phoneNumber) => {
  return /^[6-9]\d{9}$/.test(phoneNumber); // Indian mobile numbers
};

// Send OTP to phone number
router.post("/send-otp", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber || !validatePhoneNumber(phoneNumber)) {
      return res
        .status(400)
        .json({ error: "Valid 10-digit Indian mobile number required" });
    }

    // Check for OTP request rate limiting (separate from general rate limiting)
    const otpRateKey = `otp_rate:${phoneNumber}`;
    const recentRequests = (await redis.get(otpRateKey)) || 0;

    if (parseInt(recentRequests) >= 3) {
      return res.status(429).json({
        error: "Too many OTP requests. Please try again in 15 minutes",
      });
    }

    // IP-based OTP protection (prevents enumeration attacks)
    const ipOtpKey = `ip_otp:${req.ip}`;
    const ipOtpCount = (await redis.get(ipOtpKey)) || 0;

    if (parseInt(ipOtpCount) >= 100) {
      return res.status(429).json({
        error:
          "Too many OTP requests from this location. Please try again in 1 minute.",
      });
    }

    // Check if user exists
    const { data: user, error } = await supabase
      .from("users")
      .select("phone_number, role, is_active, org_id")
      .eq("phone_number", phoneNumber)
      .single();

    if (error || !user) {
      return res.status(404).json({
        error:
          "Phone number not registered. Please contact admin to create your account.",
      });
    }

    if (!user.is_active) {
      return res
        .status(403)
        .json({ error: "Account is deactivated. Please contact admin." });
    }

    // Ensure user has the right role for phone login (student/parent only)
    if (!["student", "parent"].includes(user.role)) {
      return res.status(403).json({
        error: "This phone number is not authorized for student/parent login.",
      });
    }

    // Generate and store OTP
    const otp = generateOTP();
    await storeOTP(phoneNumber, otp);

    // Increment OTP request counter (15 minutes window)
    await redis.incr(otpRateKey);
    await redis.expire(otpRateKey, 15 * 60); // 15 minutes

    // Increment IP OTP counter
    await redis.incr(ipOtpKey);
    await redis.expire(ipOtpKey, 60); // 1 minute

    // TODO: Send SMS using AWS SNS
    if (process.env.NODE_ENV === "development") {
      console.log(`📱 OTP for ${phoneNumber}: ${otp}`);
    }

    res.json({
      message: "OTP sent successfully",
      expiresIn: "100",
      attemptsRemaining: 3,
    });
  } catch (error) {
    console.error("Send OTP error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// Verify OTP and login
router.post("/verify-otp", async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;

    if (!phoneNumber || !otp || !validatePhoneNumber(phoneNumber)) {
      return res
        .status(400)
        .json({ error: "Valid phone number and OTP required" });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: "OTP must be 6 digits" });
    }

    // Verify OTP with attempt limiting
    const otpResult = await verifyOTP(phoneNumber, otp);
    if (!otpResult.success) {
      return res.status(400).json({ error: otpResult.error });
    }

    // Check if user exists - NO AUTO CREATION
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("phone_number", phoneNumber)
      .single();

    if (error || !user) {
      console.log(`❌ Login attempt with unregistered phone: ${phoneNumber}`);
      return res.status(404).json({
        error:
          "Phone number not registered. Please contact admin to create your account.",
      });
    }

    if (!user.is_active) {
      return res
        .status(403)
        .json({ error: "Account is deactivated. Please contact admin." });
    }

    // Ensure user has the right role for phone login (student/parent only)
    if (!["student", "parent"].includes(user.role)) {
      return res.status(403).json({
        error: "This phone number is not authorized for student/parent login.",
      });
    }

    // Generate JWT token
    const token = generateToken({
      userId: user.id,
      orgId: user.org_id,
    });

    // Log successful login
    console.log(`✅ Successful OTP login: ${phoneNumber} (${user.role})`);

    res.json({
      message: "Login successful",
      token,
      user: {
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Resend OTP
router.post("/resend-otp", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber || !validatePhoneNumber(phoneNumber)) {
      return res.status(400).json({ error: "Valid phone number required" });
    }

    // Check if user exists
    const { data: user, error } = await supabase
      .from("users")
      .select("role, is_active")
      .eq("phone_number", phoneNumber)
      .single();

    if (error || !user) {
      return res.status(404).json({
        error:
          "Phone number not registered. Please contact admin to create your account.",
      });
    }

    if (!user.is_active) {
      return res
        .status(403)
        .json({ error: "Account is deactivated. Please contact admin." });
    }

    // Generate and store new OTP
    const otp = generateOTP();
    await storeOTP(phoneNumber, otp);

    if (process.env.NODE_ENV === "development") {
      console.log(`📱 Resent OTP for ${phoneNumber}: ${otp}`);
    }

    res.json({
      message: "OTP resent successfully",
      expiresIn: "100",
      attemptsRemaining: 3,
    });
  } catch (error) {
    console.error("Resend OTP error:", error);
    res.status(500).json({ error: "Failed to resend OTP" });
  }
});

// Faculty login with enhanced security
router.post("/faculty-login", async (req, res) => {
  try {
    const { username, password } = req.body;

    // Input validation - but don't reveal specific requirements
    if (
      !username ||
      !password ||
      username.length < 3 ||
      username.length > 50 ||
      password.length < 1
    ) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // IP-based login protection (prevents username enumeration)
    const ipLoginKey = `ip_login:${req.ip}`;
    const ipLoginCount = (await redis.get(ipLoginKey)) || 0;

    if (parseInt(ipLoginCount) >= 100) {
      return res.status(429).json({
        error:
          "Too many login attempts from this location. Please try again in 1 minute.",
      });
    }

    // Get user from database
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", username.toLowerCase()) // Case insensitive
      .in("role", ["faculty", "admin"])
      .single();

    if (error || !user) {
      // Increment IP login counter (for both successful and failed attempts)
      await redis.incr(ipLoginKey);
      await redis.expire(ipLoginKey, 60); // 1 minute
      // Log failed login attempt
      console.log(`❌ Failed login attempt: ${username} (user not found)`);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (!user.is_active) {
      // Increment IP login counter (for both successful and failed attempts)
      await redis.incr(ipLoginKey);
      await redis.expire(ipLoginKey, 60); // 1 minute
      console.log(`❌ Login attempt on deactivated account: ${username}`);
      return res.status(403).json({ error: "Account is deactivated" });
    }

    // Check if account is locked
    if (user.locked_until && new Date() < new Date(user.locked_until)) {
      // Increment IP login counter (for both successful and failed attempts)
      await redis.incr(ipLoginKey);
      await redis.expire(ipLoginKey, 60); // 1 minute
      const lockTimeRemaining = Math.ceil(
        (new Date(user.locked_until) - new Date()) / 1000 / 60
      );
      console.log(`❌ Login attempt on locked account: ${username}`);
      return res.status(423).json({
        error: `Account is locked. Try again in ${lockTimeRemaining} minutes`,
      });
    }

    // Verify password
    const isValidPassword = await comparePassword(password, user.password_hash);

    if (!isValidPassword) {
      // Increment failed attempts
      const newFailedAttempts = (user.failed_attempts || 0) + 1;
      const updateData = {
        failed_attempts: newFailedAttempts,
        updated_at: new Date().toISOString(),
      };

      // Lock account after 3 failed attempts
      if (newFailedAttempts >= 3) {
        const lockUntil = new Date();
        lockUntil.setMinutes(lockUntil.getMinutes() + 30);
        updateData.locked_until = lockUntil.toISOString();
      }

      await supabase.from("users").update(updateData).eq("id", user.id);

      // Increment IP login counter (for both successful and failed attempts)
      await redis.incr(ipLoginKey);
      await redis.expire(ipLoginKey, 60); // 1 minute

      console.log(
        `❌ Failed password for: ${username} (${newFailedAttempts}/3 attempts)`
      );

      if (newFailedAttempts >= 3) {
        return res.status(423).json({
          error: `Account locked after 3 failed attempts. Try again in 30 minutes`,
        });
      }

      return res.status(401).json({
        error: `Invalid credentials. ${
          3 - newFailedAttempts
        } attempts remaining`,
      });
    }

    // Reset failed attempts on successful login
    await supabase
      .from("users")
      .update({
        failed_attempts: 0,
        locked_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    // Increment IP login counter (for both successful and failed attempts)
    await redis.incr(ipLoginKey);
    await redis.expire(ipLoginKey, 60); // 1 minute

    // Generate JWT token
    const token = generateToken({
      userId: user.id,
      orgId: user.org_id,
    });

    console.log(`✅ Successful faculty login: ${username} (${user.role})`);

    res.json({
      message: "Login successful",
      token,
      user: {
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Faculty login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;
