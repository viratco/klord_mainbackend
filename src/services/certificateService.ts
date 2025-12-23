import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export type CertificateData = {
  leadId: string;
  customerName: string;
  projectType: string;
  sizedKW: number;
  installDate: string; // formatted date string
  location: string;
  certificateId: string; // generated unique id for display
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function generateCertificatePDF(data: CertificateData): Promise<{ filePath: string; publicUrl: string; }> {
  // Lazy import puppeteer so server can start even if puppeteer isn't available yet
  const { default: puppeteer } = await import('puppeteer');
  // Load template (support running from dist/ or directly from src/)
  const distTemplatePath = path.join(__dirname, '..', 'templates', 'certificate.html');
  const srcTemplatePath = path.join(process.cwd(), 'src', 'templates', 'certificate.html');
  const templatePath = await fileExists(distTemplatePath) ? distTemplatePath : srcTemplatePath;
  let html: string;
  try {
    html = await fs.readFile(templatePath, 'utf-8');
  } catch (e) {
    console.error('[certificate] Failed to read template at', templatePath, e);
    throw new Error('template_read_failed');
  }

  // Resolve background image path and embed as data URL to ensure Puppeteer loads it reliably
  const distDefaultBg = path.join(__dirname, '..', 'templates', 'assets', 'certificate-bg.png');
  const srcDefaultBg = path.join(process.cwd(), 'src', 'templates', 'assets', 'certificate-bg.png');
  const defaultBg = (await fileExists(distDefaultBg)) ? distDefaultBg : srcDefaultBg;

  console.log('[certificate] DEBUG: distDefaultBg =', distDefaultBg, 'exists?', await fileExists(distDefaultBg));
  console.log('[certificate] DEBUG: srcDefaultBg =', srcDefaultBg, 'exists?', await fileExists(srcDefaultBg));
  console.log('[certificate] DEBUG: chosen defaultBg =', defaultBg);

  // FORCE: Always use default path, ignore env variable
  // const envBg = process.env.CERTIFICATE_BG_PATH && String(process.env.CERTIFICATE_BG_PATH).trim();
  // const bgPath = (envBg && envBg.length > 0) ? path.resolve(envBg) : defaultBg;
  const bgPath = defaultBg; // Always use default path

  console.log('[certificate] DEBUG: final bgPath =', bgPath);

  try {
    const imgBuf = await fs.readFile(bgPath);
    const ext = (path.extname(bgPath) || '.jpg').toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
    const dataUrl = `data:${mime};base64,${imgBuf.toString('base64')}`;
    html = replaceAll(html, '__BG_DATA_URL__', dataUrl);
    // Debug: note data URL size
    console.log(`[certificate] SUCCESS! Using background ${bgPath} (${mime}), dataUrl length=${dataUrl.length}`);
  } catch (err) {
    // Fallback: no background if read fails
    html = replaceAll(html, '__BG_DATA_URL__', '');
    console.error(`[certificate] FAILED to read background image at: ${bgPath}`, err);
  }

  // Replace placeholders
  html = replaceAll(html, '{{customerName}}', escapeHtml(data.customerName));
  html = replaceAll(html, '{{projectType}}', escapeHtml(data.projectType));
  html = replaceAll(html, '{{sizedKW}}', String(data.sizedKW));
  html = replaceAll(html, '{{installDate}}', escapeHtml(data.installDate));
  html = replaceAll(html, '{{location}}', escapeHtml(data.location));
  html = replaceAll(html, '{{certificateId}}', escapeHtml(data.certificateId));

  // Ensure uploads dir exists (relative to project root)
  const uploadsDir = path.join(process.cwd(), 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });

  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
  const outPath = path.join(uploadsDir, filename);
  let publicUrl = `/uploads/${filename}`;

  // Write debug HTML alongside the PDF for inspection
  const debugHtmlPath = path.join(uploadsDir, `${filename.replace(/\.pdf$/, '')}.html`);
  await fs.writeFile(debugHtmlPath, html, 'utf-8');
  console.log(`[certificate] Debug HTML written to ${debugHtmlPath}`);

  // Render with puppeteer
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' },
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }

  // If S3 is configured, upload the PDF and return the S3 URL
  const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
  const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || '';
  if (AWS_S3_BUCKET) {
    const s3 = new S3Client({ region: AWS_REGION });
    const key = `certificates/${filename}`;
    const buf = await (await import('fs')).promises.readFile(outPath);
    await s3.send(new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key,
      Body: buf,
      ContentType: 'application/pdf',
    }));
    // Remove local PDF after successful upload (keep debug HTML for inspection)
    await fs.unlink(outPath).catch(() => { });
    publicUrl = `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(key)}`;
  }

  return { filePath: outPath, publicUrl };
}

function replaceAll(input: string, search: string, replacement: string): string {
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return input.replace(new RegExp(escaped, 'g'), replacement);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p as any);
    return true;
  } catch {
    return false;
  }
}
