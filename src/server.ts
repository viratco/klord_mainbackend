import dotenv from 'dotenv';
import path from 'path';
// Load .env from both local and parent directory (local takes priority)
dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({ path: path.join(process.cwd(), '..', '.env') });
import express, { Request, Response } from 'express';
import fs from 'fs';
import https from 'https';
import multerPkg from 'multer';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { protect, AuthenticatedRequest } from './middleware/auth.js';
import { JWT_SECRET } from './config.js';
import admin from 'firebase-admin';
import { generateCertificatePDF } from './services/certificateService.js';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
// Twilio OTP sending removed; using console OTP for development
import { sendEmailOTP } from './services/emailService.js';

// Simple in-memory OTP store (for development only)
type OtpRecord = { code: string; expiresAt: number; attempts: number };
const otpStore = new Map<string, OtpRecord>();
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OTP_MAX_ATTEMPTS = 5;

const app = express();
const prisma = new PrismaClient();

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    console.log('[Firebase Admin] Initialized successfully');
  } catch (error) {
    console.warn('[Firebase Admin] Initialization failed - verify-firebase-token will not work', error);
  }
}

app.use(cors());
// Explicit preflight for safety (some clients are picky on mobile networks)
app.options('*', cors());
app.use(express.json());

// File uploads setup
const multer: any = multerPkg as any;
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

function normalizeReferralInput(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return null;
  if (trimmed.startsWith('KLORD-')) return trimmed;
  return `KLORD-${trimmed}`;
}

// Helpers for booking code generation
function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }
function monthWindow(d = new Date()): { start: Date; end: Date } {
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based
  const start = new Date(y, m, 1, 0, 0, 0, 0);
  const end = new Date(y, m + 1, 1, 0, 0, 0, 0);
  return { start, end };
}

async function generateUniqueReferralCode(length = 8): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const prefix = 'KLORD-';
  while (true) {
    let base = '';
    for (let i = 0; i < length; i++) {
      base += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const full = `${prefix}${base}`;
    const existing = await (prisma as any).customer.findUnique({ where: { referralCode: full } });
    if (!existing) return full;
  }
}

async function signIfS3Url(url: string): Promise<string> {
  const key = getS3KeyFromUrl(url);
  if (key && AWS_S3_BUCKET) {
    try {
      const cmd = new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key });
      // 1 hour expiry is fine for feed images; adjust as needed
      return await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    } catch (e) {
      console.warn('[s3] failed to sign url for', key, e);
      return url; // fall back to original url
    }
  }
  return url;
}

// Use memory storage for images that will be sent to S3
const storage = multer.memoryStorage();

// S3 client configuration
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || '';
const s3 = new S3Client({ region: AWS_REGION });

function buildS3PublicUrl(key: string): string {
  const bucket = AWS_S3_BUCKET;
  const region = AWS_REGION;
  // Standard virtual-hosted–style URL
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(key)}`;
}

function getS3KeyFromUrl(url: string): string | null {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://dummy${url}`);
    const host = u.host;
    if (host.includes(`${AWS_S3_BUCKET}.s3.`)) {
      // Real S3 URL: path starts with '/<key>'
      return decodeURIComponent(u.pathname.replace(/^\//, ''));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Calculate dueDays in real-time based on actual elapsed time
 * @param steps - Array of steps for a booking, ordered by 'order' ASC
 * @param bookingCreatedAt - When the booking was created
 * @returns Steps with calculated dueDays field
 */
function calculateDueDays(steps: any[], bookingCreatedAt: Date): any[] {
  console.log(`[CALC] Starting calculation for ${steps.length} steps, bookingCreatedAt=${bookingCreatedAt}`);

  // Sort steps by order to ensure correct sequence
  const sortedSteps = [...steps].sort((a, b) => (a.order || 0) - (b.order || 0));

  return sortedSteps.map((step, index) => {
    // Completed steps always have dueDays = 0
    if (step.completed) {
      console.log(`[CALC] Step ${index}: "${step.name}" - COMPLETED, dueDays=0`);
      return { ...step, dueDays: 0 };
    }

    // Find when this step became active (when previous step was completed)
    let startDate: Date | null = null;

    if (index === 0) {
      // First step starts when booking was created
      startDate = new Date(bookingCreatedAt);
      console.log(`[CALC] Step ${index}: "${step.name}" - First step, using bookingCreatedAt`);
    } else {
      // Step starts when previous step was completed
      const prevStep = sortedSteps[index - 1];
      if (prevStep && prevStep.completed && prevStep.completedAt) {
        startDate = new Date(prevStep.completedAt);
        console.log(`[CALC] Step ${index}: "${step.name}" - Prev step completed at ${prevStep.completedAt}`);
      } else {
        // Previous step not completed - this step is not active yet
        console.log(`[CALC] Step ${index}: "${step.name}" - Prev step NOT completed, dueDays=0`);
        return { ...step, dueDays: 0 };
      }
    }

    // Calculate CALENDAR DAYS (not 24-hour periods)
    // Dec 12 to Dec 14 = 2 calendar days
    const now = new Date();

    // Get just the date part (ignore time)
    const startDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Calculate difference in days
    const calendarDays = Math.floor((today.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24));

    // dueDays = calendar days since step became active (minimum 1, max 5)
    const dueDays = Math.min(Math.max(calendarDays, 1), 5);

    console.log(`[CALC] Step ${index}: "${step.name}" - startDay=${startDay.toDateString()}, today=${today.toDateString()}, calendarDays=${calendarDays}, RESULT dueDays=${dueDays}`);

    return { ...step, dueDays };
  });
}

// Admin: force regenerate certificate for a lead
app.post('/api/admin/leads/:id/certificate/regenerate', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const lead = await (prisma as any).booking.findUnique({ where: { id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const steps = await (prisma as any).leadStep.findMany({ where: { leadId: id } });
    const latestCompletedAt = steps
      .map((s: any) => (s.completedAt ? new Date(s.completedAt) : null))
      .filter((d: Date | null) => !!d)
      .sort((a: Date | null, b: Date | null) => (a!.getTime() - b!.getTime()))
      .pop() as Date | undefined;
    const installDate = (latestCompletedAt || new Date()).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
    const location = [lead.city, lead.state, lead.country].filter(Boolean).join(', ');
    const certificateId = `${id.slice(0, 6).toUpperCase()}-${Date.now().toString().slice(-6)}`;
    const { publicUrl } = await generateCertificatePDF({
      leadId: id,
      customerName: lead.fullName,
      projectType: lead.projectType,
      sizedKW: lead.sizedKW,
      installDate,
      location,
      certificateId,
    });


    await (prisma as any).booking.update({ where: { id }, data: { certificateUrl: publicUrl, certificateGeneratedAt: new Date() } });
    res.json({ ok: true, certificateUrl: await signIfS3Url(publicUrl) });
  } catch (err) {
    console.error('[certificate] force regenerate failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: update Total Payable for a lead (recomputes totalInvestment and gstAmount based on gstPct)
app.post('/api/admin/leads/:id/total-payable', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const { totalPayable } = req.body ?? {};
    const newGrand = Number(totalPayable);
    if (!Number.isFinite(newGrand) || newGrand <= 0) {
      return res.status(400).json({ error: 'Invalid totalPayable' });
    }

    // Load existing lead to pick gstPct
    const lead = await (prisma as any).booking.findUnique({ where: { id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const gstPct = Number.isFinite(Number(lead.gstPct)) ? Number(lead.gstPct) : 8.9;

    // grand = totalInvestment * (1 + gstPct/100)
    const base = newGrand / (1 + (gstPct / 100));
    const totalInvestment = Math.round(base);
    const gstAmount = Math.round(totalInvestment * (gstPct / 100));

    const updated = await (prisma as any).booking.update({
      where: { id },
      data: { totalInvestment, gstAmount, totalPayable: newGrand },
      select: { id: true, totalInvestment: true, gstPct: true, gstAmount: true, totalPayable: true, updatedAt: true },
    });

    res.json({
      success: true,
      lead: updated,
      totalPayable: updated.totalPayable ?? (totalInvestment + (updated.gstAmount ?? 0)),
    });
  } catch (err) {
    console.error('[admin] update total payable failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Customer: list AMC requests for own lead
app.get('/api/customer/leads/:id/amc-requests', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    // Ensure the lead belongs to this customer
    const lead = await (prisma as any).booking.findFirst({ where: { id, customerId: req.user.sub } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const items = await (prisma as any).amcRequest.findMany({
      where: { leadId: id, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, note: true, createdAt: true, updatedAt: true },
    });
    res.json(items);
  } catch (err) {
    console.error('[customer] list amc requests failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Staff: resolve an AMC request (only if its lead is assigned to this staff)
app.post('/api/staff/amc-requests/:id/resolve', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Forbidden: Staff access required' });
    }
    const staffId = String(req.user.sub);
    const { id } = req.params;

    // Ensure amcRequest exists and belongs to a lead assigned to this staff
    const amc = await (prisma as any).amcRequest.findUnique({
      where: { id },
      include: { lead: { select: { id: true } } }
    });
    if (!amc) return res.status(404).json({ error: 'AMC request not found' });
    if (amc.assignedStaffId !== staffId) {
      return res.status(403).json({ error: 'This AMC request is not assigned to you' });
    }

    const updated = await (prisma as any).amcRequest.update({
      where: { id },
      data: { status: 'resolved', updatedAt: new Date() },
      select: { id: true, status: true, updatedAt: true }
    });

    res.json({ success: true, amc: updated });
  } catch (error) {
    console.error('[staff-amc-resolve] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Staff: list AMC requests for my assigned leads
app.get('/api/staff/amc-requests', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Forbidden: Staff access required' });
    }
    const staffId = String(req.user.sub);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined; // optional: pending | resolved | in_progress | rejected

    const where: any = {
      assignedStaffId: staffId,
      ...(status ? { status } : {}),
    };

    const items = await (prisma as any).amcRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        leadId: true,
        status: true,
        note: true,
        createdAt: true,
        updatedAt: true,
        lead: {
          select: {
            id: true, bookingCode: true, fullName: true, phone: true,
            projectType: true, sizedKW: true,
            address: true, street: true, city: true, state: true, country: true, zip: true
          }
        },
      },
    });

    res.json(items);
  } catch (error) {
    console.error('[staff-amc-list] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Staff: list Complaints for my assigned leads
app.get('/api/staff/complaints', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Forbidden: Staff access required' });
    }
    const staffId = String(req.user.sub);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined; // optional: pending | in_progress | resolved

    const where: any = {
      ...(status ? { status } : {}),
      lead: { assignedStaffId: staffId },
    };

    const items = await (prisma as any).complaint.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        leadId: true,
        status: true,
        message: true,
        createdAt: true,
        updatedAt: true,
        lead: {
          select: {
            id: true, bookingCode: true, fullName: true, phone: true,
            projectType: true, sizedKW: true,
            address: true, street: true, city: true, state: true, country: true, zip: true,
          },
        },
      },
    });

    res.json(items);
  } catch (error) {
    console.error('[staff-complaints-list] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Staff: resolve a complaint (only if its lead is assigned to this staff)
app.post('/api/staff/complaints/:id/resolve', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Forbidden: Staff access required' });
    }
    const staffId = String(req.user.sub);
    const { id } = req.params;

    // Ensure complaint exists and belongs to a lead assigned to this staff
    const cmp = await (prisma as any).complaint.findUnique({
      where: { id },
      include: { lead: { select: { id: true, assignedStaffId: true } } },
    });
    if (!cmp) return res.status(404).json({ error: 'Complaint not found' });
    if (cmp.lead.assignedStaffId !== staffId) {
      return res.status(403).json({ error: 'Not assigned to you' });
    }

    const updated = await (prisma as any).complaint.update({
      where: { id },
      data: { status: 'resolved', updatedAt: new Date() },
      select: { id: true, status: true, updatedAt: true },
    });

    res.json({ success: true, complaint: updated });
  } catch (error) {
    console.error('[staff-complaint-resolve] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Alias: Customer AMC create via lead path
app.post('/api/customer/leads/:id/amc-requests', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const { note } = req.body ?? {};
    const lead = await (prisma as any).booking.findFirst({ where: { id, customerId: req.user.sub } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const created = await (prisma as any).amcRequest.create({
      data: {
        leadId: id,
        customerId: String(req.user.sub),
        status: 'pending',
        ...(note && String(note).trim() ? { note: String(note).trim() } : {}),
      },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error('[amc] alias create failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: list complaints for a lead
app.get('/api/admin/leads/:id/complaints', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const items = await (prisma as any).complaint.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      include: { customer: true },
    });
    res.json(items);
  } catch (err) {
    console.error('[admin] list complaints failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: list AMC requests for a lead
app.get('/api/admin/leads/:id/amc-requests', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const items = await (prisma as any).amcRequest.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      include: { customer: true },
    });
    res.json(items);
  } catch (err) {
    console.error('[admin] list amc requests failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Customer: file a complaint against own lead
app.post('/api/customer/leads/:id/complaints', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const { message } = req.body ?? {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    // Ensure the lead belongs to this customer
    const lead = await (prisma as any).booking.findFirst({ where: { id, customerId: req.user.sub } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const created = await (prisma as any).complaint.create({
      data: {
        leadId: id,
        customerId: String(req.user.sub),
        message: String(message).trim(),
      },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error('[complaints] create failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// --- Staff Auth Endpoints ---
app.post('/api/auth/staff/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    console.log('[staff-login] Attempting login for email:', email);

    const staff = await prisma.staff.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });

    if (!staff) {
      console.log('[staff-login] No staff found with email:', email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    console.log('[staff-login] Staff found:', staff.email, 'ID:', staff.id);
    console.log('[staff-login] Password hash from DB:', staff.passwordHash?.substring(0, 20) + '...');

    const isPasswordValid = await bcrypt.compare(password, staff.passwordHash);
    console.log('[staff-login] Password valid:', isPasswordValid);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ sub: staff.id, email: staff.email, type: 'staff' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: staff.id, email: staff.email, name: staff.name, type: 'staff' } });
  } catch (error) {
    console.error('[staff-login] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Admin: Register new staff member
app.post('/api/admin/staff/register', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    const { name, email, password, phone } = req.body;

    // Validate required fields
    if (!name || !email || !password || !phone) {
      return res.status(400).json({ error: 'Name, email, password, and phone are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate password strength
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    // Check if staff with email already exists
    const existingStaff = await prisma.staff.findUnique({ where: { email } });
    if (existingStaff) {
      return res.status(409).json({ error: 'Staff member with this email already exists' });
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create staff member
    const staff = await prisma.staff.create({
      data: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        passwordHash,
        phone: phone.trim(),
      },
    });

    // Return staff data (without password hash)
    res.status(201).json({
      id: staff.id,
      name: staff.name,
      email: staff.email,
      phone: staff.phone,
      createdAt: staff.createdAt,
    });
  } catch (error) {
    console.error('[admin-staff-register] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Customer: Request OTP (Legacy endpoint - should be replaced by Firebase on frontend)
app.post('/api/auth/request-otp', async (req: Request, res: Response) => {
  try {
    const { mobile } = req.body;
    if (!mobile || !mobile.trim()) {
      return res.status(400).json({ error: 'Mobile number is required' });
    }
    const normalizedMobile = mobile.trim().replace(/\D+/g, '');
    if (normalizedMobile.length < 10 || normalizedMobile.length > 15) {
      return res.status(400).json({ error: 'Invalid mobile number' });
    }

    // Generate OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(normalizedMobile, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

    // In development, return OTP in response for testing
    console.log(`[OTP-Legacy] Generated for ${normalizedMobile}: ${code}`);
    res.json({ message: 'Legacy OTP sent', otp: code });
  } catch (error) {
    console.error('[request-otp] Error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify-otp', async (req: Request, res: Response) => {
  try {
    const { mobile, otp, referralCode } = req.body ?? {};
    const normalizedMobile = mobile ? mobile.trim().replace(/\D+/g, '') : '';
    const referralCodeInput = normalizeReferralInput(referralCode);

    // OTP valid, create/find customer with referral logic
    let customerMobile = normalizedMobile;

    if (req.body.firebaseToken) {
      try {
        const decodedToken = await admin.auth().verifyIdToken(req.body.firebaseToken);
        if (decodedToken.phone_number) {
          customerMobile = decodedToken.phone_number.replace(/\D+/g, '');
        }
      } catch (err) {
        console.error('[verify-otp] Firebase token verification failed:', err);
        return res.status(401).json({ error: 'Invalid or expired Firebase token' });
      }
    } else {
      if (!mobile || !otp) {
        return res.status(400).json({ error: 'Mobile and OTP are required' });
      }
      // Legacy custom OTP verification
      const record = otpStore.get(normalizedMobile);
      if (!record) {
        return res.status(400).json({ error: 'OTP not requested' });
      }
      if (record.attempts >= OTP_MAX_ATTEMPTS) {
        otpStore.delete(normalizedMobile);
        return res.status(400).json({ error: 'Too many attempts' });
      }
      if (record.code !== otp.trim()) {
        record.attempts++;
        return res.status(400).json({ error: 'Invalid OTP' });
      }
      if (Date.now() > record.expiresAt) {
        otpStore.delete(normalizedMobile);
        return res.status(400).json({ error: 'OTP expired' });
      }
      otpStore.delete(normalizedMobile); // Clean up
    }

    // --- AGGRESSIVE CUSTOMER MIGRATION (Multi-Account Merge) ---
    let customer = null;
    let legacyCustomer = null;
    if (customerMobile.length > 10) {
      const tenDigit = customerMobile.slice(-10);
      legacyCustomer = await (prisma as any).customer.findUnique({ where: { mobile: tenDigit } });
    }

    // 2. Identify ALL accounts using the full number (including duplicates)
    // Using findMany in case unique constraint is somehow not enforced (as seen in diagnostic)
    const fullNumberAccounts = await (prisma as any).customer.findMany({ where: { mobile: customerMobile } });

    // 3. If a legacy account exists, we MUST prioritize it because it has the historical leads
    if (legacyCustomer) {
      console.log(`[verify-otp] Found legacy account ${legacyCustomer.id} for 10-digit mobile.`);

      // Move ANY other accounts out of the way to free up the full phone number
      for (const other of fullNumberAccounts) {
        if (other.id !== legacyCustomer.id) {
          console.log(`[verify-otp] Clearing duplicate account ${other.id} to favor legacy.`);
          try {
            // Rename instead of delete to be safe (no data loss accidental)
            await (prisma as any).customer.update({
              where: { id: other.id },
              data: { mobile: `MERGED_${Date.now()}_${other.mobile}` }
            });
          } catch (e) {
            console.error(`[verify-otp] Failed to rename duplicate ${other.id}:`, e);
          }
        }
      }

      // Now upgrade legacy to the full number
      customer = await (prisma as any).customer.update({
        where: { id: legacyCustomer.id },
        data: { mobile: customerMobile }
      });
      console.log(`[verify-otp] Successfully migrated legacy account ${customer.id} to ${customerMobile}`);
    }
    // 4. Default: If no legacy, just pick one of the full-number accounts or return first
    else if (fullNumberAccounts.length > 0) {
      customer = fullNumberAccounts[0];
    }

    if (!customer) {
      // New customer (SignUp logic)
      const ownCode = await generateUniqueReferralCode();
      let referredById: string | null = null;
      let level = 0;

      if (referralCodeInput) {
        const upline = await (prisma as any).customer.findUnique({ where: { referralCode: referralCodeInput } });
        if (upline) {
          referredById = upline.id;
          level = (upline.level ?? 0) + 1;
        }
      }

      customer = await (prisma as any).customer.create({
        data: {
          mobile: customerMobile,
          referralCode: ownCode,
          ...(referredById ? { referredBy: referredById, level } : {}),
        },
      });
    } else {
      // Existing customer – backfill referralCode if missing
      if (!customer.referralCode) {
        const ownCode = await generateUniqueReferralCode();
        customer = await (prisma as any).customer.update({
          where: { id: customer.id },
          data: { referralCode: ownCode },
        });
      }

      // Attach referral only once, if not already referred
      if (referralCodeInput && !customer.referredBy) {
        const upline = await (prisma as any).customer.findUnique({ where: { referralCode: referralCodeInput } });
        if (upline) {
          customer = await (prisma as any).customer.update({
            where: { id: customer.id },
            data: {
              referredBy: upline.id,
              level: (upline.level ?? 0) + 1,
            },
          });
        }
      }
    }

    // Generate JWT
    const token = jwt.sign({ sub: customer.id, type: 'customer' }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: customer.id,
        mobile: customer.mobile,
        referralCode: customer.referralCode,
        level: customer.level,
        type: 'customer',
      },
    });
  } catch (error) {
    console.error('[verify-otp] Error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// Admin: Get all staff members
app.get('/api/admin/staff', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    const staff = await prisma.staff.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(staff);
  } catch (error) {
    console.error('[admin-staff-list] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Admin: Assign staff to booking
app.post('/api/admin/leads/:id/assign', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    const { id } = req.params;
    const { staffId } = req.body;

    if (!staffId) {
      return res.status(400).json({ error: 'Staff ID is required' });
    }

    // Verify staff exists
    const staff = await prisma.staff.findUnique({ where: { id: staffId } });
    if (!staff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    // Update booking assignment
    const updatedBooking = await prisma.booking.update({
      where: { id },
      data: {
        assignedStaffId: staffId,
        assigned: true,
      },
      include: {
        assignedStaff: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Seed default steps if none exist yet for this lead
    const existingStepsCount = await (prisma as any).leadStep.count({ where: { leadId: id } });
    if (!existingStepsCount || existingStepsCount === 0) {
      const defaultSteps = [
        'Meeting',
        'Survey',
        'Structure Install',
        'Civil Work',
        'Wiring',
        'Panel Installation',
        'Net Metering',
        'Testing',
        'Full Plant Start',
        'Subsidy Process Request',
        'Subsidy Disbursement',
        'Certificate',
      ];
      await (prisma as any).leadStep.createMany({
        data: defaultSteps.map((name, idx) => ({
          leadId: id,
          name,
          order: idx + 1,
          completed: false,
        })),
        skipDuplicates: true,
      });
    }

    res.json({
      success: true,
      assignedStaff: updatedBooking.assignedStaff,
    });
  } catch (error) {
    console.error('[admin-assign-staff] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Admin: Unassign staff from booking
app.post('/api/admin/leads/:id/unassign', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    const { id } = req.params;

    // Update booking to remove assignment
    const updatedBooking = await prisma.booking.update({
      where: { id },
      data: {
        assignedStaffId: null,
        assigned: false,
      },
    });

    res.json({
      success: true,
      message: 'Staff assignment removed successfully',
    });
  } catch (error) {
    console.error('[admin-unassign-staff] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Staff: get my assigned bookings
app.get('/api/staff/my-leads', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Forbidden: Staff access required' });
    }
    const staffId = String(req.user.sub);
    const items = await (prisma as any).booking.findMany({
      where: { assignedStaffId: staffId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        projectType: true,
        fullName: true,
        city: true,
        state: true,
        country: true,
        createdAt: true,
        updatedAt: true,
        steps: {
          select: { id: true, name: true, completed: true, order: true, completedAt: true, completionNotes: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    res.json(items);
  } catch (error) {
    console.error('[staff-my-leads] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Staff: get specific assigned booking details
app.get('/api/staff/my-leads/:id', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Forbidden: Staff access required' });
    }
    const staffId = String(req.user.sub);
    const { id } = req.params;

    const lead = await (prisma as any).booking.findFirst({
      where: {
        id,
        assignedStaffId: staffId
      },
      include: {
        customer: true,
        steps: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            name: true,
            completed: true,
            order: true,
            completedAt: true,
            completionNotes: true,
            medias: {
              select: {
                id: true,
                type: true,
                url: true,
                createdAt: true
              }
            }
          },
        },
      },
    });

    if (!lead) {
      return res.status(404).json({ error: 'Booking not found or not assigned to you' });
    }

    // Sign S3 URLs for media (same as admin endpoint)
    const signedSteps = await Promise.all((lead.steps || []).map(async (s: any) => ({
      ...s,
      medias: await Promise.all((s.medias || []).map(async (m: any) => ({
        ...m,
        url: typeof m.url === 'string' ? await signIfS3Url(m.url) : m.url,
      })))
    })));

    res.json({
      ...lead,
      steps: signedSteps
    });
  } catch (error) {
    console.error('[staff-my-leads-detail] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Staff: mark step as complete with notes
app.post('/api/staff/steps/:stepId/complete', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Forbidden: Staff access required' });
    }
    const staffId = String(req.user.sub);
    const { stepId } = req.params;
    const { notes } = req.body;

    if (!notes || !notes.trim()) {
      return res.status(400).json({ error: 'Completion notes are required' });
    }

    // First verify the step belongs to a booking assigned to this staff
    const step = await (prisma as any).leadStep.findFirst({
      where: { id: stepId },
      include: {
        lead: {
          select: { id: true, assignedStaffId: true }
        }
      }
    });

    if (!step) {
      return res.status(404).json({ error: 'Step not found' });
    }

    if (step.lead.assignedStaffId !== staffId) {
      return res.status(403).json({ error: 'You are not assigned to this booking' });
    }

    if (step.completed) {
      return res.status(400).json({ error: 'Step is already completed' });
    }

    // Update the step
    const updatedStep = await (prisma as any).leadStep.update({
      where: { id: stepId },
      data: {
        completed: true,
        completedAt: new Date(),
        completionNotes: notes.trim(),
      },
    });

    // Update booking progress
    const allSteps = await (prisma as any).leadStep.findMany({
      where: { leadId: step.lead.id },
      select: { completed: true }
    });

    const completedSteps = allSteps.filter((s: any) => s.completed).length;
    const totalSteps = allSteps.length;
    const newPercent = Math.round((completedSteps / totalSteps) * 100);

    await (prisma as any).booking.update({
      where: { id: step.lead.id },
      data: { percent: newPercent }
    });

    res.json({
      success: true,
      step: updatedStep,
      progress: { completed: completedSteps, total: totalSteps, percent: newPercent }
    });
  } catch (error) {
    console.error('[staff-complete-step] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

// Staff: record daily timesheet seconds (upsert by staffId+date)
app.post('/api/staff/timesheet', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Forbidden: Staff access required' });
    }
    const staffId = String(req.user.sub);
    const { date, seconds } = req.body ?? {};
    const secs = Number(seconds);
    if (!date || !Number.isFinite(secs) || secs <= 0) {
      return res.status(400).json({ error: 'Invalid payload: date (YYYY-MM-DD) and positive seconds required' });
    }
    const d = new Date(`${String(date)}T00:00:00.000Z`);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    // Upsert with atomic increment on update
    const row = await (prisma as any).staffTimesheet.upsert({
      where: { staffId_date: { staffId, date: d } },
      update: { seconds: { increment: secs }, updatedAt: new Date() },
      create: { staffId, date: d, seconds: secs, source: 'timer' },
    });
    return res.json({ ok: true, seconds: row.seconds });
  } catch (error) {
    console.error('[staff-timesheet] Error:', error);
    return res.status(500).json({ error: 'An internal server error occurred' });
  }
});

const upload = multer({ storage });

// Serve static files from uploads
app.use('/uploads', express.static(uploadsDir));

// Staff: upload step media (up to 2 images and 1 video)
app.post('/api/staff/steps/:id/media', protect, upload.fields([
  { name: 'images', maxCount: 2 },
  { name: 'video', maxCount: 1 },
]) as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Forbidden: Staff access required' });
    }
    const stepId = String(req.params.id);
    // Ensure step exists and belongs to a lead assigned to this staff
    const step = await (prisma as any).leadStep.findUnique({
      where: { id: stepId },
      include: { lead: { select: { id: true, assignedStaffId: true } } },
    });
    if (!step) return res.status(404).json({ error: 'Step not found' });
    if (step.lead.assignedStaffId !== req.user.sub) {
      return res.status(403).json({ error: 'Not assigned to you' });
    }

    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const imgFiles: Express.Multer.File[] = (files?.images || []).slice(0, 2);
    const vidFiles: Express.Multer.File[] = (files?.video || []).slice(0, 1);

    const uploadedImages: string[] = [];
    let uploadedVideo: string | undefined;

    // Helper to upload a file buffer to S3 or local
    const uploadOne = async (file: Express.Multer.File, prefix: string): Promise<string> => {
      const ext = path.extname(file.originalname) || (prefix === 'video' ? '.mp4' : '.jpg');
      const key = `steps/${step.lead.id}/${stepId}/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      if (AWS_S3_BUCKET) {
        await s3.send(new PutObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype || undefined,
          CacheControl: 'public, max-age=31536000'
        }));
        return buildS3PublicUrl(key);
      }
      const localName = key.replace(/\//g, '_');
      const localPath = path.join(uploadsDir, localName);
      fs.writeFileSync(localPath, file.buffer);
      return `/uploads/${localName}`;
    };

    for (const f of imgFiles) {
      const url = await uploadOne(f, 'image');
      uploadedImages.push(url);
      try {
        await (prisma as any).stepMedia.create({ data: { stepId, type: 'image', url } });
      } catch (e) {
        console.warn('[stepMedia] failed to save image url', url, e);
      }
    }
    if (vidFiles[0]) {
      const url = await uploadOne(vidFiles[0], 'video');
      uploadedVideo = url;
      try {
        await (prisma as any).stepMedia.create({ data: { stepId, type: 'video', url } });
      } catch (e) {
        console.warn('[stepMedia] failed to save video url', url, e);
      }
    }

    return res.json({ images: uploadedImages, ...(uploadedVideo ? { video: uploadedVideo } : {}) });
  } catch (err) {
    console.error('[staff-step-media] upload failed', err);
    return res.status(500).json({ error: 'Failed to upload media' });
  }
});

// Admin: Add content to any step (notes + media)
// Admin: Add content to any step (notes + media) - Handles lazy creation of steps
app.post('/api/admin/leads/:leadId/steps/add-content', protect, upload.fields([
  { name: 'images', maxCount: 5 },
  { name: 'video', maxCount: 1 },
]) as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    const leadId = String(req.params.leadId);
    const stepName = req.body.stepName;
    const stepOrder = parseInt(req.body.stepOrder || '0', 10);
    const notes = req.body.notes || '';

    if (!stepName) {
      return res.status(400).json({ error: 'Step name is required' });
    }

    // Find or create the step
    let step = await (prisma as any).leadStep.findFirst({
      where: { leadId, name: stepName }
    });

    if (!step) {
      // Create the step if it doesn't exist
      step = await (prisma as any).leadStep.create({
        data: {
          leadId,
          name: stepName,
          order: stepOrder,
          completed: false // Admin can add content to incomplete steps
        }
      });
    }

    const stepId = step.id;

    // Upload media files
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const imgFiles: Express.Multer.File[] = (files?.images || []).slice(0, 5);
    const vidFiles: Express.Multer.File[] = (files?.video || []).slice(0, 1);

    const uploadedImages: string[] = [];
    let uploadedVideo: string | undefined;

    // Helper to upload a file buffer to S3 or local
    const uploadOne = async (file: Express.Multer.File, prefix: string): Promise<string> => {
      const ext = path.extname(file.originalname) || (prefix === 'video' ? '.mp4' : '.jpg');
      const key = `steps/${leadId}/${stepId}/admin-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      if (AWS_S3_BUCKET) {
        await s3.send(new PutObjectCommand({
          Bucket: AWS_S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype || undefined,
          CacheControl: 'public, max-age=31536000'
        }));
        return buildS3PublicUrl(key);
      }
      const localName = key.replace(/\//g, '_');
      const localPath = path.join(uploadsDir, localName);
      fs.writeFileSync(localPath, file.buffer);
      return `/uploads/${localName}`;
    };

    // Upload images
    for (const f of imgFiles) {
      const url = await uploadOne(f, 'image');
      uploadedImages.push(url);
      try {
        await (prisma as any).stepMedia.create({ data: { stepId, type: 'image', url } });
      } catch (e) {
        console.warn('[admin-stepMedia] failed to save image url', url, e);
      }
    }

    // Upload video
    if (vidFiles[0]) {
      const url = await uploadOne(vidFiles[0], 'video');
      uploadedVideo = url;
      try {
        await (prisma as any).stepMedia.create({ data: { stepId, type: 'video', url } });
      } catch (e) {
        console.warn('[admin-stepMedia] failed to save video url', url, e);
      }
    }

    // Update step notes (append to existing if any)
    if (notes.trim()) {
      const currentNotes = step.completionNotes || '';
      const updatedNotes = currentNotes ? `${currentNotes}\n\n[Admin] ${notes.trim()}` : `[Admin] ${notes.trim()}`;
      await (prisma as any).leadStep.update({
        where: { id: stepId },
        data: {
          completionNotes: updatedNotes,
          completed: true,
          completedAt: new Date()
        }
      });
    } else if (!step.completed) {
      // If no notes but files were uploaded, still mark as completed
      await (prisma as any).leadStep.update({
        where: { id: stepId },
        data: {
          completed: true,
          completedAt: new Date()
        }
      });
    }

    // Calculate and update lead completion percentage
    const allSteps = await (prisma as any).leadStep.findMany({
      where: { leadId },
      select: { completed: true }
    });
    const completedCount = allSteps.filter((s: any) => s.completed).length;
    // We have 12 fixed steps in the workflow. 
    // Since steps are created lazily, we must use 12 as the total, not allSteps.length.
    const totalCount = 12;
    const percentage = Math.min(Math.round((completedCount / totalCount) * 100), 100);

    await (prisma as any).booking.update({
      where: { id: leadId },
      data: { percent: percentage }
    });

    return res.json({
      success: true,
      stepId: step.id,
      images: uploadedImages,
      ...(uploadedVideo ? { video: uploadedVideo } : {})
    });
  } catch (err) {
    console.error('[admin-step-content] upload failed', err);
    return res.status(500).json({ error: 'Failed to add content' });
  }
});

// Simple in-memory OTP store (for development only)
// Twilio removed; always console-output OTP in dev

// Twilio removed; always console-output OTP in dev

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Customer: current profile
app.get('/api/customer/me', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const me = await (prisma as any).customer.findUnique({
      where: { id: String(req.user.sub) },
      select: { id: true, mobile: true, referralCode: true, level: true },
    });
    if (!me) return res.status(404).json({ error: 'Customer not found' });
    res.json(me);
  } catch (err) {
    console.error('[customer] me failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ===== MLM helpers =====
async function getMlSettings() {
  let settings = await (prisma as any).mlSettings.findFirst();
  if (!settings) {
    settings = await (prisma as any).mlSettings.create({ data: {} });
  }
  return settings as { maxPayoutPercent: number; level1Percent: number; level2Percent: number; level3Percent: number };
}

async function getUplineChain(customerId: string, maxLevels = 3) {
  const chain: Array<{ id: string; level: number }> = [];
  let currentId: string | null = customerId;
  let steps = 0;
  while (currentId && steps < maxLevels) {
    const me = await (prisma as any).customer.findUnique({ where: { id: currentId }, select: { referredBy: true } });
    if (!me?.referredBy) break;
    const uplineId = me.referredBy as string;
    chain.push({ id: uplineId, level: steps + 1 });
    currentId = uplineId;
    steps++;
  }
  return chain; // [{id, levelFromDownline}]
}

async function upsertWalletAdd(customerId: string, delta: number) {
  const existing = await (prisma as any).wallet.findUnique({ where: { customerId } });
  if (existing) {
    await (prisma as any).wallet.update({ where: { customerId }, data: { balance: (existing.balance ?? 0) + delta } });
  } else {
    await (prisma as any).wallet.create({ data: { customerId, balance: delta } });
  }
}

// Core distributor used by endpoints and booking hooks
async function distributeCommissionForPurchase(sourceId: string, gross: number) {
  const settings = await getMlSettings();
  const cap = (settings.maxPayoutPercent / 100) * gross;
  const percents = [settings.level1Percent, settings.level2Percent, settings.level3Percent];
  const chain = await getUplineChain(sourceId, 3);

  const intended = chain.map((u, idx) => ({ uplineId: u.id, levelFromDownline: u.level, pct: percents[idx] ?? 0 }));
  let amounts = intended.map(x => (x.pct / 100) * gross);
  const total = amounts.reduce((a, b) => a + b, 0);
  if (total > cap && total > 0) {
    const scale = cap / total;
    amounts = amounts.map(a => a * scale);
  }

  const created: any[] = [];
  const details: Array<{ uplineId: string; levelFromDownline: number; amount: number }> = [];
  for (let i = 0; i < intended.length; i++) {
    const amt = amounts[i] ?? 0;
    if (amt <= 0) continue;
    const row = await (prisma as any).commission.create({
      data: {
        customerId: intended[i].uplineId,
        fromCustomerId: sourceId,
        levelFromDownline: intended[i].levelFromDownline,
        amount: amt,
      },
    });
    await upsertWalletAdd(intended[i].uplineId, amt);
    created.push(row);
    details.push({ uplineId: intended[i].uplineId, levelFromDownline: intended[i].levelFromDownline, amount: amt });
  }

  return { created: created.length, totalAmount: amounts.reduce((a, b) => a + b, 0), details };
}

// Distribute commission upwards for a purchase made by source customer
app.post('/api/referrals/distribute', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const sourceId = String(req.user.sub);
    const { amount } = req.body ?? {};
    const gross = Number(amount);
    if (!gross || gross <= 0) return res.status(400).json({ error: 'amount required' });
    const result = await distributeCommissionForPurchase(sourceId, gross);
    res.json({ ok: true, distributed: result.created, totalAmount: result.totalAmount, details: result.details });
  } catch (err) {
    console.error('[referrals] distribute failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Overview: counts of downlines and earnings breakdown
app.get('/api/referrals/overview', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const meId = String(req.user.sub);
    const settings = await getMlSettings();

    const a1 = await (prisma as any).customer.findMany({ where: { referredBy: meId }, select: { id: true } });
    const a1Ids = a1.map((x: any) => x.id);
    const a2 = a1Ids.length ? await (prisma as any).customer.findMany({ where: { referredBy: { in: a1Ids } }, select: { id: true } }) : [];
    const a2Ids = a2.map((x: any) => x.id);
    const a3 = a2Ids.length ? await (prisma as any).customer.findMany({ where: { referredBy: { in: a2Ids } }, select: { id: true } }) : [];

    const commissions = await (prisma as any).commission.groupBy({
      by: ['levelFromDownline'],
      where: { customerId: meId },
      _sum: { amount: true },
    });
    const sumByLevel: Record<number, number> = {};
    for (const c of commissions) sumByLevel[c.levelFromDownline] = c._sum.amount ?? 0;

    res.json({
      counts: { a1: a1.length, a2: a2.length, a3: a3.length },
      earnings: {
        a1: sumByLevel[1] ?? 0,
        a2: sumByLevel[2] ?? 0,
        a3: sumByLevel[3] ?? 0,
      },
      settings: {
        maxPayoutPercent: settings.maxPayoutPercent,
        levelPercents: [settings.level1Percent, settings.level2Percent, settings.level3Percent],
      },
    });
  } catch (err) {
    console.error('[referrals] overview failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Recent commissions for me
app.get('/api/referrals/recent', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const meId = String(req.user.sub);
    const rows = await (prisma as any).commission.findMany({
      where: { customerId: meId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { amount: true, levelFromDownline: true, createdAt: true, fromCustomerId: true },
    });
    const enriched = await Promise.all(rows.map(async (r: any) => {
      const c = await (prisma as any).customer.findUnique({ where: { id: r.fromCustomerId }, select: { mobile: true } });
      const mobile = c?.mobile ? c.mobile.replace(/(\d{3})\d+(\d{2})/, '$1****$2') : 'unknown';
      return { amount: r.amount, level: r.levelFromDownline, mobile, createdAt: r.createdAt };
    }));
    res.json(enriched);
  } catch (err) {
    console.error('[referrals] recent failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: distribute commission for a specific booking (backfill or manual trigger)
app.post('/api/admin/referrals/distribute-for-booking', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { bookingId } = req.body ?? {};
    if (!bookingId || typeof bookingId !== 'string') {
      return res.status(400).json({ error: 'bookingId is required' });
    }
    const booking = await (prisma as any).booking.findUnique({ where: { id: bookingId } });
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.customerId) return res.status(400).json({ error: 'Booking has no customerId' });
    const gross = Number(booking.totalPayable ?? 0);
    if (!Number.isFinite(gross) || gross <= 0) return res.status(400).json({ error: 'Booking totalPayable is not set or invalid' });
    const result = await distributeCommissionForPurchase(String(booking.customerId), gross);
    res.json({ ok: true, distributed: result.created, totalAmount: result.totalAmount });
  } catch (err) {
    console.error('[admin] distribute-for-booking failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: debug upline chain for a customer
app.get('/api/admin/referrals/chain/:customerId', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { customerId } = req.params;
    const customer = await (prisma as any).customer.findUnique({ where: { id: customerId }, select: { id: true, mobile: true, referredBy: true } });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const chain = await getUplineChain(customerId, 3);
    res.json({ customer, chain });
  } catch (err) {
    console.error('[admin] chain debug failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: comprehensive referrals overview
app.get('/api/admin/referrals/overview', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    // Get total network (ALL customers in database)
    const totalNetwork = await (prisma as any).customer.count();

    // Get active users (customers with at least one downline)
    const customersWithDownlines = await (prisma as any).customer.findMany({
      select: {
        id: true,
        _count: { select: { downlines: true } }
      }
    });
    const activeUsers = customersWithDownlines.filter((c: any) => c._count.downlines > 0).length;

    // Get total earnings (sum of all commissions)
    const commissionsSum = await (prisma as any).commission.aggregate({
      _sum: { amount: true }
    });
    const totalEarnings = commissionsSum._sum.amount || 0;

    // Get distribution settings
    const settings = await (prisma as any).mlSettings.findFirst();
    const distributionSettings = settings ? {
      maxPayoutPercent: settings.maxPayoutPercent,
      level1Percent: settings.level1Percent,
      level2Percent: settings.level2Percent,
      level3Percent: settings.level3Percent
    } : {
      maxPayoutPercent: 4.0,
      level1Percent: 2.0,
      level2Percent: 1.0,
      level3Percent: 1.0
    };

    // Get network growth (last 12 months) - ALL customers
    const now = new Date();
    const monthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const customers = await (prisma as any).customer.findMany({
      where: {
        createdAt: { gte: monthsAgo }
      },
      select: { createdAt: true, level: true }
    });

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const networkGrowth = [];
    for (let i = 11; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthKey = `${monthDate.getFullYear()}-${monthDate.getMonth()}`;
      const monthCustomers = customers.filter((c: any) => {
        const cDate = new Date(c.createdAt);
        return cDate.getFullYear() === monthDate.getFullYear() && cDate.getMonth() === monthDate.getMonth();
      });
      networkGrowth.push({
        month: monthNames[monthDate.getMonth()],
        direct: monthCustomers.filter((c: any) => c.level === 1).length,
        indirect: monthCustomers.filter((c: any) => c.level > 1).length
      });
    }

    // Get ALL customers (top 50 by total downlines, including those with 0)
    const allCustomers = await (prisma as any).customer.findMany({
      select: {
        id: true,
        mobile: true,
        referralCode: true,
        level: true,
        referredBy: true,
        referredByCustomer: {
          select: { id: true, mobile: true }
        },
        downlines: {
          select: { id: true, level: true, referredBy: true }
        },
        commissionsReceived: {
          select: { amount: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 100 // Get top 100 to ensure we have enough data
    });

    const topReferrers = allCustomers
      .map((c: any) => {
        const totalReferrals = c.downlines.length;
        const earnings = c.commissionsReceived.reduce((sum: number, comm: any) => sum + comm.amount, 0);

        // A1 = DIRECT children only (those whose referredBy === this customer's ID)
        // A2 = children of A1 members
        // A3 = children of A2 members
        const a1Count = c.downlines.filter((d: any) => d.referredBy === c.id).length;

        // For A2 and A3, we need to check the level difference
        const customerLevel = c.level || 0;
        const a2Count = c.downlines.filter((d: any) => d.level === customerLevel + 2).length;
        const a3Count = c.downlines.filter((d: any) => d.level === customerLevel + 3).length;

        return {
          id: c.id,
          phoneNumber: c.mobile,
          referralCode: c.referralCode || 'N/A',
          upline: c.referredByCustomer ? {
            id: c.referredByCustomer.id,
            phoneNumber: c.referredByCustomer.mobile
          } : null,
          totalReferrals,
          earnings,
          downline: { a1: a1Count, a2: a2Count, a3: a3Count }
        };
      })
      .sort((a: any, b: any) => b.totalReferrals - a.totalReferrals)
      .slice(0, 50);

    res.json({
      totalNetwork,
      activeUsers,
      totalEarnings,
      distributionSettings,
      networkGrowth,
      topReferrers
    });
  } catch (err) {
    console.error('[admin] referrals overview failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: detailed user referral info
app.get('/api/admin/referrals/user/:customerId', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { customerId } = req.params;

    const customer = await (prisma as any).customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        mobile: true,
        referralCode: true,
        level: true,
        referredBy: true,
        referredByCustomer: {
          select: { id: true, mobile: true }
        },
        downlines: {
          select: {
            id: true,
            mobile: true,
            level: true,
            createdAt: true
          }
        },
        commissionsReceived: {
          select: { amount: true }
        }
      }
    });

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const totalReferrals = customer.downlines.length;
    const earnings = customer.commissionsReceived.reduce((sum: number, comm: any) => sum + comm.amount, 0);

    // Categorize downlines by level
    const a1 = customer.downlines
      .filter((d: any) => d.level === customer.level + 1)
      .map((d: any) => ({
        id: d.id,
        phoneNumber: d.mobile,
        joinedAt: new Date(d.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      }));

    const a2 = customer.downlines
      .filter((d: any) => d.level === customer.level + 2)
      .map((d: any) => ({
        id: d.id,
        phoneNumber: d.mobile,
        joinedAt: new Date(d.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      }));

    const a3 = customer.downlines
      .filter((d: any) => d.level === customer.level + 3)
      .map((d: any) => ({
        id: d.id,
        phoneNumber: d.mobile,
        joinedAt: new Date(d.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      }));

    res.json({
      id: customer.id,
      phoneNumber: customer.mobile,
      referralCode: customer.referralCode,
      upline: customer.referredByCustomer ? {
        id: customer.referredByCustomer.id,
        phoneNumber: customer.referredByCustomer.mobile
      } : null,
      totalReferrals,
      earnings,
      downline: { a1, a2, a3 }
    });
  } catch (err) {
    console.error('[admin] user referral detail failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: list customer phone numbers (minimal payload)
app.get('/api/admin/customers/phones', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    // Customer model has no 'name' field in schema; only return id+mobile
    const customers = await (prisma as any).customer.findMany({
      select: { id: true, mobile: true },
      orderBy: { createdAt: 'desc' },
    });
    // Add a derived 'name' for UI compatibility (use mobile as display)
    const shaped = customers.map((c: any) => ({ id: c.id, mobile: c.mobile, name: c.mobile }));
    res.json(shaped);
  } catch (err) {
    console.error('[admin] list customer phones failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Public sample certificate generator (for quick testing only)
app.post('/api/sample/certificate', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const installDate = now.toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
    const sample = {
      leadId: 'SAMPLE-LEAD',
      customerName: 'Sample Customer',
      projectType: 'Solar Rooftop',
      sizedKW: 5.2,
      installDate,
      location: 'Patna, Bihar, India',
      certificateId: `SAMPLE-${now.getTime().toString().slice(-6)}`,
    };
    const { publicUrl } = await generateCertificatePDF(sample as any);
    return res.json({ ok: true, certificateUrl: await signIfS3Url(publicUrl) });
  } catch (err) {
    console.error('[certificate] sample generation failed', err);
    return res.status(500).json({ error: 'Failed to generate sample' });
  }
});

// --- Lead Endpoints ---
// Create a lead from the Personal Info (5/5) page
app.post('/api/leads', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') {
      return res.status(403).json({ error: 'Forbidden: customers only' });
    }
    const body = req.body ?? {};
    const required = ['projectType', 'sizedKW', 'monthlyBill', 'pincode', 'estimateINR', 'fullName', 'phone', 'address', 'street', 'state', 'city', 'country', 'zip'];
    for (const key of required) {
      if (body[key] === undefined || body[key] === null || body[key] === '') {
        return res.status(400).json({ error: `Missing required field: ${key}` });
      }
    }
    // Map optional calculator fields
    const billingCycleMonths = typeof body.billingCycleMonths === 'number'
      ? body.billingCycleMonths
      : (body.billingCycle === '2m' ? 2 : 1);
    const budgetINR = body.budget !== undefined ? Number(body.budget) : (body.budgetINR !== undefined ? Number(body.budgetINR) : null);
    const provider = typeof body.provider === 'string' ? String(body.provider) : undefined;

    // Finance/gst defaults
    const gstPct = body.gstPct !== undefined && body.gstPct !== null && body.gstPct !== '' ? Number(body.gstPct) : 8.9;
    const totalInvBase = body.totalInvestment !== undefined ? Number(body.totalInvestment) : Number(body.estimateINR);
    const computedGstAmount = body.gstAmount !== undefined && body.gstAmount !== null && body.gstAmount !== ''
      ? Number(body.gstAmount)
      : Math.round((Number.isFinite(totalInvBase) ? totalInvBase : 0) * (gstPct / 100));

    const Booking = (prisma as any).booking ?? (prisma as any).lead;
    // Build bookingCode: keplYYMMNN (NN = monthly sequence)
    const now = new Date();
    const { start, end } = monthWindow(now);
    const monthCount = await Booking.count({ where: { createdAt: { gte: start, lt: end } } });
    const seq = pad2(monthCount + 1);
    const yy = pad2(now.getFullYear() % 100);
    const mm = pad2(now.getMonth() + 1);
    const bookingCode = `kepl${yy}${mm}${seq}`;

    // Compute total payable
    const totalPayable = Math.round((Number.isFinite(totalInvBase) ? totalInvBase : 0) + computedGstAmount);

    const created = await Booking.create({
      data: {
        bookingCode,
        customerId: req.user.sub,
        projectType: String(body.projectType),
        sizedKW: Number(body.sizedKW),
        monthlyBill: Number(body.monthlyBill),
        // Allow pincode override from calculator if provided
        pincode: String(body.pincode),

        withSubsidy: body.withSubsidy === undefined ? true : Boolean(body.withSubsidy),
        estimateINR: Number(body.estimateINR),
        totalInvestment: totalInvBase,
        gstPct,
        gstAmount: computedGstAmount,
        totalPayable,
        wp: body.wp !== undefined ? Number(body.wp) : null,
        plates: body.plates !== undefined ? Number(body.plates) : null,
        // Finance (receipt) inputs
        ratePerKW: body.ratePerKW !== undefined ? Number(body.ratePerKW) : null,
        networkChargePerUnit: body.networkChargePerUnit !== undefined ? Number(body.networkChargePerUnit) : null,
        annualGenPerKW: body.annualGenPerKW !== undefined ? Number(body.annualGenPerKW) : null,
        moduleDegradationPct: body.moduleDegradationPct !== undefined ? Number(body.moduleDegradationPct) : null,
        omPerKWYear: body.omPerKWYear !== undefined ? Number(body.omPerKWYear) : null,
        omEscalationPct: body.omEscalationPct !== undefined ? Number(body.omEscalationPct) : null,
        tariffINR: body.tariffINR !== undefined ? Number(body.tariffINR) : null,
        tariffEscalationPct: body.tariffEscalationPct !== undefined ? Number(body.tariffEscalationPct) : null,
        lifeYears: body.lifeYears !== undefined ? Number(body.lifeYears) : null,
        fullName: String(body.fullName),
        phone: String(body.phone),
        email: body.email ? String(body.email) : null,
        address: String(body.address),
        street: String(body.street),
        state: String(body.state),
        city: String(body.city),
        country: String(body.country),
        zip: String(body.zip),
        // New optional calculator-derived fields
        billingCycleMonths,
        budgetINR,
        ...(provider ? { provider } : {}),
      }
    });
    let commissionResult: any = null;
    try {
      if (req.user?.sub && typeof created.totalPayable === 'number' && created.totalPayable > 0) {
        commissionResult = await distributeCommissionForPurchase(String(req.user.sub), Number(created.totalPayable));
      }
    } catch (e) {
      console.warn('[leads] commission distribution skipped:', (e as any)?.message || e);
    }
    res.status(201).json({ ...created, commissionDistribution: commissionResult });
  } catch (err: any) {
    console.error('[leads] create failed', err?.message || err, err?.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Public create lead/booking (no auth) - used by mobile app 5/5 submission
app.post('/api/leads/public', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const required = ['projectType', 'sizedKW', 'monthlyBill', 'pincode', 'estimateINR', 'fullName', 'phone', 'address', 'street', 'state', 'city', 'country', 'zip'];
    for (const key of required) {
      if (body[key] === undefined || body[key] === null || body[key] === '') {
        return res.status(400).json({ error: `Missing required field: ${key}` });
      }
    }
    const billingCycleMonths = typeof body.billingCycleMonths === 'number'
      ? body.billingCycleMonths
      : (body.billingCycle === '2m' ? 2 : 1);
    const budgetINR = body.budget !== undefined ? Number(body.budget) : (body.budgetINR !== undefined ? Number(body.budgetINR) : null);
    const provider = typeof body.provider === 'string' ? body.provider : null;

    // Finance/gst defaults for public route
    const gstPctPublic = body.gstPct !== undefined && body.gstPct !== null && body.gstPct !== '' ? Number(body.gstPct) : 8.9;
    const totalInvBasePublic = body.totalInvestment !== undefined ? Number(body.totalInvestment) : Number(body.estimateINR);
    const computedGstAmountPublic = body.gstAmount !== undefined && body.gstAmount !== null && body.gstAmount !== ''
      ? Number(body.gstAmount)
      : Math.round((Number.isFinite(totalInvBasePublic) ? totalInvBasePublic : 0) * (gstPctPublic / 100));

    // If a valid customer token is present, associate this booking to that customer
    let customerId: string | null = null;
    try {
      const auth = String(req.headers['authorization'] || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token) {
        const decoded: any = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.type === 'customer' && typeof decoded.sub === 'string') {
          customerId = decoded.sub;
        }
      }
    } catch {
      // ignore auth errors in public route
    }

    // If no token-derived customer, try to infer from provided phone/mobile
    if (!customerId) {
      try {
        const rawPhone: string | undefined = typeof body.phone === 'string' ? body.phone : (typeof body.mobile === 'string' ? body.mobile : undefined);
        if (rawPhone) {
          const normalized = String(rawPhone).replace(/\D+/g, ''); // digits only
          if (normalized.length >= 8 && normalized.length <= 15) {
            const existing = await (prisma as any).customer.findUnique({ where: { mobile: normalized } });
            if (existing) {
              customerId = existing.id;
            } else {
              const createdCustomer = await (prisma as any).customer.create({ data: { mobile: normalized } });
              customerId = createdCustomer.id;
            }
          }
        }
      } catch (e) {
        // do not fail public route due to customer association issues
        console.warn('[leads-public] customer association by phone skipped:', (e as any)?.message || e);
      }
    }

    const Booking = (prisma as any).booking ?? (prisma as any).lead ?? (prisma as any).Lead;

    // Generate booking code for public route as well: keplYYMMNN (sequence within month)
    const nowPub = new Date();
    const { start: startPub, end: endPub } = monthWindow(nowPub);
    const monthCountPub = await Booking.count({ where: { createdAt: { gte: startPub, lt: endPub } } });
    const seqPub = pad2(monthCountPub + 1);
    const yyPub = pad2(nowPub.getFullYear() % 100);
    const mmPub = pad2(nowPub.getMonth() + 1);
    const bookingCodePub = `kepl${yyPub}${mmPub}${seqPub}`;

    const totalPayablePublic = Math.round((Number.isFinite(totalInvBasePublic) ? totalInvBasePublic : 0) + computedGstAmountPublic);

    const created = await Booking.create({
      data: {
        bookingCode: bookingCodePub,
        ...(customerId ? { customerId } : {}),
        projectType: String(body.projectType),
        sizedKW: Number(body.sizedKW),
        monthlyBill: Number(body.monthlyBill),
        pincode: String(body.pincode),
        withSubsidy: body.withSubsidy === undefined ? true : Boolean(body.withSubsidy),
        estimateINR: Number(body.estimateINR),
        totalInvestment: totalInvBasePublic,
        wp: body.wp !== undefined ? Number(body.wp) : null,
        plates: body.plates !== undefined ? Number(body.plates) : null,
        // Finance (receipt) inputs
        ratePerKW: body.ratePerKW !== undefined ? Number(body.ratePerKW) : null,
        networkChargePerUnit: body.networkChargePerUnit !== undefined ? Number(body.networkChargePerUnit) : null,
        annualGenPerKW: body.annualGenPerKW !== undefined ? Number(body.annualGenPerKW) : null,
        moduleDegradationPct: body.moduleDegradationPct !== undefined ? Number(body.moduleDegradationPct) : null,
        omPerKWYear: body.omPerKWYear !== undefined ? Number(body.omPerKWYear) : null,
        omEscalationPct: body.omEscalationPct !== undefined ? Number(body.omEscalationPct) : null,
        tariffINR: body.tariffINR !== undefined ? Number(body.tariffINR) : null,
        tariffEscalationPct: body.tariffEscalationPct !== undefined ? Number(body.tariffEscalationPct) : null,
        lifeYears: body.lifeYears !== undefined ? Number(body.lifeYears) : null,
        gstPct: gstPctPublic,
        gstAmount: computedGstAmountPublic,
        totalPayable: totalPayablePublic,
        fullName: String(body.fullName),
        phone: String(body.phone),
        email: body.email ? String(body.email) : null,
        address: String(body.address),
        street: String(body.street),
        state: String(body.state),
        city: String(body.city),
        country: String(body.country),
        zip: String(body.zip),
        billingCycleMonths,
        budgetINR,
        ...(provider ? { provider } : {}),
      }
    });
    // Distribute commission for public bookings as well, if linked to a customer
    let commissionResultPub: any = null;
    try {
      if (customerId && typeof created.totalPayable === 'number' && created.totalPayable > 0) {
        commissionResultPub = await distributeCommissionForPurchase(String(customerId), Number(created.totalPayable));
      }
    } catch (e) {
      console.warn('[leads-public] commission distribution skipped:', (e as any)?.message || e);
    }
    res.status(201).json({ ...created, commissionDistribution: commissionResultPub });
  } catch (err: any) {
    console.error('[leads-public] create failed', err?.message || err, err?.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Customer: list own leads
app.get('/api/customer/leads', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const items = await (prisma as any).booking.findMany({ where: { customerId: req.user.sub }, orderBy: { createdAt: 'desc' } });
    const withSigned = await Promise.all(items.map(async (l: any) => ({
      ...l,
      certificateUrl: typeof l.certificateUrl === 'string' ? await signIfS3Url(l.certificateUrl) : l.certificateUrl,
    })));
    res.json(withSigned);
  } catch (err) {
    console.error('[leads] customer list failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Customer: get a single lead (own), include certificate fields
app.get('/api/customer/leads/:id', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const lead = await (prisma as any).booking.findFirst({
      where: { id, customerId: req.user.sub },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const signed = { ...lead, certificateUrl: typeof lead.certificateUrl === 'string' ? await signIfS3Url(lead.certificateUrl) : lead.certificateUrl };
    res.json(signed);
  } catch (err) {
    console.error('[leads] customer get failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: list all leads
app.get('/api/admin/leads', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const items = await (prisma as any).booking.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        customer: true,
        steps: true,
        assignedStaff: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      }
    });
    const withSigned = await Promise.all(items.map(async (l: any) => ({
      ...l,
      certificateUrl: typeof l.certificateUrl === 'string' ? await signIfS3Url(l.certificateUrl) : l.certificateUrl,
    })));
    res.json(withSigned);
  } catch (err) {
    console.error('[leads] admin list failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: get all customers with their bookings and referral info
app.get('/api/admin/customers', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const customers = await (prisma as any).customer.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        leads: {
          select: {
            id: true,
            projectType: true,
            percent: true,
            createdAt: true,
          }
        },
        referredByCustomer: {
          select: {
            id: true,
            mobile: true,
          }
        },
        downlines: {
          select: {
            id: true,
            mobile: true,
          }
        },
        wallet: true,
      }
    });
    res.json(customers);
  } catch (err) {
    console.error('[customers] admin list failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: AMC/Service requests - list
app.get('/api/admin/amc-requests', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const items = await (prisma as any).amcRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        customer: true,
        lead: true,
        assignedStaff: {
          select: { id: true, name: true, email: true, phone: true }
        }
      },
    });
    res.json(items);
  } catch (err) {
    console.error('[amc] admin list failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: list all complaints across leads
app.get('/api/admin/complaints', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const items = await (prisma as any).complaint.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        customer: true,
        lead: {
          include: {
            assignedStaff: {
              select: { id: true, name: true, email: true, phone: true }
            },
          }
        }
      },
    });
    res.json(items);
  } catch (err) {
    console.error('[admin] complaints list failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: Resolve a complaint
app.post('/api/admin/complaints/:id/resolve', protect, async (req: AuthenticatedRequest, res: Response) => {
  console.log('[admin] resolve complaint request received for id:', req.params.id);
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;

    const updated = await (prisma as any).complaint.update({
      where: { id },
      data: { status: 'resolved' }
    });

    res.json({ success: true, complaint: updated });
  } catch (err) {
    console.error('[admin] resolve complaint failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: Get recent notifications (aggregated activity)
app.get('/api/admin/notifications', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    const [complaints, amcRequests, bookings] = await Promise.all([
      (prisma as any).complaint.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { customer: true, lead: true }
      }),
      (prisma as any).amcRequest.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { customer: true, lead: true }
      }),
      (prisma as any).booking.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { customer: true }
      })
    ]);

    const notifications = [
      ...complaints.map((c: any) => ({
        id: `complaint-${c.id}`,
        type: 'complaint',
        icon: '⚠️',
        title: 'New Complaint Filed',
        message: `${c.customer?.name || 'Customer'} filed a complaint for booking #${c.lead?.id?.slice(0, 8) || 'N/A'}`,
        time: c.createdAt,
        unread: c.status !== 'resolved',
        color: '#FEF2F2'
      })),
      ...amcRequests.map((a: any) => ({
        id: `amc-${a.id}`,
        type: 'amc',
        icon: '🔧',
        title: 'AMC Request',
        message: `New AMC request from ${a.customer?.name || 'Unknown'}`,
        time: a.createdAt,
        unread: a.status === 'pending',
        color: '#FFF7ED'
      })),
      ...bookings.map((b: any) => ({
        id: `booking-${b.id}`,
        type: 'booking',
        icon: '📋',
        title: 'New Booking',
        message: `New ${b.projectType || 'project'} booking created`,
        time: b.createdAt,
        unread: b.percent < 100,
        color: '#F0FDF4'
      }))
    ];

    // Sort by time and take the 10 most recent
    notifications.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    const recentNotifications = notifications.slice(0, 10);

    res.json(recentNotifications);
  } catch (err) {
    console.error('[admin] notifications failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: get a single lead by ID (include steps and customer)
app.get('/api/admin/leads/:id', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const lead = await (prisma as any).booking.findUnique({
      where: { id },
      include: {
        customer: true,
        steps: { orderBy: { order: 'asc' }, include: { medias: true } },
        assignedStaff: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        complaints: { orderBy: { createdAt: 'desc' }, include: { customer: true } },
        amcRequests: { orderBy: { createdAt: 'desc' }, include: { customer: true, assignedStaff: { select: { id: true, name: true, email: true } } } },
      }
    });
    if (!lead) return res.status(404).json({ error: 'Not found' });

    // Self-healing: Recalculate percentage to ensure accuracy (fixes old 100% bug)
    if (lead.steps) {
      const completedCount = lead.steps.filter((s: any) => s.completed).length;
      const totalCount = 12; // Fixed workflow size
      const correctPercent = Math.min(Math.round((completedCount / totalCount) * 100), 100);

      if (lead.percent !== correctPercent) {
        await (prisma as any).booking.update({
          where: { id },
          data: { percent: correctPercent }
        });
        lead.percent = correctPercent;
      }
    }

    // Calculate dueDays in real-time based on actual elapsed time
    const stepsWithDueDays = calculateDueDays(lead.steps || [], lead.createdAt);

    const signedSteps = await Promise.all(stepsWithDueDays.map(async (s: any) => ({
      ...s,
      medias: await Promise.all((s.medias || []).map(async (m: any) => ({
        ...m,
        url: typeof m.url === 'string' ? await signIfS3Url(m.url) : m.url,
      })))
    })));
    const signed = {
      ...lead,
      steps: signedSteps,
      certificateUrl: typeof lead.certificateUrl === 'string' ? await signIfS3Url(lead.certificateUrl) : lead.certificateUrl
    };
    res.json(signed);
  } catch (err) {
    console.error('[leads] admin get failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const DEFAULT_STEP_NAMES: string[] = [
  'meeting',
  'survey',
  'staucher install',
  'civil work',
  'wiring',
  'panel installation',
  'net metering',
  'testing',
  'fully plant start',
  'subsidy process request',
  'subsidy disbursement',
  'certificate',
];

// Admin: list/init steps for a lead
app.get('/api/admin/leads/:id/steps', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const lead = await (prisma as any).lead.findUnique({ where: { id } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const existing: any[] = await (prisma as any).leadStep.findMany({ where: { leadId: id }, orderBy: { order: 'asc' } });
    if (existing.length === 0) {
      await (prisma as any).$transaction(
        DEFAULT_STEP_NAMES.map((name, idx) => (prisma as any).leadStep.create({ data: { leadId: id, name, order: idx + 1 } }))
      );
    }
    const steps = await (prisma as any).leadStep.findMany({ where: { leadId: id }, orderBy: { order: 'asc' } });
    res.json(steps);
  } catch (err) {
    console.error('[leads] admin steps list/init failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: mark a lead step complete/undo
app.patch('/api/admin/leads/:id/steps/:stepId', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { id, stepId } = req.params;
    const { completed } = req.body ?? {};
    const step = await (prisma as any).leadStep.findFirst({ where: { id: stepId, leadId: id } });
    if (!step) return res.status(404).json({ error: 'Step not found' });

    // Update the step
    const updated = await (prisma as any).leadStep.update({
      where: { id: stepId },
      data: {
        completed: Boolean(completed),
        completedAt: completed ? new Date() : null,
        dueDays: completed ? 0 : step.dueDays // Reset dueDays to 0 when completed
      },
    });

    // If marking as completed, activate the next step
    if (Boolean(completed)) {
      const allSteps = await (prisma as any).leadStep.findMany({
        where: { leadId: id },
        orderBy: { order: 'asc' }
      });

      // Find the next incomplete step
      const nextStep = allSteps.find((s: any) => !s.completed && s.id !== stepId);
      if (nextStep) {
        // Activate next step by setting dueDays to 1
        await (prisma as any).leadStep.update({
          where: { id: nextStep.id },
          data: { dueDays: 1 }
        });
      }
    }

    // If marking as completed, check if all non-'certificate' steps are done and generate certificate if missing
    if (Boolean(completed)) {
      const lead = await (prisma as any).lead.findUnique({ where: { id }, include: { steps: true } });
      if (lead) {
        const steps = await (prisma as any).leadStep.findMany({ where: { leadId: id }, orderBy: { order: 'asc' } });
        const nonCertSteps = steps.filter((s: any) => s.name !== 'certificate');
        const allNonCertComplete = nonCertSteps.length > 0 && nonCertSteps.every((s: any) => s.completed);
        if (allNonCertComplete && !lead.certificateUrl) {
          // Determine installation date as the latest completedAt among non-certificate steps or now
          const latestCompletedAt = nonCertSteps
            .map((s: any) => (s.completedAt ? new Date(s.completedAt) : null))
            .filter((d: Date | null) => !!d)
            .sort((a: Date | null, b: Date | null) => (a!.getTime() - b!.getTime()))
            .pop() as Date | undefined;
          const installDate = (latestCompletedAt || new Date()).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
          const location = [lead.city, lead.state, lead.country].filter(Boolean).join(', ');
          const certificateId = `${id.slice(0, 6).toUpperCase()}-${Date.now().toString().slice(-6)}`;
          try {
            const { publicUrl } = await generateCertificatePDF({
              leadId: id,
              customerName: lead.fullName,
              projectType: lead.projectType,
              sizedKW: lead.sizedKW,
              installDate,
              location,
              certificateId,
            });
            await (prisma as any).booking.update({
              where: { id },
              data: { certificateUrl: publicUrl, certificateGeneratedAt: new Date() },
            });
            // Mark the 'certificate' step as completed automatically
            const certStep = steps.find((s: any) => s.name === 'certificate');
            if (certStep && !certStep.completed) {
              await (prisma as any).leadStep.update({
                where: { id: certStep.id },
                data: { completed: true, completedAt: new Date() },
              });
            }
          } catch (err) {
            console.error('[certificate] generation failed', err);
            // Do not fail the step update due to certificate issues
          }
        }
      }
    }

    res.json(updated);
  } catch (err) {
    console.error('[leads] admin step update failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- Customer-facing endpoints (steps + AMC) ---
// Customer: fetch steps for a lead they own (init defaults if missing)
app.get('/api/customer/leads/:id/steps', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    // Some environments use `booking` instead of `lead`
    let ownerLead: any = await (prisma as any).booking.findFirst({ where: { id, customerId: req.user.sub } });
    if (!ownerLead && (prisma as any).lead && typeof (prisma as any).lead.findFirst === 'function') {
      ownerLead = await (prisma as any).lead.findFirst({ where: { id, customerId: req.user.sub } });
    }
    if (!ownerLead) return res.status(404).json({ error: 'Lead not found' });
    const existing: any[] = await (prisma as any).leadStep.findMany({ where: { leadId: id }, orderBy: { order: 'asc' } });
    if (existing.length === 0) {
      await (prisma as any).$transaction(
        DEFAULT_STEP_NAMES.map((name, idx) => (prisma as any).leadStep.create({ data: { leadId: id, name, order: idx + 1 } }))
      );
    }
    const steps = await (prisma as any).leadStep.findMany({ where: { leadId: id }, orderBy: { order: 'asc' } });
    res.json(steps);
  } catch (err) {
    console.error('[leads] customer steps failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Customer: submit AMC request (create if not exists or not resolved)
app.post('/api/customer/amc-requests', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const { leadId, note } = req.body ?? {};
    if (!leadId) return res.status(400).json({ error: 'leadId is required' });
    const lead = await (prisma as any).booking.findFirst({ where: { id: String(leadId), customerId: req.user.sub } });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    let existing = await (prisma as any).amcRequest.findFirst({
      where: { leadId: String(leadId), customerId: req.user.sub, NOT: { status: 'resolved' } },
    });
    if (existing) {
      // Update note if provided, keep status
      if (note && typeof note === 'string') {
        existing = await (prisma as any).amcRequest.update({ where: { id: existing.id }, data: { note } });
      }
      return res.status(200).json(existing);
    }
    const created = await (prisma as any).amcRequest.create({
      data: {
        leadId: String(leadId),
        customerId: req.user.sub,
        status: 'pending',
        note: note && typeof note === 'string' ? note : null,
      },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error('[amc] customer request failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Customer: get AMC request for a specific lead
app.get('/api/customer/amc-requests', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const leadId = String((req.query as any).leadId || '');
    if (!leadId) return res.status(400).json({ error: 'leadId query is required' });
    const lead = await (prisma as any).booking.findFirst({ where: { id: leadId, customerId: req.user.sub } });
    if (!lead) return res.json(null);
    const reqItem = await (prisma as any).amcRequest.findFirst({
      where: { leadId, customerId: req.user.sub },
      orderBy: { createdAt: 'desc' },
    });
    res.json(reqItem || null);
  } catch (err) {
    console.error('[amc] customer get failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Customer: get AMC requests history for a specific lead
app.get('/api/customer/amc-requests/history', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Forbidden' });
    const leadId = String((req.query as any).leadId || '');
    if (!leadId) return res.status(400).json({ error: 'leadId query is required' });
    const lead = await (prisma as any).lead.findFirst({ where: { id: leadId, customerId: req.user.sub } });
    if (!lead) return res.json([]);
    const items = await (prisma as any).amcRequest.findMany({
      where: { leadId, customerId: req.user.sub },
      orderBy: { createdAt: 'desc' },
    });
    res.json(items);
  } catch (err) {
    console.error('[amc] customer history failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: mark AMC request done/resolved
app.patch('/api/admin/amc-requests/:id', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { id } = req.params;
    const { status, assignedStaffId } = req.body ?? {};

    const updateData: any = {};

    if (status !== undefined) {
      if (!['pending', 'in_progress', 'resolved', 'rejected'].includes(String(status))) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updateData.status = String(status);
      if (status === 'resolved') {
        updateData.resolvedAt = new Date();
      }
    }

    if (assignedStaffId !== undefined) {
      updateData.assignedStaffId = assignedStaffId || null;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updated = await (prisma as any).amcRequest.update({
      where: { id },
      data: updateData,
      include: {
        assignedStaff: {
          select: { id: true, name: true, email: true, phone: true }
        }
      }
    });
    res.json(updated);
  } catch (err) {
    console.error('[amc] admin update failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Customer: fetch steps for a given inquiry they own
// Removed inquiry steps endpoints (legacy)

// Protected route to get all inquiries for admins
// Removed legacy inquiries list (admin)

// Admin: fetch steps for a given inquiry (initializes defaults if missing)
// Removed legacy inquiry steps (admin)

// Admin: mark a specific step as complete
// Removed legacy inquiry step complete

// --- Partner Auth Endpoints ---

app.post('/api/auth/partner/request-otp', async (req: Request, res: Response) => {
  const { mobile } = req.body;
  if (!mobile || !/^\d{10}$/.test(mobile)) {
    return res.status(400).json({ error: 'A valid 10-digit mobile number is required' });
  }

  const normalizedMobile = `+91${mobile}`;
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(normalizedMobile, { code: otp, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
  console.log(`[request-otp-partner][DEV] OTP for ${normalizedMobile} is ${otp}`);
  return res.json({ message: 'OTP sent (DEV)', otp, ttlMs: OTP_TTL_MS });
});

app.post('/api/auth/partner/verify-otp', async (req: Request, res: Response) => {
  const { mobile, otp } = req.body;
  if (!mobile || !otp) {
    return res.status(400).json({ error: 'Mobile and OTP are required' });
  }

  const normalizedMobile = `+91${mobile}`;
  const otpData = otpStore.get(normalizedMobile);

  if (!otpData || otpData.expiresAt < Date.now() || otpData.attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(401).json({ error: 'OTP is invalid or has expired' });
  }

  if (otpData.code !== otp) {
    otpData.attempts++;
    return res.status(401).json({ error: 'Incorrect OTP' });
  }

  let partner = await prisma.partner.findUnique({ where: { mobile: normalizedMobile } });
  if (!partner) {
    partner = await prisma.partner.create({ data: { mobile: normalizedMobile, name: 'New Partner' } });
  }

  const token = jwt.sign({ sub: partner.id, mobile: partner.mobile, type: 'partner' }, JWT_SECRET, { expiresIn: '7d' });
  otpStore.delete(normalizedMobile);

  res.json({ token, user: partner });
});


// --- Admin Auth Endpoint ---

app.post('/api/auth/admin/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const admin = await prisma.admin.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });

    if (!admin) {
      // Use a generic error message to prevent email enumeration attacks
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, admin.passwordHash);

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await (prisma as any).admin.update({
      where: { id: admin.id },
      data: { otp, otpExpires }
    });

    try {
      await sendEmailOTP(admin.email, otp);
      // Return a message indicating OTP is required
      res.json({ otpRequired: true, message: 'OTP sent to your email' });
    } catch (emailErr) {
      console.error('[admin-login] Email failed:', emailErr);
      // For development/debugging if SES isn't verified yet
      if (process.env.NODE_ENV === 'development') {
        return res.json({ otpRequired: true, message: `(DEV ONLY) OTP: ${otp}` });
      }
      res.status(500).json({ error: 'Failed to send verification email' });
    }

  } catch (error) {
    console.error('[admin-login] Error:', error);
    res.status(500).json({ error: 'An internal server error occurred' });
  }
});

app.post('/api/auth/admin/verify-otp', async (req: Request, res: Response) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  try {
    const admin = await (prisma as any).admin.findUnique({
      where: { email }
    });

    if (!admin || !admin.otp || !admin.otpExpires) {
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    }

    if (admin.otp !== otp) {
      return res.status(401).json({ error: 'Invalid OTP' });
    }

    if (new Date() > admin.otpExpires) {
      return res.status(401).json({ error: 'OTP has expired' });
    }

    // Clear OTP and issue token
    await (prisma as any).admin.update({
      where: { id: admin.id },
      data: { otp: null, otpExpires: null }
    });

    const token = jwt.sign({ sub: admin.id, email: admin.email, type: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, user: { id: admin.id, email: admin.email, name: admin.name, type: 'admin' } });

  } catch (error) {
    console.error('[admin-verify-otp] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});



// End of Mobile Auth Routes

// Removed legacy inquiry create

// List recent inquiries (for verification/testing)
// Removed legacy inquiries list (public)

// --- Posts Endpoints ---

// Public: list posts for feed
app.get('/api/posts', async (_req: Request, res: Response) => {
  try {
    const items = await (prisma as any).post.findMany({ orderBy: { createdAt: 'desc' } });
    const withSigned = await Promise.all(items.map(async (p: any) => ({
      ...p,
      imageUrl: typeof p.imageUrl === 'string' ? await signIfS3Url(p.imageUrl) : p.imageUrl,
    })));
    res.json(withSigned);
  } catch (err) {
    console.error('[posts] list failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: list posts (protected)
app.get('/api/admin/posts', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const items = await (prisma as any).post.findMany({ orderBy: { createdAt: 'desc' } });
    const withSigned = await Promise.all(items.map(async (p: any) => ({
      ...p,
      imageUrl: typeof p.imageUrl === 'string' ? await signIfS3Url(p.imageUrl) : p.imageUrl,
    })));
    res.json(withSigned);
  } catch (err) {
    console.error('[posts] admin list failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: create a post
app.post('/api/admin/posts', protect, upload.single('image'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: admins only' });
    }
    const { caption } = req.body ?? {};
    if (!caption || typeof caption !== 'string') {
      return res.status(400).json({ error: 'caption is required' });
    }
    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({ error: 'image file is required' });
    }
    let imageUrl: string | null = null;
    if (AWS_S3_BUCKET) {
      // Upload to S3
      const ext = path.extname(file.originalname) || '.jpg';
      const key = `posts/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      await s3.send(new PutObjectCommand({
        Bucket: AWS_S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype || 'application/octet-stream',
      }));
      imageUrl = buildS3PublicUrl(key);
    } else {
      // Fallback to local disk if bucket not configured
      const localName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || '.jpg'}`;
      const localPath = path.join(uploadsDir, localName);
      fs.writeFileSync(localPath, file.buffer);
      imageUrl = `/uploads/${localName}`;
    }

    const post = await (prisma as any).post.create({
      data: {
        caption: caption.trim(),
        imageUrl,
        authorId: req.user.sub,
      },
    });
    const signed = { ...post, imageUrl: imageUrl ? await signIfS3Url(imageUrl) : imageUrl };
    res.status(201).json(signed);
  } catch (err) {
    console.error('[posts] create failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: delete a post (and its image file if present)
app.delete('/api/admin/posts/:id', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: admins only' });
    }
    const { id } = req.params;
    const existing = await (prisma as any).post.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Post not found', id });

    // Attempt to delete the file from S3 if it points to our bucket; otherwise try local
    const img: string = existing.imageUrl || '';
    let deleted = false;
    if (typeof img === 'string') {
      const key = getS3KeyFromUrl(img);
      if (key && AWS_S3_BUCKET) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
          deleted = true;
        } catch (e) {
          console.warn('[posts] failed to remove S3 object', e);
        }
      }
      if (!deleted && img.startsWith('/uploads/')) {
        const filePath = path.join(process.cwd(), img.replace(/^\//, ''));
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) {
          console.warn('[posts] failed to remove local image file', e);
        }
      }
    }

    await (prisma as any).post.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[posts] delete failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Like a post (simple increment, no auth for now)
app.post('/api/posts/:id/like', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updated = await (prisma as any).post.update({
      where: { id },
      data: { likes: { increment: 1 } },
    });
    res.json(updated);
  } catch (err) {
    console.error('[posts] like failed', err);
    res.status(400).json({ error: 'Failed to like post' });
  }
});


// Admin: List all customers for broadcast (or general management)
app.get('/api/admin/customers', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const customers = await (prisma as any).customer.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        mobile: true,
        city: true,
        state: true,
        createdAt: true,
      },
      // Note: city/state are not directly on Customer model in schema currently shown, 
      // but logic in Pulse.tsx expects them. If they don't exist, we return nulls or update schema.
      // Assuming for now they might be derived or we just return what we have.
      // Based on schema viewed: Customer has no city/state. Lead has city/state. 
      // We'll optionally fetch latest lead for city/state info.
      include: {
        leads: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { city: true, state: true, fullName: true }
        }
      }
    });

    const formatted = customers.map((c: any) => ({
      id: c.id,
      mobile: c.mobile,
      name: c.leads?.[0]?.fullName || null,
      city: c.leads?.[0]?.city || null,
      state: c.leads?.[0]?.state || null,
      createdAt: c.createdAt
    }));

    res.json(formatted);
  } catch (err) {
    console.error('[admin-customers] list failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: Send Broadcast (Pulse)
app.post('/api/admin/broadcast/send', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    // Explicitly cast prisma to any to avoid potential type issues with new models until strictly typed
    const prismaAny = prisma as any;

    const { recipients, message, scheduledAt } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Recipients list is required' });
    }
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message content is required' });
    }

    console.log(`[Broadcast] Creating broadcast for ${recipients.length} recipients`);

    // 1. Create Broadcast Record
    const broadcast = await prismaAny.broadcast.create({
      data: {
        message,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        status: 'processing',
        adminId: req.user.sub,
        recipients: {
          create: recipients.map((customerId: string) => ({
            customerId,
            status: 'pending'
          }))
        }
      },
      include: { recipients: true }
    });

    // 2. "Send" Messages (Simulation / Integration Point)
    // In a real scenario, this would loop through recipients and call Twilio/Meta API
    // For now, we simulate success for all

    // Async background processing to not block response
    (async () => {
      console.log(`[Broadcast] Starting background send for Broadcast ID: ${broadcast.id}`);

      for (const r of broadcast.recipients) {
        try {
          // WhatsApp sending removed per user request
          // We just mark as sent to keep the flow consistent for now
          console.log(`[WhatsApp-Removed] Simulated send to ${r.customerId}`);

          // Update status to sent
          await prismaAny.broadcastRecipient.update({
            where: { id: r.id },
            data: { status: 'sent', sentAt: new Date() }
          });
        } catch (e) {
          console.error(`[Broadcast] Failed to process recipient ${r.id}`, e);
          await prismaAny.broadcastRecipient.update({
            where: { id: r.id },
            data: { status: 'failed', error: String(e) }
          });
        }
      }

      // Update Broadcast status
      await prismaAny.broadcast.update({
        where: { id: broadcast.id },
        data: { status: 'sent' }
      });
      console.log(`[Broadcast] Finished sending Broadcast ID: ${broadcast.id}`);
    })();

    res.json({ success: true, broadcastId: broadcast.id, message: 'Broadcast processing started' });

  } catch (err) {
    console.error('[broadcast-send] failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: Dashboard Stats
app.get('/api/admin/dashboard/stats', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    const [
      totalBookings,
      completedBookings,
      totalStepsCompleted,
      unresolvedComplaints,
      pendingAMC,
      activeBookingsWithSteps
    ] = await Promise.all([
      (prisma as any).booking.count(),
      (prisma as any).booking.count({ where: { percent: 100 } }),
      (prisma as any).leadStep.count({ where: { completed: true } }),
      (prisma as any).complaint.count({ where: { status: { not: 'resolved' } } }),
      (prisma as any).amcRequest.count({ where: { status: 'pending' } }),
      (prisma as any).booking.findMany({
        where: { percent: { lt: 100 } },
        select: {
          createdAt: true,
          steps: {
            select: { completed: true, completedAt: true, order: true },
            orderBy: { order: 'asc' }
          }
        }
      })
    ]);

    // Calculate overdue steps
    let overdueSteps = 0;
    const SLA_DAYS = 2;
    const now = new Date();

    for (const booking of activeBookingsWithSteps) {
      // We need to simulate the steps logic
      // Default steps count is 12 if not present, but we only care about actual steps or implied steps
      // For simplicity, we'll iterate through the steps we have or up to 12

      // If no steps in DB, we assume standard 12 steps. 
      // But if steps are missing in DB, we can't check their completion status easily without assuming they are incomplete.
      // However, the frontend logic iterates through the merged steps.
      // Here, let's stick to the steps that exist or should exist.
      // Actually, if steps are empty, Step 1 is pending.

      const steps = booking.steps || [];
      // We need to check up to 12 steps (standard)
      for (let i = 0; i < 12; i++) {
        const step = steps.find((s: any) => s.order === i);
        const isCompleted = step?.completed || false;

        if (isCompleted) continue; // Completed steps are not overdue

        // Calculate start date
        let startDate: Date | null = null;
        if (i === 0) {
          startDate = new Date(booking.createdAt);
        } else {
          const prevStep = steps.find((s: any) => s.order === i - 1);
          if (prevStep?.completed && prevStep.completedAt) {
            startDate = new Date(prevStep.completedAt);
          }
        }

        if (startDate) {
          const deadline = new Date(startDate);
          deadline.setDate(deadline.getDate() + SLA_DAYS);
          if (now > deadline) {
            overdueSteps++;
          }
        }
      }
    }

    res.json({
      completedBookings,
      totalBookings,
      totalStepsCompleted,
      unresolvedComplaints,
      pendingAMC,
      overdueSteps
    });
  } catch (err) {
    console.error('[dashboard] stats failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: Get project stages analytics (Updated)
// Admin: Get project stages analytics (Combined: Activity & Subsidy)
app.get('/api/admin/dashboard/project-stages', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    const timeFrame = req.query.timeFrame as string || 'all';
    console.log('[project-stages] Received timeFrame:', timeFrame);
    const today = new Date();
    let startOfPeriod = new Date();
    let months: string[] = []; // This will hold our X-axis labels (Months or Ranges)

    // Determine date range and labels based on timeFrame
    if (timeFrame === 'month') {
      // This Month: 5-day intervals
      startOfPeriod = new Date(today.getFullYear(), today.getMonth(), 1);
      months = ['1-5', '6-10', '11-15', '16-20', '21-25', '26-End'];
    } else if (timeFrame === '3months') {
      // Last 3 Months
      startOfPeriod = new Date(today.getFullYear(), today.getMonth() - 2, 1);
      for (let i = 2; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        months.push(d.toLocaleString('default', { month: 'short' }));
      }
    } else if (timeFrame === '6months') {
      // Last 6 Months
      startOfPeriod = new Date(today.getFullYear(), today.getMonth() - 5, 1);
      for (let i = 5; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        months.push(d.toLocaleString('default', { month: 'short' }));
      }
    } else if (timeFrame === '12months') {
      // Last 12 Months
      startOfPeriod = new Date(today.getFullYear(), today.getMonth() - 11, 1);
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        months.push(d.toLocaleString('default', { month: 'short' }));
      }
    } else {
      // Default 'all' -> Last 12 months
      startOfPeriod = new Date(today.getFullYear(), today.getMonth() - 11, 1);
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        months.push(d.toLocaleString('default', { month: 'short' }));
      }
    }

    // 1. Fetch all relevant data in bulk for the period
    const allBookings = await (prisma as any).booking.findMany({
      where: { createdAt: { gte: startOfPeriod } },
      select: { createdAt: true, withSubsidy: true }
    });

    const allCompletedSteps = await (prisma as any).leadStep.findMany({
      where: { completed: true, completedAt: { gte: startOfPeriod } },
      select: { completedAt: true }
    });

    // 2. Aggregate data
    const monthlyData = months.map(label => {
      let monthBookings: any[] = [];
      let monthSteps: any[] = [];

      if (timeFrame === 'month') {
        // Aggregation for 5-day intervals
        const [startStr, endStr] = label.split('-');
        const startDay = parseInt(startStr);
        const endDay = endStr === 'End' ? 31 : parseInt(endStr);

        monthBookings = allBookings.filter((b: any) => {
          const d = new Date(b.createdAt);
          const day = d.getDate();
          return day >= startDay && day <= endDay;
        });

        monthSteps = allCompletedSteps.filter((s: any) => {
          if (!s.completedAt) return false;
          const d = new Date(s.completedAt);
          const day = d.getDate();
          return day >= startDay && day <= endDay;
        });
      } else {
        // Standard Monthly Aggregation
        monthBookings = allBookings.filter((b: any) =>
          new Date(b.createdAt).toLocaleString('default', { month: 'short' }) === label
        );

        monthSteps = allCompletedSteps.filter((s: any) =>
          s.completedAt && new Date(s.completedAt).toLocaleString('default', { month: 'short' }) === label
        );
      }

      return {
        month: label, // This will be "1-5", "Jan", etc.
        // Chart 1: Project Activity
        bookings: monthBookings.length,
        completedSteps: monthSteps.length,
        // Chart 2: Subsidy Trends
        subsidy: monthBookings.filter((b: any) => b.withSubsidy).length,
        nonSubsidy: monthBookings.filter((b: any) => !b.withSubsidy).length
      };
    });

    res.json({
      monthlyData
    });
  } catch (err) {
    console.error('[dashboard] project-stages failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// Admin: Analytics Data
app.get('/api/admin/analytics', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    // Parse filter query parameters
    const { timeframe, state, city } = req.query;

    // Build date filter based on timeframe
    let dateFilter: any = {};
    const now = new Date();

    if (timeframe === 'month') {
      // This month
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFilter = { gte: startOfMonth };
    } else if (timeframe === 'year') {
      // This year
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      dateFilter = { gte: startOfYear };
    } else if (timeframe === '30days') {
      // Last 30 days
      const last30Days = new Date(now);
      last30Days.setDate(last30Days.getDate() - 30);
      dateFilter = { gte: last30Days };
    } else if (timeframe === '3months') {
      // Last 3 months
      const last3Months = new Date(now);
      last3Months.setMonth(last3Months.getMonth() - 3);
      dateFilter = { gte: last3Months };
    } else if (timeframe === '6months') {
      // Last 6 months
      const last6Months = new Date(now);
      last6Months.setMonth(last6Months.getMonth() - 6);
      dateFilter = { gte: last6Months };
    } else if (timeframe === '12months') {
      // Last 12 months
      const last12Months = new Date(now);
      last12Months.setMonth(last12Months.getMonth() - 12);
      dateFilter = { gte: last12Months };
    }

    // Build where clause
    const whereClause: any = {};
    if (Object.keys(dateFilter).length > 0) {
      whereClause.createdAt = dateFilter;
    }
    if (state && typeof state === 'string') {
      whereClause.state = state;
    }
    if (city && typeof city === 'string') {
      whereClause.city = city;
    }

    // 1. Total Bookings with filters
    const totalBookings = await (prisma as any).booking.count({
      where: whereClause
    });

    // 2. Total Packages (Unique Project Types) & Distribution with filters
    const projectTypes = await (prisma as any).booking.groupBy({
      by: ['projectType'],
      _count: { projectType: true },
      where: whereClause
    });
    const totalPackages = projectTypes.length;

    // Format distribution for frontend
    const projectDistribution = projectTypes.map((p: any) => ({
      type: p.projectType,
      count: p._count.projectType
    }));

    console.log('[analytics] projectDistribution:', JSON.stringify(projectDistribution, null, 2));

    // 3. Total Revenue (Sum of totalPayable) with filters
    const revenueAgg = await (prisma as any).booking.aggregate({
      _sum: { totalPayable: true },
      where: whereClause
    });
    const totalRevenue = revenueAgg._sum.totalPayable || 0;

    // 4. Hot Destinations (Count of Unique Cities) with filters
    const allBookings = await (prisma as any).booking.findMany({
      where: whereClause,
      select: { city: true }
    });
    const uniqueCities = new Set(allBookings.map((b: any) => b.city).filter((city: any) => city));
    const uniqueCitiesCount = uniqueCities.size;

    // 5. Revenue Graph Data (Dynamic based on timeframe)
    const today = new Date();
    let graphData: any[] = [];
    let months: string[] = [];

    // Determine buckets/labels
    if (timeframe === 'month') {
      months = ['1-5', '6-10', '11-15', '16-20', '21-25', '26-End'];
    } else if (timeframe === 'year') {
      for (let i = 0; i <= today.getMonth(); i++) {
        const d = new Date(today.getFullYear(), i, 1);
        months.push(d.toLocaleString('default', { month: 'short' }));
      }
    } else if (timeframe === '30days') {
      // Last 30 Days - simplified to months involved
      const startOfPeriod = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      const startMonth = startOfPeriod.getMonth();
      const endMonth = today.getMonth();
      if (startMonth === endMonth) {
        months.push(today.toLocaleString('default', { month: 'short' }));
      } else {
        const d1 = new Date(startOfPeriod);
        months.push(d1.toLocaleString('default', { month: 'short' }));
        months.push(today.toLocaleString('default', { month: 'short' }));
      }
    } else if (timeframe === '3months') {
      // Last 3 Months
      for (let i = 2; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        months.push(d.toLocaleString('default', { month: 'short' }));
      }
    } else if (timeframe === '6months') {
      // Last 6 Months
      for (let i = 5; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        months.push(d.toLocaleString('default', { month: 'short' }));
      }
    } else if (timeframe === '12months') {
      // Last 12 Months
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        months.push(d.toLocaleString('default', { month: 'short' }));
      }
    } else {
      // Default 'all' -> Last 12 months for Revenue (or 6? User asked for 12)
      // Let's default to 12 months for Revenue Overview as per request "Last 12 months revenue trend"
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        months.push(d.toLocaleString('default', { month: 'short' }));
      }
    }

    // Fetch all bookings for the period to aggregate
    // We can reuse the dateFilter we built earlier, but we need to make sure it covers the whole graph range.
    // The dateFilter above was for the summary stats.
    // For the graph, we might want to ensure we have data for the buckets.
    // If timeframe is 'all', dateFilter might be empty (default).
    // Let's re-calculate start date for graph query if needed, or just use a wide enough query.
    // Actually, let's just query based on the buckets we defined.

    let graphStartDate = new Date();
    if (timeframe === 'month') {
      graphStartDate = new Date(today.getFullYear(), today.getMonth(), 1);
    } else if (timeframe === 'year') {
      graphStartDate = new Date(today.getFullYear(), 0, 1);
    } else if (timeframe === '30days') {
      graphStartDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (timeframe === '3months') {
      graphStartDate = new Date(today.getFullYear(), today.getMonth() - 2, 1);
    } else if (timeframe === '6months') {
      graphStartDate = new Date(today.getFullYear(), today.getMonth() - 5, 1);
    } else if (timeframe === '12months') {
      graphStartDate = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    } else {
      // Default to 12 months for 'all' or any other value
      graphStartDate = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    }

    const graphBookings = await (prisma as any).booking.findMany({
      where: { createdAt: { gte: graphStartDate } },
      select: { createdAt: true, totalPayable: true }
    });

    graphData = months.map(label => {
      let bucketRevenue = 0;

      if (timeframe === 'month') {
        const [startStr, endStr] = label.split('-');
        const startDay = parseInt(startStr);
        const endDay = endStr === 'End' ? 31 : parseInt(endStr);

        const bookingsInBucket = graphBookings.filter((b: any) => {
          const d = new Date(b.createdAt);
          const day = d.getDate();
          // Ensure it's the current month/year too
          return d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear() && day >= startDay && day <= endDay;
        });
        bucketRevenue = bookingsInBucket.reduce((sum: number, b: any) => sum + (b.totalPayable || 0), 0);
      } else {
        // Monthly aggregation
        const bookingsInMonth = graphBookings.filter((b: any) =>
          new Date(b.createdAt).toLocaleString('default', { month: 'short' }) === label
        );
        bucketRevenue = bookingsInMonth.reduce((sum: number, b: any) => sum + (b.totalPayable || 0), 0);
      }

      return {
        month: label,
        value: bucketRevenue
      };
    });

    res.json({
      cards: {
        bookings: totalBookings,
        packages: totalPackages,
        revenue: totalRevenue,
        hotDestinations: uniqueCitiesCount > 0 ? `${uniqueCitiesCount} Cities` : '0 Cities'
      },
      graph: graphData,
      projectDistribution // Include distribution data
    });

  } catch (err) {
    console.error('[analytics] data failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: Get all staff
app.get('/api/admin/staff', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    const staff = await (prisma as any).staff.findMany({
      orderBy: { createdAt: 'desc' }
    });

    // Map to frontend interface
    const mappedStaff = staff.map((s: any) => {
      const createdDate = s.createdAt ? new Date(s.createdAt) : new Date();
      const formattedDate = createdDate.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });

      return {
        id: s.id,
        name: s.name,
        role: 'Specialist', // Default role for now
        status: 'Active',   // Default status
        rating: 4.5,        // Default rating
        phone: s.phone || 'N/A',
        email: s.email,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(s.name)}&background=random`,
        joinedDate: formattedDate,
        address: 'Not provided',
        emergencyContact: 'Not provided'
      };
    });

    res.json(mappedStaff);
  } catch (err) {
    console.error('[staff] list failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin: Add new staff
app.post('/api/admin/staff', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if exists
    const existing = await (prisma as any).staff.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Staff with this email already exists' });

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const newStaff = await (prisma as any).staff.create({
      data: {
        name,
        email,
        phone: phone || null,
        passwordHash,
      }
    });

    res.status(201).json(newStaff);
  } catch (err: any) {
    console.error('[staff] create failed', err);
    // Return more specific error message
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'Staff with this email already exists' });
    }
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

// Admin: Delete staff
app.delete('/api/admin/staff/:id', protect, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.type !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    const { id } = req.params;
    await (prisma as any).staff.delete({ where: { id } });

    res.json({ message: 'Staff deleted successfully' });
  } catch (err: any) {
    console.error('[staff] delete failed', err);
    res.status(500).json({ error: 'Failed to delete staff' });
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4001;
app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`API server listening on http://0.0.0.0:${PORT}`);
  console.log(`Reachable at http://localhost:${PORT} and your LAN IP`);
  console.log('Server started with real-time dueDays calculation (no cron needed).');
});

// HTTPS Setup
const certPath = '/etc/letsencrypt/live/api.klordenergy.com/fullchain.pem';
const keyPath = '/etc/letsencrypt/live/api.klordenergy.com/privkey.pem';

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    https.createServer(options, app).listen(443, () => {
      console.log("HTTPS Server running at https://api.klordenergy.com");
    });
  } catch (err) {
    console.error("Failed to start HTTPS server:", err);
  }
} else {
  console.warn("HTTPS certificates not found at /etc/letsencrypt/live/api.klordenergy.com/. Skipping HTTPS server.");
}
