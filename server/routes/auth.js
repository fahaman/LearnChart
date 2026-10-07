import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import nodemailer from "nodemailer";
import twilio from "twilio";
import { Resend } from "resend";
import User from "../models/User.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();
const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET || "learnchart_secret_123", { expiresIn: "30d" });

const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY.trim()) : null;

// Configure Gmail transporter using official service preset
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER ? process.env.EMAIL_USER.trim() : "",
    pass: process.env.EMAIL_PASS ? process.env.EMAIL_PASS.trim() : ""
  }
});

// Initialize Twilio client securely
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_ACCOUNT_SID.trim().startsWith("AC") && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID.trim(), process.env.TWILIO_AUTH_TOKEN.trim())
  : null;

// Temporary in-memory store for OTPs
const otpStore = new Map();

// Helper to send email via Gmail SMTP or Resend
const sendEmailOtp = async (email, otp) => {
  let emailSent = false;
  let lastError = null;

  // 1. Try Gmail Nodemailer first (Sends to ANY email address)
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
      await transporter.sendMail({
        from: `"LearnChart" <${process.env.EMAIL_USER.trim()}>`,
        to: email.trim(),
        subject: "LearnChart - Verification Code",
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; background-color: #f9fafb; border-radius: 8px;">
            <h2 style="color: #111827;">LearnChart Verification Code</h2>
            <p>Your OTP code for registration is:</p>
            <h1 style="color: #d97706; letter-spacing: 6px; font-size: 32px; background: #fff; display: inline-block; padding: 10px 20px; border-radius: 6px; border: 1px solid #e5e7eb;">${otp}</h1>
            <p style="color: #6b7280; font-size: 14px;">This code will expire in 5 minutes. Do not share this code with anyone.</p>
          </div>
        `
      });
      emailSent = true;
      console.log(`[NODEMAILER GMAIL] Sent successfully to ${email}`);
    } catch (err) {
      lastError = err.message;
      console.error("[NODEMAILER GMAIL ERROR]", err.message);
    }
  }

  // 2. Try Resend SDK fallback if Nodemailer was not used or failed
  if (!emailSent && resendClient) {
    try {
      const data = await resendClient.emails.send({
        from: "LearnChart <onboarding@resend.dev>",
        to: [email.trim()],
        subject: "LearnChart - Verification Code",
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; background-color: #f9fafb; border-radius: 8px;">
            <h2 style="color: #111827;">LearnChart Verification Code</h2>
            <p>Your OTP code for registration is:</p>
            <h1 style="color: #d97706; letter-spacing: 6px; font-size: 32px; background: #fff; display: inline-block; padding: 10px 20px; border-radius: 6px; border: 1px solid #e5e7eb;">${otp}</h1>
            <p style="color: #6b7280; font-size: 14px;">This code will expire in 5 minutes. Do not share this code with anyone.</p>
          </div>
        `,
      });
      if (data && data.id) {
        emailSent = true;
        console.log(`[RESEND EMAIL] Sent successfully to ${email} (ID: ${data.id})`);
      } else if (data && data.error) {
        lastError = data.error.message;
        console.error("[RESEND EMAIL ERROR]", data.error);
      }
    } catch (err) {
      lastError = err.message;
      console.error("[RESEND SDK EXCEPTION]", err.message);
    }
  }

  return { emailSent, lastError };
};

router.post("/send-otp", async (req, res) => {
  const { phone, email } = req.body;
  if (!phone && !email) return res.status(400).json({ error: "Phone or email is required" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpData = { otp, expires: Date.now() + 300000 };

  // Store by both phone and email so verification always matches
  if (phone) otpStore.set(phone.trim(), otpData);
  if (email) otpStore.set(email.trim().toLowerCase(), otpData);

  console.log("-----------------------");
  console.log(`OTP generated for ${phone} / ${email || 'No Email'}: ${otp}`);
  console.log("-----------------------");

  // Send SMS via Twilio if available
  if (phone && twilioClient && process.env.TWILIO_PHONE_NUMBER) {
    try {
      const formattedPhone = phone.trim().startsWith("+") ? phone.trim() : `+91${phone.trim()}`;
      await twilioClient.messages.create({
        body: `Your LearnChart verification code is: ${otp}. It will expire in 5 minutes.`,
        from: process.env.TWILIO_PHONE_NUMBER.trim(),
        to: formattedPhone
      });
      console.log(`[SMS] Successfully sent to ${formattedPhone}`);
    } catch (err) {
      console.error("[SMS ERROR]", err.message);
    }
  }

  // Send Email
  if (email) {
    const { emailSent, lastError } = await sendEmailOtp(email, otp);
    if (!emailSent) {
      return res.status(500).json({ 
        error: `Failed to deliver email: ${lastError || 'Could not connect to email service'}. Please check your email address.` 
      });
    }
  }

  res.json({ message: "OTP sent successfully to your email!" });
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

  // Verify OTP by email or phone
  const stored = otpStore.get(email?.trim().toLowerCase()) || otpStore.get(phone?.trim());
  if (!stored || stored.otp !== otp || stored.expires < Date.now()) {
    return res.status(400).json({ error: "Invalid or expired OTP. Please click Resend OTP." });
  }
  if (email) otpStore.delete(email.trim().toLowerCase());
  if (phone) otpStore.delete(phone.trim());

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
