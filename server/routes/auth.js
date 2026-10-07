import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import nodemailer from "nodemailer";
import twilio from "twilio";
import User from "../models/User.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();
const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET || "learnchart_secret_123", { expiresIn: "30d" });

// Configure email transporter explicitly for Port 587 (TLS)
// This often bypasses firewall connection timeouts on cloud servers
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // true for 465, false for 587
  requireTLS: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Initialize Twilio client securely
// Initialize Twilio client securely with trim to prevent authentication issues
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_ACCOUNT_SID.trim().startsWith("AC") && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID.trim(), process.env.TWILIO_AUTH_TOKEN.trim())
  : null;

// Temporary in-memory store for OTPs (In production, use Redis or a DB)
const otpStore = new Map();

// Safe Twilio Diagnostic Route (Accessible at http://localhost:5000/api/auth/test-twilio-debug)
router.get("/test-twilio-debug", async (req, res) => {
  const mask = (str) => {
    if (!str) return "UNDEFINED/NULL";
    const clean = str.trim();
    if (clean.length <= 8) return "***TOO_SHORT***";
    return `${clean.substring(0, 4)}...${clean.substring(clean.length - 4)} (Length: ${clean.length})`;
  };

  const configState = {
    ACCOUNT_SID: mask(process.env.TWILIO_ACCOUNT_SID),
    AUTH_TOKEN: mask(process.env.TWILIO_AUTH_TOKEN),
    PHONE_NUMBER: mask(process.env.TWILIO_PHONE_NUMBER),
  };

  try {
    if (!twilioClient) {
      throw new Error("twilioClient is NULL - Initialization condition failed.");
    }
    
    // Attempt to fetch account details to verify credentials
    const account = await twilioClient.api.v2010.accounts(process.env.TWILIO_ACCOUNT_SID.trim()).fetch();
    
    return res.json({
      status: "Twilio Authenticated Successfully!",
      configState,
      accountName: account.friendlyName,
      accountType: account.type,
      accountStatus: account.status
    });
  } catch (err) {
    return res.status(500).json({
      status: "Twilio Connection Failed",
      configState,
      errorMessage: err.message,
      errorCode: err.code || "NO_CODE",
      errorStatus: err.status || "NO_STATUS",
      errorDetails: err
    });
  }
});

router.post("/send-otp", async (req, res) => {
  const { phone, email } = req.body;
  if (!phone && !email) return res.status(400).json({ error: "Phone or email is required" });

  // Key the OTP to the phone number for validation later
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(phone, { otp, expires: Date.now() + 300000 }); // 5 min expiry

  // Always log to terminal for development/testing
  console.log("-----------------------");
  console.log(`OTP for ${phone} / ${email || 'No Email'}: ${otp}`);
  console.log("-----------------------");

  // Send SMS OTP via Twilio if configured
  if (phone && twilioClient && process.env.TWILIO_PHONE_NUMBER) {
    try {
      // Auto-prefix standard 10-digit numbers with India country code (+91) as convenience 
      const formattedPhone = phone.trim().startsWith("+") ? phone.trim() : `+91${phone.trim()}`;
      await twilioClient.messages.create({
        body: `Your LearnChart verification code is: ${otp}. It will expire in 5 minutes.`,
        from: process.env.TWILIO_PHONE_NUMBER.trim(),
        to: formattedPhone
      });
      console.log(`[SMS] Successfully sent to ${formattedPhone}`);
    } catch (err) {
      console.error("[SMS ERROR] Failed to send SMS:", err.message);
    }
  } else {
    console.log("[SMS SKIPPED] Twilio credentials not fully configured in .env.");
  }

  if (email) {
    let emailSent = false;

    // Try Resend API first (fast and cloud-firewall friendly)
    if (process.env.RESEND_API_KEY) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          },
          body: JSON.stringify({
            from: "LearnChart <onboarding@resend.dev>",
            to: [email],
            subject: "LearnChart - Verification Code",
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2>LearnChart Verification Code</h2>
                <p>Your OTP code is:</p>
                <h1 style="color: #d97706; letter-spacing: 5px;">${otp}</h1>
                <p>This code will expire in 5 minutes.</p>
              </div>
            `,
          }),
        });

        if (res.ok) {
          emailSent = true;
          console.log(`[RESEND EMAIL] Successfully sent to ${email}`);
        } else {
          const errData = await res.json();
          console.error("[RESEND EMAIL ERROR]", errData);
        }
      } catch (err) {
        console.error("[RESEND API ERROR]", err.message);
      }
    }

    // Fallback to Nodemailer if Resend was not used or failed
    if (!emailSent && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      try {
        await transporter.sendMail({
          from: `"LearnChart" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: "LearnChart - Verification Code",
          text: `Your verification code is: ${otp}\n\nIt will expire in 5 minutes.`
        });
        emailSent = true;
        console.log(`[NODEMAILER EMAIL] Successfully sent to ${email}`);
      } catch (err) {
        console.error("[NODEMAILER EMAIL ERROR] Failed to send email:", err.message);
      }
    }
  }

  res.json({ message: "OTP sent successfully" });
});

router.post("/register", async (req, res) => {
  const { name, username, email, phone, password, otp } = req.body;
  
  // Validations
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
  const usernameRegex = /^\S+$/;
  const nameRegex = /^[a-zA-Z\s]+$/;
  const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

  if (!name || !username || !email || !phone || !password || !otp) {
    return res.status(400).json({ error: "All fields including OTP are required" });
  }

  // Verify OTP
  const stored = otpStore.get(phone);
  if (!stored || stored.otp !== otp || stored.expires < Date.now()) {
    return res.status(400).json({ error: "Invalid or expired OTP" });
  }
  otpStore.delete(phone); // Clear OTP after use

  if (name.length > 50 || !nameRegex.test(name)) {
    return res.status(400).json({ error: "Name should only contain letters and be max 50 characters" });
  }

  if (!usernameRegex.test(username)) {
    return res.status(400).json({ error: "Username cannot contain spaces" });
  }

  if (!gmailRegex.test(email)) {
    return res.status(400).json({ error: "Please provide a valid Gmail address (@gmail.com)" });
  }

  if (!passwordRegex.test(password)) {
    return res.status(400).json({ error: "Password must be at least 8 characters long and contain at least one uppercase letter and one number" });
  }

  try {
    const userExists = await User.findOne({ $or: [{ email }, { username }] });
    if (userExists) {
      if (userExists.email === email) {
        return res.status(400).json({ error: "Email already registered" });
      }
      return res.status(400).json({ error: "Username already taken" });
    }

    const user = await User.create({ name, username, email, phone, password });
    if (user) {
      res.status(201).json({
        id: user._id,
        name: user.name,
        username: user.username,
        email: user.email,
        phone: user.phone,
        cash_balance: user.cash_balance,
        role: user.role,
        token: generateToken(user._id),
      });
    } else {
      res.status(400).json({ error: "Invalid user data" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/login", async (req, res) => {
  let { email, password } = req.body;
  email = email?.trim();
  try {
    const user = await User.findOne({ email });
    if (user && (await user.matchPassword(password))) {
      res.json({
        id: user._id,
        name: user.name,
        username: user.username,
        email: user.email,
        phone: user.phone,
        cash_balance: user.cash_balance,
        role: user.role,
        token: generateToken(user._id),
      });
    } else {
      res.status(401).json({ error: "Invalid email or password" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/me", protect, async (req, res) => {
  res.json({
    id: req.user._id,
    name: req.user.name,
    username: req.user.username,
    email: req.user.email,
    phone: req.user.phone,
    cash_balance: req.user.cash_balance,
    role: req.user.role,
  });
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      // Don't reveal if user exists for security
      return res.status(200).json({ message: "If a user with that email exists, a reset link has been sent." });
    }

    const resetToken = crypto.randomBytes(20).toString("hex");
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour

    await user.save();

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:8080'}/reset-password/${resetToken}`;
    
    // For now, log the reset URL to console since nodemailer isn't installed
    console.log("-----------------------");
    console.log("PASSWORD RESET REQUEST");
    console.log(`Email: ${email}`);
    console.log(`Reset URL: ${resetUrl}`);
    console.log("-----------------------");

    res.status(200).json({ message: "If a user with that email exists, a reset link has been sent." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/reset-password/:token", async (req, res) => {
  const { password } = req.body;
  const { token } = req.params;

  try {
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: "Password reset token is invalid or has expired." });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    res.status(200).json({ message: "Password has been reset successfully." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
