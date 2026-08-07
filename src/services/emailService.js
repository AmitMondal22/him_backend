import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send an alarm email notification.
 * @param {string[]} toEmails - Array of recipient emails
 * @param {string} deviceName - Device ID / name
 * @param {string|null} assetName - Asset name (e.g. Cold Room 1)
 * @param {string|null} vehicleNumber - Vehicle number (e.g. WB-19-AB-1234)
 * @param {string} alarmType - e.g. "high_temp", "thermocouple_open"
 * @param {string} message - Alarm message
 * @param {number|null} temperature - Current temperature reading
 * @param {string} severity - Alarm severity
 */
export async function sendAlarmEmail(toEmails, deviceName, assetName, vehicleNumber, alarmType, message, temperature, severity = "critical") {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[Email] SMTP not configured, skipping email send");
    return false;
  }

  const alarmLabel = (alarmType || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const severityColor = {
    critical: "#DC2626",
    high: "#EA580C",
    medium: "#D97706",
    low: "#2563EB",
    info: "#6B7280",
  }[severity] || "#DC2626";

  const tempDisplay = temperature != null ? `${Number(temperature).toFixed(1)}°C` : "N/A";
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const timestamp = `${dateStr} ${timeStr}`;
  const subjectLine = `⚠ ${alarmLabel} — ${deviceName}${assetName ? ` (${assetName})` : ''} — ${tempDisplay} [${timestamp}]`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;background:#F1F5F9;">
  <div style="max-width:560px;margin:24px auto;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    
    <!-- Header -->
    <div style="background:linear-gradient(135deg,${severityColor},${severityColor}CC);padding:28px 32px;text-align:center;">
      <div style="font-size:28px;margin-bottom:8px;">🚨</div>
      <h1 style="margin:0;color:#FFFFFF;font-size:20px;font-weight:700;letter-spacing:0.5px;">
        ${alarmLabel} Alert
      </h1>
      <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">
        Asset Insights — Real-time Telemetry Alert
      </p>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr>
          <td style="padding:10px 0;color:#64748B;font-weight:600;width:130px;vertical-align:top;">Device ID</td>
          <td style="padding:10px 0;color:#0F172A;font-weight:700;font-family:monospace;font-size:15px;">${deviceName}</td>
        </tr>
        ${assetName ? `
        <tr style="border-top:1px solid #F1F5F9;">
          <td style="padding:10px 0;color:#64748B;font-weight:600;vertical-align:top;">Asset</td>
          <td style="padding:10px 0;color:#0F172A;font-weight:700;font-size:14px;">${assetName}</td>
        </tr>` : ''}
        ${vehicleNumber ? `
        <tr style="border-top:1px solid #F1F5F9;">
          <td style="padding:10px 0;color:#64748B;font-weight:600;vertical-align:top;">Vehicle Number</td>
          <td style="padding:10px 0;color:#0F172A;font-weight:700;font-family:monospace;font-size:14px;">${vehicleNumber}</td>
        </tr>` : ''}
        <tr style="border-top:1px solid #F1F5F9;">
          <td style="padding:10px 0;color:#64748B;font-weight:600;vertical-align:top;">Severity</td>
          <td style="padding:10px 0;">
            <span style="display:inline-block;background:${severityColor};color:#FFF;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;text-transform:uppercase;">
              ${severity}
            </span>
          </td>
        </tr>
        <tr style="border-top:1px solid #F1F5F9;">
          <td style="padding:10px 0;color:#64748B;font-weight:600;vertical-align:top;">Temperature</td>
          <td style="padding:10px 0;color:#0F172A;font-weight:700;font-size:18px;">${tempDisplay}</td>
        </tr>
        <tr style="border-top:1px solid #F1F5F9;">
          <td style="padding:10px 0;color:#64748B;font-weight:600;vertical-align:top;">Message</td>
          <td style="padding:10px 0;color:#334155;">${message}</td>
        </tr>
        <tr style="border-top:1px solid #F1F5F9;">
          <td style="padding:10px 0;color:#64748B;font-weight:600;vertical-align:top;">Time (IST)</td>
          <td style="padding:10px 0;color:#334155;font-family:monospace;font-size:13px;">${timestamp}</td>
        </tr>
      </table>
    </div>

    <!-- Footer -->
    <div style="background:#F8FAFC;padding:16px 32px;text-align:center;border-top:1px solid #E2E8F0;">
      <p style="margin:0;color:#94A3B8;font-size:11px;">
        This is an automated live telemetry alert from Asset Insights.
      </p>
    </div>
  </div>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: toEmails.join(", "),
      subject: subjectLine,
      html,
    });
    console.log(`[Email] Alarm email sent to ${toEmails.join(", ")} for device ${deviceName}`);
    return true;
  } catch (err) {
    console.error("[Email] Failed to send alarm email:", err.message);
    return false;
  }
}

/**
 * Send a test email.
 */
export async function sendTestEmail(toEmails) {
  return sendAlarmEmail(
    toEmails,
    "TEST-DEVICE-001",
    "Cold Storage Unit 1",
    "WB-19-AB-1234",
    "high_temp",
    "This is a test alert from Asset Insights. If you received this, email notifications are working correctly.",
    25.5,
    "info"
  );
}
