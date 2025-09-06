const redis = require("../config/redis");

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const storeOTP = async (phoneNumber, otp) => {
  const otpKey = `otp:${phoneNumber}`;
  const attemptsKey = `otp_attempts:${phoneNumber}`;

  // Store OTP with expiry
  await redis.set(otpKey, otp, { ex: 100 });

  // Reset attempts counter when new OTP is generated
  await redis.set(attemptsKey, 0, { ex: 100 });
};

const verifyOTP = async (phoneNumber, inputOTP) => {
  const otpKey = `otp:${phoneNumber}`;
  const attemptsKey = `otp_attempts:${phoneNumber}`;

  // Check if OTP exists
  const storedOTP = await redis.get(otpKey);
  if (!storedOTP) {
    return { success: false, error: "OTP expired or not found" };
  }

  // Get current attempts
  let attempts = (await redis.get(attemptsKey)) || 0;
  attempts = parseInt(attempts);

  // Check if max attempts exceeded
  if (attempts >= 3) {
    // Invalidate OTP after 3 wrong attempts
    await redis.del(otpKey);
    await redis.del(attemptsKey);
    return {
      success: false,
      error: "OTP invalidated due to too many wrong attempts",
    };
  }

  // Check if OTP matches - convert both to strings for comparison
  if (String(storedOTP) !== String(inputOTP)) {
    // Increment attempts
    attempts += 1;
    await redis.set(attemptsKey, attempts, { ex: 100 });

    const remainingAttempts = 3 - attempts;
    if (remainingAttempts === 0) {
      // Invalidate OTP on 3rd wrong attempt
      await redis.del(otpKey);
      await redis.del(attemptsKey);
      return {
        success: false,
        error: "OTP invalidated due to too many wrong attempts",
      };
    }

    return {
      success: false,
      error: `Invalid OTP. ${remainingAttempts} attempt${
        remainingAttempts > 1 ? "s" : ""
      } remaining`,
    };
  }

  // OTP is correct - clean up
  await redis.del(otpKey);
  await redis.del(attemptsKey);
  return { success: true };
};

const deleteOTP = async (phoneNumber) => {
  const otpKey = `otp:${phoneNumber}`;
  const attemptsKey = `otp_attempts:${phoneNumber}`;
  await redis.del(otpKey);
  await redis.del(attemptsKey);
};

const getRemainingAttempts = async (phoneNumber) => {
  const attemptsKey = `otp_attempts:${phoneNumber}`;
  const attempts = (await redis.get(attemptsKey)) || 0;
  return Math.max(0, 3 - parseInt(attempts));
};

module.exports = {
  generateOTP,
  storeOTP,
  verifyOTP,
  deleteOTP,
  getRemainingAttempts,
};
